// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/panels/ComposerDock — 创作坞（Stage-4 §4.2 集成任务非新设计）。
// （增补四起源码落位 plugins/builtin/compose-dock/——产物通道化。）
//
// 定位（canvas-space-model-notes.md §5 拍板 9）：带设置的输入条，常驻画布
// 元素，状态跟活跃目标走（自动选中 + 高亮已定），设置项贴输入条（模型/
// 权限/思考强度，展开收起），发送前顺手拨。空白画布无活跃会话时处于无主
// 待命态。
//
// 归属铁律：创作坞是视图不是容器，不拥有任何会话状态，只"指向"当前活跃
// 会话。草稿按会话隔离 = input-store 既有 sessionDrafts 机制（chat-session
// 切卷时 save/restore，本组件只读写 live inputText）；模型/思考 = compose-store
// 每会话偏好（写全局 settings + 热切换信号）；权限 = mode-store 工作区级
// 单一真相。
//
// 挂载：compose-dock 插件以 ctx.overlays 贡献行注册（slot:'composer'），
// 由 PaperPanel 渲染在底部；经 paper/overlay-context 取活跃会话与输入锁存。
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享
// 真实例，react 经构建期别名桥。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposeSessionPrefs, PermissionMode, ProviderSettings, StoredThinking, ThinkingMode } from './host';
import {
  agentSessionState,
  CommandRegistry,
  composerSubmitOnKey,
  getChatStore,
  getComposeStore,
  getModel,
  loadSettings,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  onSettingsSaved,
  PERMISSION_MODES,
  resolveNewSessionDefault,
  thinkingOptionsFor,
  typedJsonRpc,
  useCoreStore,
  useModeStore,
  usePaperDock,
  useShellStore,
  watchFileDragDrop,
} from './host';
import { ModelSelector } from './ModelSelector';

/** 把目录模型描述符映射到已配置 provider 名（跨 provider 搜索时联动切换）。 */
function providerNameForModel(desc: { vendor: string } | undefined, fallback: string): string {
  if (!desc?.vendor) return fallback;
  try {
    const providers = loadSettings().providers;
    const hit = providers.find((p) => p.name === desc.vendor);
    return hit ? hit.name : fallback;
  } catch {
    return fallback;
  }
}

/** B5（2026-08-27）：输入历史导航纯函数——↑ 回退 / ↓ 前进。
 *  idx = -1 = 不在历史浏览（live 草稿）；history 按旧→新排列（尾部 = 最近）。
 *  返回 entry.idx = 新的浏览下标，entry = null 表示该方向无路可走
 *  （最新端再 ↓ = 越出，调用方恢复草稿；空历史/最老端 ↑ 不动）。 */
export function navigateHistory(
  history: readonly string[],
  idx: number,
  dir: -1 | 1,
): { entry: { idx: number; text: string } | null } {
  if (history.length === 0) return { entry: null };
  const cur = idx >= 0 ? idx : history.length; // -1（live）视同「在最新一条之外」
  const next = cur + dir;
  if (next < 0 || next >= history.length) return { entry: null };
  return { entry: { idx: next, text: history[next] } };
}

/* ── 引（创作坞 v2 2026-08-31）：工作区文件模糊引用 ── */

/** list_directory 递归项（Rust DirEntry 序列化形状）。 */
interface YinDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: YinDirEntry[] | null;
}

/** 递归摊平目录树为文件清单（目录不入引——附卷的是文件）。 */
export function flattenDirEntries(entries: readonly YinDirEntry[]): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  const walk = (list: readonly YinDirEntry[]) => {
    for (const e of list ?? []) {
      if (!e.is_dir) out.push({ path: e.path, name: e.name });
      if (e.children?.length) walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/** 引 模糊匹配纯函数：查询词对路径做子序列命中；basename 命中加权靠前，
 *  路径越短越靠前。空查询 = 清单原序截前 limit（打开即见常拥文件）。 */
export function fuzzyMatchFiles(
  files: ReadonlyArray<{ path: string; name: string }>,
  query: string,
  limit = 14,
): Array<{ path: string; name: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const hits: Array<{ path: string; name: string; score: number }> = [];
  for (const f of files) {
    const path = f.path.toLowerCase();
    const name = f.name.toLowerCase();
    if (!isSubsequence(q, path)) continue;
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
    hits.push({ ...f, score });
  }
  hits.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return hits.slice(0, limit);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** 律（快捷键总览）行表——键在前、义在后。 */
const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Enter', '发送'],
  ['Shift+Enter', '换行'],
  ['↑ / ↓', '输入历史'],
  ['/ 或 翰', '命令面板'],
  ['引 · 夹', '附文件入卷'],
  ['拖文件到坞', '界栏松手入卷'],
  ['Alt+↑↓', '块间移动'],
  ['Alt+←→', '卷间移动'],
  ['Home', '画布回原点'],
  ['拖文类签', '移出钉住'],
  ['拖流区边缘', '移动流区'],
  ['拖流区四角', '调整宽度'],
  ['拖选区', '抽纸条'],
];

/** 历史导航眉批：一次性提示旗标（localStorage，毒化容忍——读写全包 try）。 */
const HIST_HINT_KEY = 'lantai.hint.historySeen';

/** rework P2-2：思考档位纯中文展示词（创作坞内不再中英混排）。 */
const THINKING_ZH: Record<string, string> = {
  '': '自动',
  off: '关闭',
  minimal: '最浅',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '较深',
  max: '极限',
};

function thinkingZhLabel(value: string | undefined): string {
  if (value == null || value === '') return THINKING_ZH[''] ?? '自动';
  return THINKING_ZH[value] ?? value;
}

/** DSH thinkingDesc 语义（中文）——思考档位下拉选项的说明行。 */
const THINKING_DESC: Record<string, string> = {
  '': '模型自定推理强度',
  off: '不推理，直接作答',
  minimal: '最浅推理，响应最快',
  low: '轻度推理',
  medium: '均衡推理',
  high: '深入推理',
  xhigh: '较深推理',
  max: '极限推理',
};

/** 无目录声明模型的思考控件安全兜底（DSH 语义：思考控制常驻）：只给「自动 /
 *  关闭」两个协议安全档——assertEffortDeclared 对 ''/off 不拦，openai 关闭未声明
 *  时降级不发参数、anthropic 不发 thinking 块，都不编造命名档位（P14 不破）。 */
const THINKING_SAFE_FALLBACK: readonly { value: ThinkingMode; label: string }[] = [
  { value: '', label: '自动（模型自定）' },
  { value: 'off', label: '关闭' },
];

export const ComposerDock = memo(function ComposerDock() {
  const core = useCoreStore((s) => s.core);
  const { activeSessionId, setInputLocked } = usePaperDock();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /* ── 创作坞 v2（2026-08-31）本地态：翰（命令面板）/ 律（快捷键）/ 引（文件）
   *    / 拖放入卷界栏 / 历史眉批。── */
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [yinOpen, setYinOpen] = useState(false);
  const [yinQuery, setYinQuery] = useState('');
  const [yinFiles, setYinFiles] = useState<Array<{ path: string; name: string }>>([]);
  const [yinIdx, setYinIdx] = useState(0);
  const yinInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [histHint, setHistHint] = useState(false);

  /* ── 会话面：sess store 订阅（切卷/改名/token 变化自动重渲）── */
  const [sessions, setSessions] = useState<Array<{ id: number; label: string }>>([]);
  const [sessionTokens, setSessionTokens] = useState<Record<number, number>>({});
  useEffect(() => {
    if (!core) {
      setSessions([]);
      setSessionTokens({});
      return;
    }
    const sess = getChatStore(core.panelId).sess;
    const sync = () => {
      setSessions(sess.getState().sessions);
      setSessionTokens(sess.getState().sessionTokens);
    };
    sync();
    return sess.subscribe(sync);
  }, [core]);
  const activeSession =
    activeSessionId != null ? (sessions.find((s) => String(s.id) === activeSessionId) ?? null) : null;
  const activeSidNum = activeSessionId != null ? Number(activeSessionId) : null;
  const tokenCount = activeSidNum != null ? (sessionTokens[activeSidNum] ?? 0) : 0;

  /* ── 草稿（input-store live = 当前活跃会话的输入框；切卷由 chat-session
   *    负责 save/restore sessionDrafts，本组件只读写 live 槽）── */
  const [inputText, setInputTextState] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<Array<{ path: string; name: string; size: number }>>([]);
  useEffect(() => {
    if (!core) {
      setInputTextState('');
      setAttachedFiles([]);
      return;
    }
    const input = getChatStore(core.panelId).input;
    const sync = () => {
      setInputTextState(input.getState().inputText);
      setAttachedFiles(input.getState().attachedFiles);
    };
    sync();
    return input.subscribe(sync);
  }, [core]);

  const setInputText = useCallback(
    (text: string) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().setInputText(text);
    },
    [core],
  );

  /* ── B6（2026-08-27）：注册输入框命令式接口——接活 chat-core 的
   *    _composer 死链（此前 registerComposer 全工程无调用方，9 处
   *    focus/selectEnd 全部空转，含斜杠 fill 后焦点回归、exec 停止后
   *    焦点回归路径）。卸载时注销。 ── */
  useEffect(() => {
    if (!core) return;
    core.registerComposer({
      focus: () => composerRef.current?.focus(),
      selectEnd: () => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      },
    });
    return () => core.registerComposer({ focus: () => {}, selectEnd: () => {} });
  }, [core]);

  /* ── C2（2026-08-27）：切卷清理本地态——localNotice 与思考展开面板
   *    不跨会话残留（A 卷的提示/展开状态带到 B 卷是认知噪音）。
   *    v2 增补：翰/律/引面板同属本地态，一并清。 ── */
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId 是刻意的「切卷触发器」——正是要响应它变化清本地态
  useEffect(() => {
    setLocalNotice(null);
    setSettingsOpen(false);
    setMenuOpen(false);
    setHelpOpen(false);
    setYinOpen(false);
    setHistHint(false);
  }, [activeSessionId]);

  const autoGrow = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 144) + 'px';
  }, []);

  useEffect(() => {
    void inputText;
    autoGrow();
  }, [inputText, autoGrow]);

  /* ── 运行态（停止按钮 + 后台卷运行指示，B7 运行态感知 2026-08-27）── */
  const [running, setRunning] = useState(false);
  /** 后台运行中的会话（不含活跃卷）：显示「后台 N 卷运行中 + 停止」。 */
  const [bgRunning, setBgRunning] = useState<Array<{ id: number; label: string }>>([]);
  useEffect(() => {
    if (!core || activeSidNum == null) {
      setRunning(false);
      setBgRunning([]);
      return;
    }
    const syncAll = () => {
      let activeRun = false;
      const bg: Array<{ id: number; label: string }> = [];
      const sess = getChatStore(core.panelId).sess.getState().sessions;
      for (const s of sess) {
        const exec = agentSessionState.getExec(core.panelId, s.id);
        if (!exec?.isRunning) continue;
        if (s.id === activeSidNum) activeRun = true;
        else bg.push({ id: s.id, label: s.label || `案卷 ${s.id}` });
      }
      setRunning(activeRun);
      setBgRunning(bg);
    };
    syncAll();
    // 订阅全部会话的 exec（不只活跃卷）——任何一卷起停都重算运行态
    const sess = getChatStore(core.panelId).sess.getState().sessions;
    const unsubs = sess.map((s) => agentSessionState.getExec(core.panelId, s.id)?.onChange(syncAll) ?? null);
    return () => {
      for (const u of unsubs) u?.();
    };
  }, [core, activeSidNum]);

  /* ── 会话生效配置（方案甲：覆盖 ?? 全局默认，实时解析）── */
  const [prefs, setPrefs] = useState<ComposeSessionPrefs | undefined>(undefined);
  useEffect(() => {
    if (!core || activeSessionId == null) {
      setPrefs(undefined);
      return;
    }
    const compose = getComposeStore(core.panelId);
    const sync = () => setPrefs(compose.getState().resolveEffective(activeSessionId));
    sync();
    return compose.subscribe(sync);
  }, [core, activeSessionId]);

  // C4（2026-08-27）：显示读 settings 走「初值 + onSettingsSaved 订阅」，
  // 不再每渲染全量 loadSettings()（打字热路径上的 localStorage JSON.parse）
  const [settingsTick, setSettingsTick] = useState(0);
  useEffect(() => onSettingsSaved(() => setSettingsTick((n) => n + 1)), []);
  // 开口即开卷（2026-08-31）：无主态显示/操作「新卷出生默认」（全局活跃行）；
  // 有活跃卷时 prefs（resolveEffective）已含全局回落（覆盖 ?? 全局）。
  // tick 驱动重读——无主态拨模型/思考走 settings-saved → tick 变 → 重算。
  // biome-ignore lint/correctness/useExhaustiveDependencies: settingsTick 是刻意的重读触发器（非响应值），与上方 settings memo 同款手法
  const newSessionDefault = useMemo(() => resolveNewSessionDefault(), [settingsTick]);
  const providerName = prefs?.providerName ?? newSessionDefault.providerName;
  const model = prefs?.model ?? newSessionDefault.model;
  const settingsVersion = settingsTick + providerName.length; // 触发器合成：保存代数 + 覆盖换向
  // biome-ignore lint/correctness/useExhaustiveDependencies: settingsVersion 是刻意的重读触发器（保存事件/覆盖切换 provider），非响应值
  const settings = useMemo(() => {
    try {
      return loadSettings();
    } catch {
      return null;
    }
  }, [settingsVersion]);
  const provider: ProviderSettings | undefined = settings?.providers.find((p) => p.name === providerName);
  const providerKind = provider?.kind ?? 'openai';
  const modelDesc = useMemo(() => getModel(model), [model]);
  // 墨量线（v2 2026-08-31）：分母 = 目录声明窗口（未知 0 = 不显）；分子 = 本卷
  // 惰性 token 计数（sess store）。裸数字徽标退役，读数收进线 hover。
  const inkWindow = modelDesc && modelDesc.contextWindow > 0 ? modelDesc.contextWindow : 0;
  const inkRatio = inkWindow > 0 && tokenCount > 0 ? Math.min(1, tokenCount / inkWindow) : 0;
  const thinkingOptions = useMemo(() => {
    const declared = thinkingOptionsFor(modelDesc);
    // P14：有目录声明用声明档位表；无声明也给「自动/关闭」协议安全兜底——
    // 思考按钮常驻（DSH 语义），不编造命名档位（''/off 在 assertEffortDeclared
    // 不拦、协议层可安全表达，P14「不编造参数」不破）。
    return declared.length > 0 ? declared : THINKING_SAFE_FALLBACK;
  }, [modelDesc]);
  // 开口即开卷（2026-08-31）：无主态思考档位跟随新卷出生默认
  const currentThinking = prefs?.thinking ?? newSessionDefault.thinking;

  /* ── 权限（mode-store 工作区级单一真相）── */
  const permissionMode = useModeStore((s) => s.permissionMode);
  const pendingYolo = useModeStore((s) => s.pendingYolo);
  const setPermissionMode = useModeStore((s) => s.setPermissionMode);
  const setPendingYolo = useModeStore((s) => s.setPendingYolo);

  const selectMode = useCallback(
    (mode: PermissionMode) => {
      if (mode === 'yolo' && permissionMode !== 'yolo') {
        setPendingYolo(true);
        return;
      }
      setPendingYolo(false);
      setPermissionMode(mode);
    },
    [permissionMode, setPendingYolo, setPermissionMode],
  );
  // rework P0-1：卸载（含关窗）时清掉全放确认态，避免残留 DOM 参与销毁时序
  useEffect(() => () => setPendingYolo(false), [setPendingYolo]);

  /* ── 斜杠命令（沿用旧 composer 逻辑）＋ 翰 入口（v2 2026-08-31）：
   *    命令面板不再只靠盲打 / 发现——设置行「翰」按钮开同一层面板
   *    （空查询 = 全量命令）。打字优先：手输即散翰面板，/ 触发词接管过滤。 ── */
  const slashQuery = useMemo(() => {
    const v = inputText;
    if (!v) return null;
    const last = v.lastIndexOf('/');
    if (last < 0) return null;
    if (last > 0 && v[last - 1] !== ' ' && v[last - 1] !== '\n') return null;
    return v.slice(last + 1);
  }, [inputText]);
  /** 生效查询：/ 触发词优先；无触发词且翰面板开着 = 空查询（全量）。 */
  const effectiveSlashQuery = slashQuery ?? (menuOpen ? '' : null);
  const slashCommands = useMemo(() => {
    if (effectiveSlashQuery === null) return [];
    const q = effectiveSlashQuery.toLowerCase();
    const all = CommandRegistry.instance.getAll();
    if (q === '') return all;
    return all.filter((c) => c.shortcut.toLowerCase().includes(q) || c.label.toLowerCase().includes(q));
  }, [effectiveSlashQuery]);
  /* ── C3（2026-08-27）：斜杠面板键盘导航（↑↓ 选、Enter 执行、Esc 关）。 ── */
  const [slashIdx, setSlashIdx] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: effectiveSlashQuery 是刻意的「查询词变化」触发器——正是要响应它复位高亮（含翰面板开合）
  useEffect(() => {
    setSlashIdx(0); // 查询词变化 → 高亮复位首项
  }, [effectiveSlashQuery]);
  const slashActive = slashCommands.length > 0;

  /* ── 附件 ── */
  const onAttach = useCallback(() => {
    void core?.openFilePicker();
  }, [core]);
  const onRemoveAttached = useCallback(
    (idx: number) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().removeAttachedFile(idx);
    },
    [core],
  );

  /* ── 附文件入卷共用底座（引 / 拖放，v2 2026-08-31）：路径 → input-store。
   *    size 恒 0 不显示——openFilePicker 同语义（C10：拿不到真大小就不伪造）。 ── */
  const attachPaths = useCallback(
    (paths: readonly string[]) => {
      if (!core || paths.length === 0) return;
      const input = getChatStore(core.panelId).input.getState();
      for (const p of paths) {
        input.addAttachedFile({ path: p, name: p.split(/[\\/]/).pop() || p, size: 0 });
      }
    },
    [core],
  );

  /* ── 引：工作区文件模糊引用（v2 2026-08-31）。
   *    数据源 = list_directory 递归（Rust 护栏：深 3 层 / 2000 项 / ignore
   *    过滤）；打开拉全量缓存在组件态，输入即子序列过滤。 ── */
  const loadYinFiles = useCallback(async () => {
    const pp = useShellStore.getState().projectPath;
    if (!pp) return;
    try {
      const entries = await typedJsonRpc<YinDirEntry[]>('list_directory', { path: pp, filter_ignored: true });
      setYinFiles(Array.isArray(entries) ? flattenDirEntries(entries) : []);
    } catch {
      setYinFiles([]);
    }
  }, []);
  // 面板开合副作用：开 = 清查询 + 首开拉清单 + 聚焦输入框。
  // 依赖含 yinFiles.length：清单从空变非空会重跑本 effect，但此时
  // length===0 为假不再拉取——无环路；失败保持空 → 也不重跑（无死循环）。
  useEffect(() => {
    if (!yinOpen) return;
    setYinQuery('');
    setYinIdx(0);
    setMenuOpen(false);
    setHelpOpen(false);
    if (yinFiles.length === 0) void loadYinFiles();
    yinInputRef.current?.focus();
  }, [yinOpen, loadYinFiles, yinFiles.length]);
  const yinMatches = useMemo(() => fuzzyMatchFiles(yinFiles, yinQuery), [yinFiles, yinQuery]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: yinQuery 是刻意的「查询词变化」触发器——正是要响应它复位高亮
  useEffect(() => {
    setYinIdx(0);
  }, [yinQuery]);
  const onYinAttach = useCallback(
    (f: { path: string; name: string }) => {
      attachPaths([f.path]);
      setYinOpen(false);
      composerRef.current?.focus();
    },
    [attachPaths],
  );
  const onYinKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        setYinOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setYinIdx((i) => Math.min(i + 1, Math.max(0, yinMatches.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setYinIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = yinMatches[yinIdx];
        if (hit) onYinAttach(hit);
      }
    },
    [yinMatches, yinIdx, onYinAttach],
  );

  /* ── 历史眉批（v2 2026-08-31）：一次性提示——有历史且从未提示过时，
   *    首次聚焦浮现 6s（localStorage 旗标，毒化容忍）。提示长在功能
   *    所在处，不再常驻占位符。 ── */
  const onComposerFocus = useCallback(() => {
    setInputLocked(true);
    if (!core) return;
    let seen = true;
    try {
      seen = localStorage.getItem(HIST_HINT_KEY) === '1';
    } catch {
      seen = true; // 存储不可用 = 不提示（宁缺勿噪）
    }
    if (seen) return;
    const input = getChatStore(core.panelId).input.getState();
    if (input.inputHistory.length === 0) return;
    try {
      localStorage.setItem(HIST_HINT_KEY, '1');
    } catch {
      // 写不进也照提示一次——本次会话内不再重复（histHint 态兜底）
    }
    setHistHint(true);
    window.setTimeout(() => setHistHint(false), 6000);
  }, [core, setInputLocked]);

  /* ── 发送 ── */
  const onSend = useCallback(async () => {
    if (!core) return;
    // ⚠ 读 input-store 实时值（真源），不读可能滞后的本地 inputText——
    // 快速连续输入后立刻回车时本地 state 可能缺最后一个字符；
    // 也不许拿旧值回写 store（否则覆盖刚输入的字符 = 丢字）。
    const live = getChatStore(core.panelId).input.getState();
    const t = live.inputText.trim();
    if (!t) return;
    const sessSt = getChatStore(core.panelId).sess.getState();
    if (sessSt.activeIdx < 0 || !sessSt.sessions[sessSt.activeIdx]) {
      // 开口即开卷（2026-08-31 拍板）：无活跃卷 → 先建卷再把这句发出去。
      // 创作坞不再是无主死端——「落笔」本身就是最显式的出生动作。
      // createNewSession 内部 restoreSessionDraft 会清 live 输入——正文先存后还。
      await core.createNewSession();
      const after = getChatStore(core.panelId).sess.getState();
      if (after.activeIdx < 0 || !after.sessions[after.activeIdx]) {
        // 建卷失败（未绑定目录等）——createNewSession 已弹 warn，这里兜底可见
        setLocalNotice('当前没有活跃会话——请先在首页新建或指定工作区。');
        return;
      }
      getChatStore(core.panelId).input.getState().setInputText(t);
    }
    setLocalNotice(null);
    await core.sendMessage();
  }, [core]);

  /* ── 热切换：模型 / 思考 ── */
  const onModelChange = useCallback(
    (modelId: string, desc?: { vendor: string }) => {
      if (!core) return;
      const targetProvider = providerNameForModel(desc, providerName);
      const compose = getComposeStore(core.panelId).getState();
      // 开口即开卷（2026-08-31）：无主态拨「新卷出生默认」；有卷写会话覆盖
      if (activeSessionId == null) {
        compose.setGlobalModel(targetProvider, modelId);
        return;
      }
      compose.setModel(activeSessionId, targetProvider, modelId);
    },
    [core, activeSessionId, providerName],
  );
  const onThinkingChange = useCallback(
    (value: string) => {
      if (!core) return;
      const next = (value === '' ? '' : value) as StoredThinking;
      const compose = getComposeStore(core.panelId).getState();
      if (activeSessionId == null) {
        compose.setGlobalThinking(next);
        return;
      }
      compose.setThinking(activeSessionId, next);
    },
    [core, activeSessionId],
  );

  /* ── 输入锁存：聚焦/输入中关闭自动切换（Stage-4 §4.1）。
   *    onComposerFocus 主体上移至「历史眉批」节（锁存 + 一次性眉批同一入口）。 ── */
  const onComposerBlur = useCallback(() => setInputLocked(false), [setInputLocked]);

  /* ── 实测高上报（--composer-h-live）：composer 是两段式（设置行+输入行，
   *  textarea 还会自动长高），静态 token --composer-h: 66px 早已 stale
   *  （实高 ~114px）——fixed 侧栏/书脊/小地图/牒卡宿主按 token 贴底会压住
   *  设置行。此处观察根元素实测高写入全局 var，卸载时撤除（消费面以
   *  var(--composer-h-live, var(--composer-h)) 回退静态 token）。 ── */
  const dockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = dockRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return; // jsdom 无 RO——单测环境跳过上报
    const root = document.documentElement;
    const report = () =>
      root.style.setProperty('--composer-h-live', `${Math.round(el.getBoundingClientRect().height)}px`);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--composer-h-live');
    };
  }, []);

  /* ── 拖文件入卷（v2 2026-08-31）：Tauri onDragDropEvent 原生通道——
   *    T2 WebView dragDropEnabled 默认接管，HTML5 drop 永不触发（C10 尸检）。
   *    界栏 = 拖拽悬停坞体时高亮；松手命中坞体才入卷（落画布其它处不抢）。
   *    mock 模式（浏览器 dev / vitest）watch 内部 no-op。 ── */
  useEffect(() => {
    if (!core) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void watchFileDragDrop((e) => {
      if (!alive) return;
      if (e.phase === 'leave') {
        setDragOver(false);
        return;
      }
      const rect = dockRef.current?.getBoundingClientRect();
      const inside = rect ? e.x >= rect.left && e.x <= rect.right && e.y >= rect.top && e.y <= rect.bottom : false;
      if (e.phase === 'drop') {
        setDragOver(false);
        if (inside) attachPaths(e.paths);
        return;
      }
      setDragOver(inside);
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u?.();
      })
      .catch((e) => console.warn('[composer] 拖放入卷监听注册失败（mock/早期窗口常态）:', e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [core, attachPaths]);

  /* ── 浮层互斥（2026-09-01 审计）：思考/翰/律/引 四浮层同屏只开一个——
   *    此前各 onClick 只关自己认识的兄弟面板，思考菜单与引面板可叠开（截图实证）。 ── */
  const toggleLayer = useCallback((layer: 'thinking' | 'menu' | 'help' | 'yin') => {
    setSettingsOpen(layer === 'thinking' ? (v) => !v : false);
    setMenuOpen(layer === 'menu' ? (v) => !v : false);
    setHelpOpen(layer === 'help' ? (v) => !v : false);
    setYinOpen(layer === 'yin' ? (v) => !v : false);
  }, []);

  return (
    <div className={`pp-composer${dragOver ? ' pp-droptarget' : ''}`} ref={dockRef}>
      {/* 设置行：常驻一行只放高频件（模型 + 权限）；思考等进展开（stage-4 §8）。
          开口即开卷（2026-08-31）：控件不再随活跃卷隐藏——无主态操作「新卷出生
          默认」，「发送前顺手拨」在自己的核心场景（开卷前拨好）恒可用。 */}
      <div className="pp-composer-settings">
        <span
          className="pp-composer-target"
          title={activeSession ? `案卷 ${activeSession.id}` : '无活跃卷——落笔即另起一卷'}
        >
          {activeSession ? activeSession.label || `案卷 ${activeSession.id}` : '新卷'}
        </span>
        {/* DSH 移植（2026-08-26）：运行中守卫——本卷在跑时模型下拉打开被拦
            （DSH onAttemptOpen 语义：流式中不允许切模型），localNotice 提示 */}
        <ModelSelector
          value={model}
          onChange={onModelChange}
          providerName={providerName}
          kind={providerKind}
          compact
          isStreaming={running}
          onBlocked={() => setLocalNotice('Agent 正在运行——本回合结束后才能切换模型。')}
        />
        {/* rework P2-3：权限三档分段控件（不随 DSH 迁移——权限是工作区级单一真相） */}
        <fieldset className="pp-mode-seg" aria-label="权限模式">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`pp-mode-opt${permissionMode === m ? ' selected' : ''}`}
              title={MODE_DESCRIPTIONS[m]}
              aria-pressed={permissionMode === m}
              onClick={() => selectMode(m)}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </fieldset>
        {/* DSH 移植（2026-08-26）：思考档位 = 图标 pill 下拉（brain 图标，
                off 划横线；选项带档位说明），不再是「思考·档」文本按钮 + 展开分段行 */}
        {thinkingOptions.length > 0 && (
          <div className="pp-thinking-sel">
            <button
              type="button"
              className={`pp-thinking-pill${(currentThinking ?? '') === 'off' ? ' off' : ''}${settingsOpen ? ' open' : ''}`}
              title={`思考档位：${thinkingZhLabel(currentThinking)}`}
              aria-haspopup="listbox"
              aria-expanded={settingsOpen}
              onClick={() => toggleLayer('thinking')}
            >
              <svg
                className="pp-thinking-icon"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 18h6" />
                <path d="M10 22h4" />
                <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" />
                {(currentThinking ?? '') === 'off' && <line x1="4" y1="4" x2="20" y2="20" strokeWidth="1.5" />}
              </svg>
              <span className="pp-thinking-pill-label">思考 · {thinkingZhLabel(currentThinking)}</span>
              <span className="pp-thinking-pill-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {settingsOpen && (
              <div className="pp-thinking-menu" role="listbox" aria-label="思考档位">
                {thinkingOptions.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={(currentThinking ?? '') === o.value}
                    className={`pp-thinking-opt${(currentThinking ?? '') === o.value ? ' selected' : ''}`}
                    onClick={() => {
                      onThinkingChange(o.value);
                      setSettingsOpen(false);
                    }}
                  >
                    <span className="pp-thinking-opt-label">{thinkingZhLabel(o.value)}</span>
                    <span className="pp-thinking-opt-desc">{THINKING_DESC[o.value] ?? ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="pp-composer-settings-spacer" />
        {/* v2（2026-08-31）：翰（命令面板入口——/ 的可发现性）+ 律（快捷键总览）。
            渐进披露：占位符只留一句，键位收进律册在此翻。 */}
        <div className="pp-dock-tools">
          <button
            type="button"
            className={`pp-tool-btn${menuOpen ? ' open' : ''}`}
            title="翰——案卷命令（等价输入 /）"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            onClick={() => toggleLayer('menu')}
          >
            翰
          </button>
          <button
            type="button"
            className={`pp-tool-btn${helpOpen ? ' open' : ''}`}
            title="律——快捷键总览"
            aria-expanded={helpOpen}
            onClick={() => toggleLayer('help')}
          >
            律
          </button>
          {helpOpen && (
            <div className="pp-help-sheet" role="dialog" aria-label="快捷键总览">
              <div className="pp-help-head">律 · 快捷键</div>
              {HELP_ROWS.map(([key, desc]) => (
                <div key={key} className="pp-help-row">
                  <span className="pp-help-key">{key}</span>
                  <span className="pp-help-desc">{desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* B7（2026-08-27）：后台卷运行指示 + 停止——此前任一后台会话在跑就
            全局阻断发送（chat-core），但创作坞无任何指示、无从停止。 */}
        {bgRunning.length > 0 && (
          <span className="pp-bg-running" title={bgRunning.map((s) => s.label).join('、')}>
            ⟳ 后台 {bgRunning.length} 卷运行中
            <button
              type="button"
              className="pp-bg-stop"
              title={`停止后台卷：${bgRunning.map((s) => s.label).join('、')}`}
              onClick={() => {
                if (!core) return;
                for (const s of bgRunning) agentSessionState.removeExec(core.panelId, s.id);
              }}
            >
              停止
            </button>
          </span>
        )}
      </div>

      {localNotice && (
        <div className="pp-local-notice">
          {localNotice}
          <button type="button" onClick={() => setLocalNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {/* 历史眉批（一次性，6s 自散）：提示长在功能所在处，不常驻占位符 */}
      {histHint && <div className="pp-eyebrow-hint">↑ 可回取上文 · ↓ 返回草稿</div>}

      {/* 输入行（原 composer 主体） */}
      <div className="pp-composer-row">
        {slashCommands.length > 0 && (
          <div className="pp-slash">
            {slashCommands.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`pp-slash-item${i === slashIdx ? ' active' : ''}`}
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => {
                  setMenuOpen(false);
                  core?.executeCommand(c);
                }}
              >
                <span className="pp-slash-shortcut">{c.shortcut}</span>
                <span className="pp-slash-label">{c.label}</span>
              </button>
            ))}
          </div>
        )}
        {/* 引（v2）：工作区文件模糊引用——面板 = 查询输入 + 命中清单 */}
        {yinOpen && (
          <div className="pp-yin-panel">
            <input
              ref={yinInputRef}
              type="text"
              value={yinQuery}
              placeholder="引……（文件名或路径片段 · Enter 入卷 · Esc 散）"
              aria-label="引：检索工作区文件"
              onChange={(e) => setYinQuery(e.target.value)}
              onKeyDown={onYinKeyDown}
            />
            <div className="pp-yin-list" role="listbox" aria-label="工作区文件">
              {yinMatches.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  role="option"
                  aria-selected={i === yinIdx}
                  className={`pp-yin-item${i === yinIdx ? ' active' : ''}`}
                  onMouseEnter={() => setYinIdx(i)}
                  onClick={() => onYinAttach(f)}
                >
                  <span className="pp-yin-name">{f.name}</span>
                  <span className="pp-yin-path">{f.path}</span>
                </button>
              ))}
              {yinMatches.length === 0 && (
                <div className="pp-yin-empty">{yinFiles.length === 0 ? '卷宗目录读取中…' : '无匹配文件'}</div>
              )}
            </div>
          </div>
        )}
        <button
          type="button"
          className={`pp-attach pp-yin-btn${yinOpen ? ' open' : ''}`}
          title="引——引用工作区文件入卷"
          aria-label="引：引用文件"
          onClick={() => toggleLayer('yin')}
        >
          引
        </button>
        <button
          type="button"
          className="pp-attach"
          title="拾遗——附文件入卷"
          aria-label="拾遗：附加文件"
          onClick={onAttach}
        >
          夹
        </button>
        {attachedFiles.length > 0 && (
          <div className="pp-attach-list">
            {attachedFiles.map((f, i) => (
              <button
                key={f.path}
                type="button"
                className="pp-attach-chip"
                title={`${f.path}（点击移除）`}
                onClick={() => onRemoveAttached(i)}
              >
                {f.name} ✕
              </button>
            ))}
            {attachedFiles.length > 3 && <span className="pp-attach-count">共 {attachedFiles.length} 件</span>}
          </div>
        )}
        <textarea
          ref={composerRef}
          rows={1}
          value={inputText}
          placeholder={activeSession ? '拟文…' : '落笔即另起一卷…'}
          onChange={(e) => {
            setInputText(e.target.value);
            setMenuOpen(false); // 手输接管：翰面板散（/ 触发词自然接管过滤）
            // 手输 = 退出历史浏览（浏览下标复位；草稿槽保留到下次进入时覆写）
            if (core) {
              const input = getChatStore(core.panelId).input.getState();
              if (input.inputHistoryIdx !== -1) input.setInputHistoryIdx(-1);
            }
          }}
          onFocus={onComposerFocus}
          onBlur={onComposerBlur}
          onKeyDown={(e) => {
            /* ── C3：斜杠面板键盘导航优先（↑↓ 选 / Enter 执行 / Esc 关） ── */
            if (slashActive && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSlashIdx((i) => Math.min(i + 1, slashCommands.length - 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashIdx((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                const cmd = slashCommands[slashIdx];
                setMenuOpen(false);
                core?.executeCommand(cmd);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                if (slashQuery !== null) {
                  // / 触发词开着 = 关面板保留查询词（去行首斜杠）
                  const live = core ? getChatStore(core.panelId).input.getState() : null;
                  if (live) {
                    const v = live.inputText;
                    const last = v.lastIndexOf('/');
                    if (last >= 0) setInputText(v.slice(0, last) + v.slice(last + 1));
                  }
                } else {
                  setMenuOpen(false); // 翰面板（无触发词）= 直接散
                }
                return;
              }
            }
            if (composerSubmitOnKey(e.key, e.nativeEvent.isComposing)) {
              e.preventDefault();
              onSend();
              return;
            }
            if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
              const el = e.currentTarget;
              const atFirstLine = el.selectionStart === 0 || !el.value.includes('\n');
              if (atFirstLine && core) {
                const input = getChatStore(core.panelId).input.getState();
                const { entry } = navigateHistory(input.inputHistory, input.inputHistoryIdx, -1);
                if (entry !== null) {
                  e.preventDefault();
                  // 进入历史时保存当前草稿（draftText 槽），越过后恢复
                  if (input.inputHistoryIdx === -1) input.setDraftText(input.inputText);
                  input.setInputHistoryIdx(entry.idx);
                  setInputText(entry.text);
                  requestAnimationFrame(() => el.setSelectionRange(entry.text.length, entry.text.length));
                }
              }
            } else if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
              const el = e.currentTarget;
              // 多行输入中间行按 ↓ 是移光标——只有已在历史浏览（idx≥0）时才消费
              const input = core ? getChatStore(core.panelId).input.getState() : null;
              if (input && input.inputHistoryIdx >= 0) {
                e.preventDefault();
                const { entry } = navigateHistory(input.inputHistory, input.inputHistoryIdx, +1);
                if (entry !== null) {
                  input.setInputHistoryIdx(entry.idx);
                  setInputText(entry.text);
                  requestAnimationFrame(() => el.setSelectionRange(entry.text.length, entry.text.length));
                } else {
                  // 越过最新一条 → 退出历史浏览，恢复进入时的草稿
                  input.setInputHistoryIdx(-1);
                  setInputText(input.draftText);
                  requestAnimationFrame(() => el.setSelectionRange(input.draftText.length, input.draftText.length));
                }
              }
            }
          }}
        />
        {running && (
          <button
            type="button"
            className="pp-stop"
            title="停止当前回合（级联子 Agent）"
            aria-label="停止"
            onClick={() => core?.abort()}
          >
            停
          </button>
        )}
        <button type="button" className="pp-send" onClick={onSend}>
          拟文
        </button>
      </div>

      {/* 墨量线（v2）：坞底 1px——本卷已用 token 占模型窗口比例，近满转朱砂。
          裸数字徽标退役；读数进 hover。窗口未知（0）或零用量不显。 */}
      <div
        className={`pp-inkline${inkRatio > 0.8 ? ' full' : ''}`}
        style={{ opacity: inkWindow > 0 && tokenCount > 0 ? 1 : 0 }}
        title={
          inkWindow > 0 && tokenCount > 0
            ? `墨量 ${tokenCount} / ${inkWindow} tok（${Math.round(inkRatio * 100)}%）`
            : '墨量——本卷已用 token 占模型窗口比例（惰性读取，切回直接读）'
        }
      >
        <span style={{ width: `${Math.round(inkRatio * 100)}%` }} />
      </div>

      {/* rework P2-3 / P0-1：全放二次确认 = 独立居中模态（不内嵌创作坞，避免高度/关窗竞态） */}
      {pendingYolo && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 模态遮罩点击空白 = 取消（明确对话框语义）
        <div
          className="pp-mode-dialog-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPendingYolo(false);
          }}
        >
          <div className="pp-mode-dialog" role="dialog" aria-modal="true" aria-label="确认全放模式">
            <div className="pp-mode-dialog-title">切换到全放模式</div>
            <div className="pp-mode-dialog-body">{MODE_DESCRIPTIONS.yolo}</div>
            <div className="pp-mode-dialog-actions">
              <button type="button" onClick={() => setPendingYolo(false)}>
                取消
              </button>
              <button type="button" className="primary" onClick={() => setPermissionMode('yolo')}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
