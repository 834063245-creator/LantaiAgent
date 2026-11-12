// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/panels/ComposerDock — 创作坞（Stage-4 §4.2 集成任务非新设计）。
// （增补四起源码落位 plugins/builtin/compose-dock/——产物通道化。）
//
// 定位（canvas-space-model-notes.md §5 拍板 9）：带设置的输入条，常驻画布
// 元素，状态跟活跃目标走（显式激活 + 高亮——2026-09-10 拍板：浏览态自动
// 跟随退役），设置项贴输入条（模型/权限/思考强度，展开收起），发送前顺手拨。
// 空白画布无活跃会话时处于无主待命态。
//
// 2026-09-06 收口 + 续批：三行制 = 书眉行（卷名 + 翰/律/后台指示）居顶、
// 输入行居中、设置行（模型/权限/思考）垫底——三控件落位输入行之下的
// 「下方一行」（DSH InputBar 排布），卷名/翰/律恒居书眉行；设置行内模型独居
// 左端、权限+思考成对靠右（组内权限在左）；设置行控件定宽防跳动（详
// PaperPanel.css）；模型选择器触发器恒驻 + 弹层内搜索（详 ModelSelector 头注）。
//
// 归属铁律：创作坞是视图不是容器，不拥有任何会话状态，只"指向"当前活跃
// 会话。草稿按会话隔离 = input-store 既有 sessionDrafts 机制（chat-session
// 切卷时 save/restore，本组件只读写 live inputText）；模型/思考 = compose-store
// 每会话偏好（写全局 settings + 热切换信号）；权限 = mode-store 工作区级
// 单一真相。
//
// 挂载：compose-dock 插件以 ctx.overlays 贡献行注册（slot:'composer'），
// 由 PaperPanel 渲染在底部；经 paper/overlay-context 取活跃会话。
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享
// 真实例，react 经构建期别名桥。

import {
  type ClipboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
// 浮层 portal（2026-09-22 附图预览案）：坞内两处**全局模态**（附图大图预览 /
// 全放二次确认）必须挂到 body，理由见下方附图预览处病灶注。
// ⚠ 为什么是裸 `createPortal` 而不是 app/overlay 的 Overlay 原语：**产物域装不下它**
// ——构建用 `--jsx-import-source=./host`，插件目录之外的 JSX 文件会被 esbuild 按它
// 自己的相对路径解析 `./host/jsx-runtime`（该处没有此文件 ⇒ 构建直接红：
// `Could not resolve "./host/jsx-runtime"` from `app/overlay.tsx`）；而把 Overlay
// 加进 host.ts ⇒ 撞 host-modules 的 FaceBridgeSeal（faceDeps 必须补键）⇒ 宿主面指纹
// 变 ⇒ 产物不能热更、须重建 exe。故本件只取**无 JSX 的两件**：portal 走 react-dom
// （esbuild 内联，不涉 JSX），Escape 走宿主桥既有的 useDialogEscape（faceDeps 早已在
// 册，取用零指纹代价）——遮罩点关语义就地写在下面两处。
import { createPortal } from 'react-dom';
import { volumeDisplayName } from '../../../state/volume-name';
import type {
  ChatCore,
  ChatImageRef,
  CommandContribution,
  ComposeSessionPrefs,
  // A4 销账 W3（2026-09-28）：`rpc-contract` 带计数与插桩（有身份）——DirEntry 是
  // 类型面（编译期擦除），值面 kernelListDirectory 改走本包宿主桥（键已在 faceDeps 在册）。
  DirEntry,
  PermissionMode,
  ProviderSettings,
  StoredThinking,
  WorkEntry,
} from './host';
import {
  agentSessionState,
  ensureSkillCatalog,
  extractImageFiles,
  filterCommands,
  getChatStore,
  getComposeStore,
  getModel,
  kernelListDirectory,
  killShellWork,
  listCommands,
  loadSettings,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  modelDescriptor,
  modelInput,
  modelThinking,
  msgStoreFor,
  onSettingsSaved,
  PERMISSION_MODES,
  previewUrlFor,
  resolveNewSessionDefault,
  selectPreset,
  slashOnly,
  thinkingOptionsOrDefault,
  useCoreStore,
  useDialogEscape,
  useModeStore,
  usePaperDock,
  usePresetStore,
  useShellStore,
  useToastStore,
  watchFileDragDrop,
} from './host';
import { composerSubmitOnKey } from './ime';
import { SlashPanel } from './slash-panel';
import './composition-chip.css';
import './goal-strip.css';
import { InkLedger } from './InkLedger';
import { ModelSelector } from './ModelSelector';
import { WorkLedger } from './WorkLedger';

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

/** list_directory 递归项（Rust DirEntry 序列化形状——schema 推导）。 */
type YinDirEntry = DirEntry;

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

/** 律（快捷键总览）——2026-10-22 P2 分组：输入 / 附卷 / 画布 / 纸面。
 *  13 行等权平铺时代结束；组题沿用册页的「方墨锚点 + 字距题字」语言。 */
const HELP_GROUPS: ReadonlyArray<{
  title: string;
  rows: ReadonlyArray<readonly [string, string]>;
}> = [
  {
    title: '输入',
    rows: [
      ['Enter', '发送'],
      ['Shift+Enter', '换行'],
      ['↑ / ↓', '输入历史'],
      ['/ 或 翰', '命令面板'],
    ],
  },
  {
    title: '附卷',
    rows: [
      ['引 · 夹', '附文件入卷'],
      ['拖文件到坞', '界栏松手入卷'],
    ],
  },
  {
    title: '画布',
    rows: [
      ['Alt+↑↓', '块间移动'],
      ['Alt+←→', '卷间移动'],
      ['Home', '画布回原点'],
    ],
  },
  {
    title: '纸面',
    rows: [
      ['拖文类签', '移出钉住'],
      ['拖流区边缘', '移动流区'],
      ['拖流区四角', '调整宽度'],
      ['拖选区', '抽纸条'],
    ],
  },
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

/** 无目录声明模型的思考控件安全兜底表已收口到 provider/thinking 的
 *  THINKING_SAFE_OPTIONS（2026-09-23 思考下沉：设置页参数面板与这里共用同一把
 *  尺子），本件不再自抄一份。 */

export const ComposerDock = memo(function ComposerDock() {
  const core = useCoreStore((s) => s.core);
  const { activeSessionId, composerLock } = usePaperDock();
  /* ── 坞内提示（2026-11-12 重构；用户：「坞内弹提示会导致整个创作坞跳变，而且必须
   *    要点『知道了』才消失，感觉不舒服」）──────────────────────────────
   * 旧形态 = 坞内一行 `.pp-local-notice` + 「知道了」按钮：**占布局**（坞高被撑高 ⇒
   * 整个创作坞跳变一次、关掉再跳一次）+ 必须人点才走。现改挂**坞上方的瞬时浮层**
   * （toast 通道的 `composer` 落位，贴 `--composer-band` 坞顶线）：不占布局、
   * 自动消散、位置跟着坞走（坞浮起来也正确）。
   * 语义分层照旧：成功不播报（界面变化即反馈，见 toast-store 克制纪律），
   * 只有被拦/失败/需要知情的警示才弹；error 级默认停留加倍。 */
  const notice = useCallback((text: string, level: 'info' | 'warn' | 'error' = 'warn') => {
    useToastStore.getState().showToast(text, level, undefined, 'composer');
  }, []);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /* ── 创作坞 v2（2026-08-31）本地态：律（快捷键）/ 引（文件）
   *    / 拖放入卷界栏 / 历史眉批。── */
  const [schemeOpen, setSchemeOpen] = useState(false);
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

  /* ── 墨量册读数（2026-09-13）：真源 = 活跃卷 Agent 侧 token 账本 ──
   * 依赖 sessionTokens 作为重算触发（每次请求入账时 _recordTokens 会写它，
   * 卷级 store 的订阅随之把本组件重渲一次）——不引入第二个账本副本。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionTokens 是刻意的「入账触发器」——账本真源在 Agent 侧，用卷级总量当重算信号
  const tokenStats = useMemo(() => {
    if (!core || activeSidNum == null) return null;
    return agentSessionState.getAgent(core.panelId, activeSidNum)?.getTokenStats?.() ?? null;
  }, [core, activeSidNum, sessionTokens]);
  const [inkOpen, setInkOpen] = useState(false);
  /* 役册（2026-09-22）：与墨量册同族的第二个读数件——墨 = 还能喂多少上下文，
   * 役 = 已经派了多少活出去。同属「落笔前该看的读数」，故同居设置行行尾。 */
  const [workOpen, setWorkOpen] = useState(false);

  /* ── 草稿（input-store live = 当前活跃会话的输入框；切卷由 chat-session
   *    负责 save/restore sessionDrafts，本组件只读写 live 槽）── */
  const [inputText, setInputTextState] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<Array<{ path: string; name: string; size: number }>>([]);
  const [attachedImages, setAttachedImages] = useState<ChatImageRef[]>([]);
  useEffect(() => {
    if (!core) {
      setInputTextState('');
      setAttachedFiles([]);
      setAttachedImages([]);
      return;
    }
    const input = getChatStore(core.panelId).input;
    const sync = () => {
      setInputTextState(input.getState().inputText);
      setAttachedFiles(input.getState().attachedFiles);
      setAttachedImages(input.getState().attachedImages);
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

  /* ── C2（2026-08-27）：切卷清理本地态——展开中的浮层面板不跨会话残留
   *    （A 卷的展开状态带到 B 卷是认知噪音）。
   *    v2 增补：律/引面板同属本地态，一并清。
   *    2026-11-06 合并 A：思考档位不再是本地展开态——它随模型弹层开合，
   *    切卷时弹层由 ModelSelector 自己的外点/blur 收合，本表无须代管。
   *    2026-11-12：坞内提示改挂 toast 浮层（自带消散），切卷不再需要清它。 ── */
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId 是刻意的「切卷触发器」——正是要响应它变化清本地态
  useEffect(() => {
    setHelpOpen(false);
    setYinOpen(false);
    setInkOpen(false);
    setWorkOpen(false);
    setHistHint(false);
  }, [activeSessionId]);

  const autoGrow = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    /* box-sizing: border-box 下 scrollHeight 不含上下边框：只写 scrollHeight 会让
     * 单行的 clientHeight 比内容少 1px（实测 39/38）⇒ 滚动条常驻（2026-10-21 P0 病灶）。
     * 补上 border 高度再夹上限；上限之外才真滚动。 */
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, 144)}px`;
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
      // 运行态唯一读面（v43）：`runningSessions` = 本面板在跑的卷（含种类）。
      // 不再各自 `getExec(...).isRunning`——读面漂移在订阅那一环已经炸过一次
      //（2026-09-06），事实面收成一处后，停钮/后台指示/呼吸线永远同源。
      const runningIds = new Map(agentSessionState.runningSessions(core.panelId).map((r) => [r.sid, r.state]));
      let activeRun = false;
      const bg: Array<{ id: number; label: string }> = [];
      const sess = getChatStore(core.panelId).sess.getState().sessions;
      for (const s of sess) {
        if (!runningIds.has(s.id)) continue;
        if (s.id === activeSidNum) activeRun = true;
        else bg.push({ id: s.id, label: volumeDisplayName(s.label, s.id) });
      }
      setRunning(activeRun);
      setBgRunning(bg);
    };
    // 运行态同步根治（2026-09-06）：订阅面 = exec 实例表变更（版本 bump——
    // 惰性水合/拟文期迟到的实例、removeExec 后的重建，subscribeExecAll 内
    // 全部重挂）+ 既有实例起停 + sess 表（改名/增删 → 重算后台清单）。
    // 旧实现只对「effect 挂载时刻已存在」的实例挂 onChange——迟到的 exec
    // 实例永远无订阅，起停不可见（会话在跑而停钮不出现）。
    const unExecAll = agentSessionState.subscribeExecAll(core.panelId, syncAll);
    const unSess = getChatStore(core.panelId).sess.subscribe(syncAll);
    return () => {
      unExecAll();
      unSess();
    };
  }, [core, activeSidNum]);

  /** 卷名反查（役册「他卷」段用）——与后台卷指示同一把尺子：sess 表 +
   *  `volumeDisplayName`（禁在调用点散写卷号；2026-09-21 卷号收显示纪律）。 */
  const sessionNameOf = useCallback(
    (sid: number | null): string => {
      if (sid == null || !core) return '归属未知';
      const sess = getChatStore(core.panelId).sess.getState().sessions;
      const s = sess.find((x) => x.id === sid);
      return s ? volumeDisplayName(s.label, s.id) : `案卷 ${sid}`;
    },
    [core],
  );

  /* ── 会话生效配置（方案甲：覆盖 ?? 全局默认，实时解析）── */
  const [prefs, setPrefs] = useState<ComposeSessionPrefs | undefined>(undefined);
  /* 会话**显式**思考覆盖（2026-09-23 思考下沉）：prefs 是「解析后」的生效配置，
   * 未改卷时它带着全局快照的档位值——拿它当「本卷拨过」用会把全局值误当覆盖，
   * 永远压住模型的 per-model 档位显示。故档位显示单独读覆盖表（getPrefs）。 */
  const [thinkingOverride, setThinkingOverride] = useState<StoredThinking | undefined>(undefined);
  useEffect(() => {
    if (!core || activeSessionId == null) {
      setPrefs(undefined);
      setThinkingOverride(undefined);
      return;
    }
    const compose = getComposeStore(core.panelId);
    const sync = () => {
      const st = compose.getState();
      setPrefs(st.resolveEffective(activeSessionId));
      setThinkingOverride(st.getPrefs(activeSessionId)?.thinking);
    };
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
  // 2026-09-23 思考下沉：描述符改读 **provider 作用域**（覆盖 ?? API 拉取 ?? 目录
  // seed）——与设置页参数面板、请求期 assertEffortDeclared 同一把尺子。此前读全局
  // getModel：网关模型在拉取失败/重启后拿不到自己的档位声明，同一模型在坞里与在
  // 设置页显示的档位表可以不一致。行缺席（已删）才回落全局目录。
  const modelDesc = useMemo(() => (provider ? modelDescriptor(provider, model) : getModel(model)), [provider, model]);
  // 附图能力门禁（multimodal-image-plan D-8②）：生效输入模态含 'image' 才开
  // 图片采集道——策略在此（视图层），机制在 chat-core（intake 方法）。
  // modelInput 合并链（B5）：ModelOverrides.input 覆盖 ?? 目录 seed vision 声明；
  // 目录外自定义 vision 模型经设置页参数面板补声明即开。
  const imageCapable = modelInput(provider, model).includes('image');
  /* 2026-11-08 墨线退役（丙案尾项）：坞底那条 2px 墨线撤了——它与书眉「墨 NN%」
   * 读数**同源同判据**（同一个 tokenStats.usedTokens / 同一个 >80% 门槛），是同一件事
   * 画两遍；而且它占着"坞底发丝线"那条位置，而坞是浮在纸上的，底边本来就是纸的边。
   * 「快满了」的余光信号没有丢：近满态现在挂在触发器本体（.pp-ink-trigger.full →
   * 字与点一起转朱砂 + 呼吸，见 paper-composer.css），与旧 .pp-inkline.full 同判据。
   * 分母口径随之整个交回墨量册（它自己算 percent / nearFull，读同一把 token-meter 尺子）：
   * per-model 覆盖 ?? 目录声明（modelContextWindow，与运行时压缩阈值同链），未知窗口不编造。 */
  const thinkingOptions = useMemo(() => {
    // P14：有声明用声明档位表；无声明给「自动/关闭」协议安全兜底——思考按钮常驻
    // （DSH 语义），不编造命名档位（''/off 在 assertEffortDeclared 不拦、协议层可
    // 安全表达）。表来自 thinkingOptionsOrDefault（与设置页参数面板同一函数）。
    return thinkingOptionsOrDefault(modelDesc);
  }, [modelDesc]);
  // 生效档位三层（2026-09-23）：会话覆盖（本卷显式拨过）?? 该模型档位
  // （per-model 覆盖 ?? 本家默认档位，经 modelThinking 一把尺子）；行缺席（已删）
  // 才回落新卷出生默认。
  const currentThinking = thinkingOverride ?? (provider ? modelThinking(provider, model) : newSessionDefault.thinking);

  /* ── 权限（mode-store 工作区级单一真相）── */
  const permissionMode = useModeStore((s) => s.permissionMode);
  const pendingYolo = useModeStore((s) => s.pendingYolo);
  const setPermissionMode = useModeStore((s) => s.setPermissionMode);
  const setPendingYolo = useModeStore((s) => s.setPendingYolo);
  /* 全放二次确认模态的 Esc（同附图预览：portal 到 body 后 Escape 只能走 document 级） */
  useDialogEscape(() => setPendingYolo(false), { enabled: pendingYolo });

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

  /* ── 组合（S6 P1e：卷级组合选择芯片）──────────────────────────────
   * 两态与「开口即开卷」同构（模型/思考同款语义，见 onModelChange）：
   *   无主态（无活跃卷）→ 拨的是**全局默认**（selectPreset = 设置面板「组合」节
   *     同一入口，落 settings；即「新卷出生默认」）。
   *   有卷且**空白**    → 拨的是**卷级选择**（core.selectSessionPreset：校验 → 登记
   *     → 当场重建句柄；写路径自带二道闸，与这里的控件锁同一把尺子）。
   *   有卷且跑过一轮    → **只读标签**（组合决定模型看到的工具与提示面 = 字节契约，
   *     中途换面会让前缀缓存与已声明能力面不一致——DSH「控制在此不承诺」同款）。
   * 读面：preset 清单/选择态来自 preset-store；本卷身份与来源来自
   * core.sessionComposition（异步 = 解析面动态 import，见 app/chat/session-composition）。 */
  const presetRoster = usePresetStore((s) => s.roster);
  const presetSelected = usePresetStore((s) => s.selected);
  const presetError = usePresetStore((s) => s.error);
  const [compOpen, setCompOpen] = useState(false);
  const [compInfo, setCompInfo] = useState<{ presetId: string; source: 'session' | 'global'; error: string | null }>({
    presetId: presetSelected,
    source: 'global',
    error: null,
  });
  const [compBlank, setCompBlank] = useState(true);
  /** 读面重取触发器（2026-10-29）：写成功后本卷记录已变，但空白卷没有消息事件可等——
   *  不主动重读就会停在旧标签，用户看到的就是「切了没反应」（卷首芯片同款根因）。 */
  const [compTick, setCompTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: presetRoster 是刻意的重读触发器（「重新扫描」/新建 preset 后本卷身份与可用性要重解析），非 effect 体内直接引用值——与 settingsTick 同款手法
  useEffect(() => {
    let alive = true;
    // 坞上下文的 activeSessionId 是 string；卷号 API（isSessionBlank / sessionComposition）
    // 收 number——两处转换集中在这里
    const sidNum = activeSessionId == null ? null : Number(activeSessionId);
    const sid = sidNum != null && Number.isFinite(sidNum) ? sidNum : null;
    const refresh = () => {
      if (!alive) return;
      if (sid == null) {
        // 无主态：显示全局默认（新卷出生默认）
        setCompInfo({ presetId: presetSelected, source: 'global', error: null });
        setCompBlank(true);
        return;
      }
      // 读面缺席（桩 core / 旧句柄）→ 保守当「空白可拨」+ 显示全局默认，
      // 不炸坞（能力位语义：句柄不实现 = 无读数，同 token 三能力位）
      setCompBlank(core?.isSessionBlank?.(sid) ?? true);
      void core
        ?.sessionComposition?.(sid)
        .then((info) => {
          if (alive) setCompInfo(info);
        })
        .catch(() => {});
    };
    refresh();
    // 本卷内容变化 = 可能刚跑过一轮（锁定态随之翻转）——订阅消息面
    const unsub = sid != null && core ? msgStoreFor(core.panelId, sid).subscribe(refresh) : undefined;
    return () => {
      alive = false;
      unsub?.();
    };
  }, [core, activeSessionId, presetRoster, presetSelected, compTick]);
  /** 芯片拨动：无主态写全局默认；有卷（空白）写卷级选择——拒绝原因就地可见。 */
  const onCompositionChange = useCallback(
    async (id: string) => {
      setCompOpen(false);
      if (activeSessionId == null) {
        if (!selectPreset(id)) notice(`组合「${id}」不可用——原因见设置 → Agent → 组合。`, 'error');
        return;
      }
      if (!core) return;
      const sidNum = Number(activeSessionId);
      if (!Number.isFinite(sidNum)) return;
      const r = (await core.selectSessionPreset?.(sidNum, id)) ?? {
        ok: false,
        reason: '本坞未接到组合写入口（旧句柄）',
      };
      if (!r.ok) {
        notice(`组合未切换：${r.reason}`, 'error');
        return;
      }
      // 写成功 = 本卷记录已变：主动重取读面（空白卷等不到消息事件）。
      // 2026-11-12：成功不再播报——芯片本身已变（toast 克制纪律：界面变化即反馈）。
      setCompTick((v) => v + 1);
    },
    [activeSessionId, core, notice],
  );
  const compLocked = activeSessionId != null && !compBlank;
  const compLabel = compInfo.presetId;
  /** 创作者模式入口（2026-10-30）：起一卷 creator + 预填开场白（不自动发送）。 */
  const onCreatorDraft = useCallback(async () => {
    const r = (await core?.createCreatorSession?.()) ?? {
      ok: false,
      reason: '本坞未接到创作者入口（旧句柄）',
    };
    if (!r.ok) notice(`无法进入创作者模式：${r.reason}`, 'error');
  }, [core, notice]);

  /* ── 斜杠命令（v2 2026-08-31；2026-09-19 command-surface-rework；2026-10-22 P2 翰解耦）：
   *    命令清单真源 = app/commands/command-catalog 合流点（本卷内建命令 +
   *    ctx.commands 贡献 + 技能候选）——旧 CommandRegistry 单例已退役。
   *    **翰 = 全局命令面板（Ctrl+K 同一份）**：带搜索框、分组、动作/插件命令，不再在坞里
   *    维护第二份内联清单；`/` 触发词仍走本内联面板（只列斜杠触达的命令、查询词就在
   *    正文里，↑↓/Enter/Esc 照旧）。两处共用 listCommands/filterCommands 与执行面。 ── */
  const slashQuery = useMemo(() => {
    const v = inputText;
    if (!v) return null;
    const last = v.lastIndexOf('/');
    if (last < 0) return null;
    if (last > 0 && v[last - 1] !== ' ' && v[last - 1] !== '\n') return null;
    const q = v.slice(last + 1);
    /* 参数模式：命令词后面出现空白 = 已经在写参数（`/goal pause`），面板让位。
     * 没有这条，带参命令填完「/goal 」后查询词变成「goal 」，列表会继续挂着，
     * 用户接着打的参数再把它顶成「无匹配命令」。 */
    if (/\s/.test(q)) return null;
    return q;
  }, [inputText]);
  /* 技能清单变更信号（2026-11-07 热装载）：扫描完成且清单真变了 → 自增一次，
   * 让下面的 slashCommands 重取（命令清单是同步读取面，靠 tick 触发重算）。
   * 产物域不订阅 panel-defs-store（那要动宿主桥 faceDeps、改宿主面指纹），
   * 改读 ensureSkillCatalog 的返回值——同一条闭环，零新增宿主面键。 */
  const [skillTick, setSkillTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: skillTick 是刻意的「技能清单换代」触发器——命令清单是同步读取面，正是要靠它重算
  const slashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return filterCommands(slashOnly(listCommands(core)), slashQuery);
  }, [slashQuery, core, skillTick]);
  /* 面板每次**打开** = 强制重扫技能目录（不只是键变了才扫）：热装载就是在同一个
   * 工作区里多出 `.lantai/skills/<名>/SKILL.md`（设置页新建 / 手放 / Agent 自己写），
   * 路径键根本不变——旧实现靠键控检查，「永远不重扫」+「扫完不通知」两处叠加，
   * 新技能在斜杠面板里就是不出现。
   * ⚠ 只在「未开 → 已开」那一次扫：slashQuery 随每个按键变，按它无条件扫 =
   * 打一个 /co 就 list+read 两遍磁盘（每个按键一次全量扫描）。 */
  const slashOpened = useRef(false);
  useEffect(() => {
    const open = slashQuery !== null;
    const justOpened = open && !slashOpened.current;
    slashOpened.current = open;
    if (!justOpened) return;
    let cancelled = false;
    void ensureSkillCatalog(useShellStore.getState().projectPath, { force: true }).then((changed) => {
      if (!cancelled && changed) setSkillTick((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [slashQuery]);
  /* ── C3（2026-08-27）：斜杠面板键盘导航（↑↓ 选、Enter 执行、Esc 关）。 ── */
  const [slashIdx, setSlashIdx] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: slashQuery 是刻意的「查询词变化」触发器——正是要响应它复位高亮
  useEffect(() => {
    setSlashIdx(0); // 查询词变化 → 高亮复位首项（滚动归零在面板件内）
  }, [slashQuery]);
  const slashActive = slashCommands.length > 0;
  /** 命中查询词（与 filterCommands 同口径：去首斜杠 + 小写），交给面板标朱。 */
  const slashHit = (slashQuery ?? '').trim().replace(/^\//, '');
  /* 点选/回车 = 提交。带参命令（takesArg：/goal <目标> · /remember <事实>）**不执行**，
   * 改成把「/cmd 」填进输入框等用户补参数——旧形态点一下就 handler('') 空参跑掉。 */
  const commitSlash = useCallback(
    (cmd: CommandContribution) => {
      if (!core) return;
      if (cmd.takesArg) core.prepareCommand(cmd);
      else core.executeCommand(cmd);
    },
    [core],
  );

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
  const onRemoveAttachedImage = useCallback(
    (idx: number) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().removeAttachedImage(idx);
    },
    [core],
  );

  /* ── 粘贴附图（B2 2026-09-08）：clipboardData.items kind='file' 且 mime 为
   *    图片 → 附图道；文本粘贴零影响。
   *    ⚡ 语义变更（2026-09-19）：**声明面不再是粘贴门禁**。旧行为「非 vision
   *    模型贴图直接忽略」= 用户意图被静默丢弃（图没收、没缩略图、没提示对象，
   *    连路径都不留）——与 agent 侧新发送策略（先发、被拒再降级，见 agent.ts
   *    streamOnce 附图分支注）自相矛盾：那边已改为「一律先发」，这边却仍按声明
   *    把图拦在门外。现在图一律收进附图道，声明只决定**要不要提示**。
   *    注：夹选 / 拖放（attachPaths）仍按声明分流走路径附件——那是**有意的**
   *    文本模型语义（图作文件引用，模型可按路径读取），非静默丢弃，故不在此列。 ── */
  const onComposerPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = extractImageFiles(e.clipboardData.items);
      if (files.length === 0) return; // 文本/非图片粘贴走默认
      e.preventDefault();
      // 收图无条件——发送面会兜底（真被服务商拒 → 记档 + 改文字占位重发）
      void core?.intakeImageFiles(files);
      if (!imageCapable) {
        notice('当前模型未声明图片输入——图已收；若服务商拒收会自动改用文字转述（可在设置行换 vision 模型）', 'warn');
      }
    },
    [core, imageCapable, notice],
  );

  /* ── 附图预览（B2）：大图浮层——点击缩略图开；关闭三路 = 点遮罩 / Esc。
   *    Esc 走 useDialogEscape（document capture 监听，**与焦点无关**）——旧实现把
   *    onKeyDown 挂在那个不可聚焦的 div 上，焦点在缩略图按钮上时永远收不到（用户报
   *    「预览收不回」的键盘那一半）。 ── */
  const [imagePreview, setImagePreview] = useState<ChatImageRef | null>(null);
  useDialogEscape(() => setImagePreview(null), { enabled: imagePreview !== null });

  /* ── 附文件入卷共用底座（引 / 拖放，v3 B2）：图片入附图道，其余走路径附件老路
   *    （C10 语义保留：size 恒 0 不显示——拿不到真大小就不伪造）。
   *    ⚡ 2026-09-22：不再按 `imageCapable` 分流——声明缺失时用户拖进来的图会静默
   *    变成「路径附件」（实测就是「拖放失灵」）；声明面只作 UI 提示。 ── */
  const attachPaths = useCallback(
    (paths: readonly string[]) => {
      if (!core || paths.length === 0) return;
      void core.attachIntakePaths(paths);
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
      const entries = await kernelListDirectory(pp, true);
      setYinFiles(flattenDirEntries(entries));
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
  }, [core]);

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
        notice('当前没有活跃会话——请先在首页新建或指定工作区。', 'warn');
        return;
      }
      getChatStore(core.panelId).input.getState().setInputText(t);
    }
    await core.sendMessage();
  }, [core, notice]);

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

  /* ── 思考档位面（2026-11-12 DSH 两级菜单，用户拍板「去抄 dsh 的 UX」）──────
   * 旧形态（2026-11-06 合并 A）把档位表平铺成 n 枚 chip 塞在模型弹层底部——用户
   * 判「模型思考强度选择这块的 UX 有毛病」。DSH 的解法是**同级第二面**：根栏两格
   * 「模型 / 思考」，点进思考面才是一张竖排档位清单（当前档行型选中）。
   * 这里只把**数据面**交给 ModelSelector（值/标签/档位表/回调），文案仍由本件给
   * （档位名在 thinkingZhLabel、说明在 THINKING_DESC），选择器不感知思考语义。 */
  const thinkingSeat = useMemo(
    () => ({
      value: currentThinking ?? '',
      label: thinkingZhLabel(currentThinking),
      options: thinkingOptions.map((o) => ({
        value: o.value,
        label: thinkingZhLabel(o.value),
        hint: THINKING_DESC[o.value] ?? '',
      })),
      onChange: onThinkingChange,
    }),
    [currentThinking, thinkingOptions, onThinkingChange],
  );

  /* ── 让位带上报（旧 --composer-h-live）已于 2026-09-17 拆除 ──
   * 坞可被拖离底带（自由浮动 + 吸附 + 双击复位），「坞高」不再是让位件的尺子
   * ——让位带（视口底 → 坞顶线）是**槽主人 paper-shell 的几何**，现由
   * use-composer-float 写 :root 的 --composer-band（消费面：递牒卡宿主 /
   * 插件 dock）。坞本体不再自报尺寸：一处权威源，浮动态也正确。
   * 注：旧 token --composer-h-live 在**过渡期**由槽主人代发一版（运行中 exe 内嵌
   * 的外壳 CSS 仍读它）——见 use-composer-float.ts 的「过渡期旧 token 代发」。 ── */

  /* ── 拖文件入卷（v2 2026-08-31）：Tauri onDragDropEvent 原生通道——
   *    T2 WebView dragDropEnabled 默认接管，HTML5 drop 永不触发（C10 尸检）。
   *    界栏 = 拖拽悬停坞体时高亮；松手命中坞体才入卷（落画布其它处不抢）。
   *    mock 模式（浏览器 dev / vitest）watch 内部 no-op。 ── */
  const dockRef = useRef<HTMLDivElement | null>(null);
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

  /* ── 浮层互斥（2026-09-01 审计）：律/引/墨/役 浮层同屏只开一个——
   *    此前各 onClick 只关自己认识的兄弟面板，浮层可叠开（截图实证）。
   *    2026-10-22 P2：翰改开全局命令面板（模态、自带互斥），不在此列。
   *    2026-11-06 合并 A：思考档位不再是独立浮层——它随模型弹层开合，
   *    ModelSelector 的外点关闭/toggle 就是它的收合路径，不参与本表。 ── */
  const toggleLayer = useCallback((layer: 'help' | 'yin' | 'ink' | 'work' | 'scheme') => {
    setHelpOpen(layer === 'help' ? (v) => !v : false);
    setYinOpen(layer === 'yin' ? (v) => !v : false);
    setInkOpen(layer === 'ink' ? (v) => !v : false);
    setWorkOpen(layer === 'work' ? (v) => !v : false);
    setSchemeOpen(layer === 'scheme' ? (v) => !v : false);
  }, []);

  return (
    <div className={`pp-composer${dragOver ? ' pp-droptarget' : ''}`} ref={dockRef}>
      {/* 书眉行（2026-11-09 用户裁定：**模型与权限另起一行**）——左端卷名，右端只有读数 + 移。
          用户原话：「模型选择和权限选择还是得另起一行，现在的 UX 好奇怪」。
          判据修正（翻 2026-11-08 丙案"模型是书眉级身份"那条）：书眉是**这一卷的账**
          （哪一卷 + 还有什么在跑），换模型与拨权限是**动作**——动作与账挤在同一行，
          读起来就是"卷名右边跟着一串控件"。模型+权限回到自成一行（它俩同属"这一趟怎么跑"）。 */}
      <div className="pp-composer-header">
        <span
          className="pp-composer-target"
          // hover 文案 = **显示名**（2026-09-21 卷号收显示）：旧实现硬报 `案卷 ${id}`——
          // 对有名卷也报号（同元素下一行就有名字），且裸用 id 绕过了单一真源
          // `volumeDisplayName`（state/volume-name 纪律①：禁在调用点散写）。
          data-tip={activeSession ? volumeDisplayName(activeSession.label, activeSession.id) : '落笔即另起一卷'}
        >
          {activeSession ? volumeDisplayName(activeSession.label, activeSession.id) : '新卷'}
        </span>
        <div className="pp-composer-settings-spacer" />
        {/* 书眉工具带（2026-11-09 密度批后只剩**移/锁**）：拖动锁是槽主人（纸壳）
            的能力位——宿主不给 composerLock ⇒ 整枚不出现，坞不知道锁态。常显可点、
            不做悬停浮现：前者是用户报的「不知道能拖」，后者是用户报的「还没挪过去
            就消失了」。翰/律 于同日撤出本行（「案」抽屉里已各有一份，书眉那两枚是重复）。 */}
        {activeSidNum != null && (
          <WorkLedger
            panelId={core?.panelId ?? ''}
            sessionId={activeSidNum}
            sessionLabel={volumeDisplayName(activeSession?.label, activeSidNum)}
            sessionNameOf={sessionNameOf}
            onStop={(e: WorkEntry) => {
              if (!core) return;
              const jobId = Number.parseInt(e.id.replace(/^job-/, ''), 10);
              if (Number.isFinite(jobId)) void killShellWork(core.panelId, jobId);
            }}
            open={workOpen}
            onToggle={() => toggleLayer('work')}
          />
        )}
        {activeSidNum != null && (
          <InkLedger
            stats={tokenStats}
            sessionLabel={volumeDisplayName(activeSession?.label, activeSidNum)}
            fallbackTotal={tokenCount}
            open={inkOpen}
            onToggle={() => toggleLayer('ink')}
          />
        )}
        <div className="pp-dock-tools">
          {composerLock && (
            <button
              type="button"
              className={`pp-tool-btn${composerLock.unlocked ? ' open' : ''}`}
              aria-pressed={composerLock.unlocked}
              aria-label={composerLock.unlocked ? '锁定创作坞' : '解锁创作坞（可拖动）'}
              data-tip={composerLock.unlocked ? '锁定创作坞' : '解锁创作坞'}
              data-tip-hint={
                composerLock.unlocked ? '已解锁：按住坞体空白处拖动，双击复位' : '解锁后按住坞体空白处拖动，双击复位'
              }
              onClick={composerLock.toggle}
            >
              {composerLock.unlocked ? '锁' : '移'}
            </button>
          )}
          {/* 2026-11-09 密度批：**翰/律 撤出书眉**。它们上一批随「案」落地时已经进了抽屉
              （同一对入口在抽屉「另起」段里各有一行），书眉这两枚是**重复**——同一件事在
              同一个坞里有两个入口，用户看到的是"挤"。保留抽屉那份：抽屉是"低频动作的家"，
              而 Ctrl+K 本身就是翰的快捷键，不需要常驻一枚单字钮提醒。 */}
        </div>
        {/* B7（2026-08-27）：后台卷运行指示 + 停止——此前任一后台会话在跑就
            全局阻断发送（chat-core），但创作坞无任何指示、无从停止。 */}
        {bgRunning.length > 0 && (
          <span className="pp-bg-running" data-tip={`后台卷：${bgRunning.map((s) => s.label).join('、')}`}>
            ⟳ 后台 {bgRunning.length} 卷运行中
            <button
              type="button"
              className="pp-bg-stop"
              data-tip="停止全部后台卷"
              data-tip-hint={bgRunning.map((s) => s.label).join('、')}
              onClick={() => {
                if (!core) return;
                // 停账 + 级联（同 chat-core.abort 语义）：`stopRuns` = 用户停止
                //（abort 全部在跑运行 + 注销记录 + 清权限卡队列）——**不注销账本条目**
                //（句柄仍在册；条目由句柄消亡 removeAgent 接管清理）。v43 起这条纪律
                // 是结构性的：stop 不再有「把条目注销掉」的形态，也没有「谁记得带令牌」。
                for (const s of bgRunning) {
                  agentSessionState.stopRuns(core.panelId, s.id);
                  agentSessionState.getAgent(core.panelId, s.id)?.cascadeAbort();
                }
              }}
            >
              停止
            </button>
          </span>
        )}
      </div>

      {/* 输入行（原 composer 主体） */}
      <div className="pp-composer-row">
        {slashQuery !== null && (
          <SlashPanel
            commands={slashCommands}
            activeIdx={slashIdx}
            query={slashHit}
            onHover={setSlashIdx}
            onCommit={commitSlash}
          />
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
        {/* 附图预览（B2）：大图浮层——点击缩略图开、点遮罩/Esc 关。
            ⚡ 2026-09-22 病灶修复：原先这里是坞内一个裸 `position: fixed` 的 div，
            症状是**收不回也看不全**（用户报「点开图整个创作坞被图糊住，撤回不了」）。
            根因 = 坞槽 `.pp-composer-slot` 带 `transform: translateX(-50%)`（版心居中）：
            transform 让该元素成为 **`position: fixed` 后代的包含块**，于是 `inset: 0`
            量的是坞的盒子而不是视口——预览被关进坞里（图 `max-width: min(86vw,1200px)`
            远大于坞 ⇒ 几乎盖满遮罩，而关闭判据是 `e.target === e.currentTarget`，点哪儿
            都落在图上）；坞槽同时是 `z-index: 6` 的层叠上下文（坞内 `z-index: 95` 只在
            坞里排序，出不去）；Escape 又挂在**不可聚焦**的 div 上（焦点在缩略图按钮上，
            事件不经过它）⇒ 鼠标键盘都关不掉 = 死锁。
            修法 = 归位成它本来的身份：**全局模态**（CONVENTIONS 浮层政策
            「面板内模态就地渲染；全局模态用 portal=true」）——portal 到 body（与 media
            渲染器的大图预览 `.pp-media-preview-overlay` 同款同层），Escape 交给
            useDialogEscape（document capture 监听，与焦点无关，见下方 hook 调用）。
            坞被拖动后本就写内联 `transform: none`（浮动化），故旧写法只在**默认坞位**
            上炸——那正是默认路径。 */}
        {imagePreview !== null &&
          createPortal(
            <div
              className="pp-image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label="附图预览"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setImagePreview(null);
              }}
            >
              <img src={previewUrlFor(imagePreview.id)} alt={imagePreview.name ?? '附图'} />
              <div className="pp-image-lightbox-meta">
                {imagePreview.name ?? imagePreview.id.slice(0, 12)} · {imagePreview.width}×{imagePreview.height}
              </div>
            </div>,
            document.body,
          )}
        {/* 2026-10-22 P1 左轴：textarea 必须是输入行的**第一个布局件**——书眉卷名、
            设置行、输入正文自此共用一条左缘（旧序把 引/夹 放前面，正文被顶开 88px，
            同一张坞三条左缘）。引/夹/附件/附图一律排到它右侧（靠近拟文印 = 落笔前
            顺手的动作）。浮层（引）是 absolute，不参与这条轴。 */}
        <textarea
          ref={composerRef}
          rows={1}
          value={inputText}
          placeholder={activeSession ? '拟文…' : '落笔即另起一卷…'}
          onPaste={onComposerPaste}
          onChange={(e) => {
            setInputText(e.target.value);
            // 手输 = 退出历史浏览（浏览下标复位；草稿槽保留到下次进入时覆写）
            if (core) {
              const input = getChatStore(core.panelId).input.getState();
              if (input.inputHistoryIdx !== -1) input.setInputHistoryIdx(-1);
            }
          }}
          onFocus={onComposerFocus}
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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const cmd = slashCommands[slashIdx];
                if (cmd) commitSlash(cmd);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                // / 触发词开着 = 关面板保留查询词（去行首斜杠）
                const live = core ? getChatStore(core.panelId).input.getState() : null;
                if (live) {
                  const v = live.inputText;
                  const last = v.lastIndexOf('/');
                  if (last >= 0) setInputText(v.slice(0, last) + v.slice(last + 1));
                }
                return;
              }
            }
            if (composerSubmitOnKey(e.key, e.nativeEvent.isComposing, e.shiftKey)) {
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
        <button
          type="button"
          className={`pp-attach pp-yin-btn${yinOpen ? ' open' : ''}`}
          data-tip="引用工作区文件入卷"
          aria-label="引：引用文件"
          onClick={() => toggleLayer('yin')}
        >
          引
        </button>
        <button
          type="button"
          className="pp-attach"
          data-tip="附文件入卷"
          aria-label="拾遗：附加文件"
          onClick={onAttach}
        >
          夹
        </button>

        {/* 案（2026-11-08 丙案）：坞内唯一的分诊抽屉入口——权限 / 组合 / 造模式 /
            图版 / 律 收在这里。它替代的是原设置行那一整排常驻控件（坞面 13 件 → 5 件）。
            位置：引/夹之后、拟文之前（都是"落笔前的动作"）。 */}
        <button
          type="button"
          className={`pp-attach pp-scheme-btn${schemeOpen ? ' open' : ''}`}
          data-tip="案 —— 本卷与引卷"
          data-tip-hint="权限 / 组合 / 造模式 / 图版 / 快捷键，收在这一处"
          aria-label="案——本卷设置"
          aria-haspopup="dialog"
          aria-expanded={schemeOpen}
          onClick={() => toggleLayer('scheme')}
        >
          案
        </button>

        {/* 案 · 分诊抽屉（2026-11-08 丙案）：坞内唯一的浮层——原设置行那一整排
            （权限三档 / 组合芯片 / 造模式 / 役册 / 墨量册）与律册收进这里。
            形状：向上开（坞贴屏底），几何与役册/墨量册同源（right/bottom/z/宽/封高）。
            语汇：册页段题（方墨锚点 + 字距题字）+ 行型条目，不新增第三种选中语言。 */}
        {schemeOpen && (
          <div className="pp-scheme-panel" role="dialog" aria-label="案——本卷与引卷">
            <div className="pp-scheme-sec">
              <div className="pp-scheme-title">本卷</div>
              {/* 2026-11-09 用户裁定：**权限回到坞面常驻**（与模型同处设置行）——
                  抽屉里这一行随之删除。抽屉仍负责组合 / 图版 / 造模式 / 翰 / 律。 */}
              <div className="pp-comp-sel" data-comp-chip>
                {compLocked ? (
                  <span
                    className="pp-scheme-row pp-comp-pill"
                    data-locked
                    data-tip={`本卷组合：${compLabel}`}
                    data-tip-hint={
                      compInfo.error
                        ? `${compInfo.error}——装配时已回退用户层组合`
                        : `来源：${compInfo.source === 'session' ? '本卷选择' : '全局默认'}；已跑过一轮不能中途换（另起一卷再选）`
                    }
                  >
                    <span className="pp-scheme-k">组合</span>
                    <span className="pp-comp-pill-label pp-scheme-v">{compLabel}</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={`pp-scheme-row pp-comp-pill${compOpen ? ' open' : ''}`}
                    aria-haspopup="listbox"
                    aria-expanded={compOpen}
                    data-tip={activeSessionId == null ? `新卷默认组合：${compLabel}` : `本卷组合：${compLabel}`}
                    data-tip-hint={
                      compInfo.error
                        ? compInfo.error
                        : activeSessionId == null
                          ? '改这里 = 改全局默认'
                          : '空白卷可拨；跑过一轮即锁定'
                    }
                    onClick={() => setCompOpen((v) => !v)}
                  >
                    <span className="pp-scheme-k">组合</span>
                    <span className="pp-comp-pill-label pp-scheme-v">{compLabel}</span>
                    <span className="pp-comp-pill-caret" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                )}
              </div>
              {compOpen && !compLocked && (
                <div className="pp-comp-menu pp-comp-menu-inline" role="listbox" aria-label="组合（preset）">
                  {presetRoster.map((pr) => (
                    <button
                      key={pr.id}
                      type="button"
                      role="option"
                      aria-selected={pr.id === compLabel}
                      className={`pp-comp-opt${pr.id === compLabel ? ' selected' : ''}`}
                      disabled={pr.patch === null}
                      data-tip={pr.patch === null ? '装载失败' : pr.metadata?.description}
                      data-tip-hint={pr.patch === null ? (pr.error ?? 'roster.patch.yml 不可用') : undefined}
                      onClick={() => void onCompositionChange(pr.id)}
                    >
                      {pr.metadata?.name ?? pr.id}
                      {pr.patch === null ? '（损坏）' : ''}
                    </button>
                  ))}
                  {presetError && <div className="pp-comp-note">⚠ {presetError}</div>}
                </div>
              )}
              <div className="pp-scheme-row">
                <span className="pp-scheme-k">图版</span>
                <span className="pp-scheme-v">{activeSidNum != null ? '架在匣下' : '—'}</span>
              </div>
            </div>

            <div className="pp-scheme-sec">
              <div className="pp-scheme-title">另起</div>
              <button
                type="button"
                className="pp-scheme-row"
                data-tip="让 Agent 帮你做一个模式"
                data-tip-hint="起一卷 creator：说完需求，它写出组合并落盘；之后在新卷上选它"
                onClick={() => {
                  setSchemeOpen(false);
                  void onCreatorDraft();
                }}
              >
                <span className="pp-scheme-k">✎ 造模式</span>
                <span className="pp-scheme-v">起一卷 creator</span>
              </button>
              <button
                type="button"
                className="pp-scheme-row"
                data-tip="命令面板"
                data-tip-hint="Ctrl+K 同一份：搜索 / 分组 / 动作与插件命令"
                onClick={() => {
                  setSchemeOpen(false);
                  useShellStore.getState().setPaletteOpen(true);
                }}
              >
                <span className="pp-scheme-k">翰</span>
                <span className="pp-scheme-v">命令面板（Ctrl+K）</span>
              </button>
              {/* 2026-11-09：律册从书眉浮层改为**抽屉内就地展开**——书眉那枚「律」钮
                  已撤（与这里重复），浮层原先靠它定位。现在展开态就在抽屉里继续往下长。 */}
              <button
                type="button"
                className={`pp-scheme-row${helpOpen ? ' open' : ''}`}
                aria-expanded={helpOpen}
                data-tip="快捷键总览"
                onClick={() => setHelpOpen((v) => !v)}
              >
                <span className="pp-scheme-k">律</span>
                <span className="pp-scheme-v">{helpOpen ? '收起' : '快捷键总览'}</span>
              </button>
              {helpOpen && (
                <section className="pp-help-inline" aria-label="快捷键总览">
                  {HELP_GROUPS.map((g) => (
                    <div key={g.title} className="pp-help-group">
                      <div className="pp-help-group-title">{g.title}</div>
                      {g.rows.map(([key, desc]) => (
                        <div key={key} className="pp-help-row">
                          <span className="pp-help-key">{key}</span>
                          <span className="pp-help-desc">{desc}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </section>
              )}
            </div>
          </div>
        )}
        {attachedFiles.length > 0 && (
          <div className="pp-attach-list">
            {attachedFiles.map((f, i) => (
              <button
                key={f.path}
                type="button"
                className="pp-attach-chip"
                data-tip={f.path}
                data-tip-hint="点击移除"
                onClick={() => onRemoveAttached(i)}
              >
                {f.name} ✕
              </button>
            ))}
            {attachedFiles.length > 3 && <span className="pp-attach-count">共 {attachedFiles.length} 件</span>}
          </div>
        )}
        {/* 附图 rail（B2 multimodal-image-plan）：缩略图 + 移除 + 点击放大。
            预览 URL 为进程内存态（准入时种——seedPreviewUrl），未命中降级为占位盒。 */}
        {attachedImages.length > 0 && (
          <div className="pp-image-rail">
            {attachedImages.map((img, i) => {
              const url = previewUrlFor(img.id);
              return (
                <div key={img.id} className="pp-image-thumb-wrap">
                  <button
                    type="button"
                    className="pp-image-thumb"
                    data-tip={img.name ?? '附图'}
                    aria-label={`预览附图：${img.name ?? img.id.slice(0, 8)}`}
                    onClick={() => setImagePreview(img)}
                  >
                    {url ? (
                      <img src={url} alt={img.name ?? '附图'} loading="lazy" />
                    ) : (
                      <span className="pp-image-thumb-fallback">{img.name ?? img.id.slice(0, 8)}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="pp-image-remove"
                    data-tip="移除附图"
                    data-tip-hint={img.name ?? undefined}
                    aria-label={`移除附图 ${i + 1}`}
                    onClick={() => onRemoveAttachedImage(i)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {attachedImages.length > 1 && <span className="pp-attach-count">共 {attachedImages.length} 图</span>}
          </div>
        )}
        {running && !inputText.trim() ? (
          <button
            type="button"
            className="pp-stop"
            data-tip="停止当前回合"
            data-tip-hint="级联停止子 Agent"
            aria-label="停止"
            onClick={() => core?.abort()}
          >
            停
          </button>
        ) : (
          <button
            type="button"
            className="pp-send"
            disabled={!inputText.trim()}
            data-tip={running ? '插入回合' : inputText.trim() ? '发送本轮输入' : '先落笔'}
            data-tip-hint={running ? 'Agent 运行中，下轮生效' : inputText.trim() ? undefined : '有内容才可拟文'}
            onClick={onSend}
          >
            拟文
          </button>
        )}
      </div>

      {/* 设置行（2026-11-09 用户裁定：模型与权限**另起一行**；同日再裁：**权限在左、模型在右**）
          ——只放两件，它们同属「这一趟怎么跑」，与书眉的「这一卷的账」分家。
          位置对调（2026-11-09 二次裁定）：**权限居左、模型收右**。
          判据：权限是**底线**（全放/半放/常询决定 Agent 能做什么），先读它；模型是这一行的
          长值，收右端与书眉的读数对齐（右缘同一条线），行左留给"这一趟的闸"。
          行内仍走 §11 锚点型选中（权限 = 重墨 + 朱砂底线），不新增第三种语言。 */}
      <div className="pp-composer-settings">
        <fieldset className="pp-mode-seg" aria-label="权限模式">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`pp-mode-opt${permissionMode === m ? ' selected' : ''}`}
              data-tip={MODE_DESCRIPTIONS[m]}
              aria-pressed={permissionMode === m}
              onClick={() => selectMode(m)}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </fieldset>
        <div className="pp-composer-settings-spacer" />
        <ModelSelector
          value={model}
          onChange={onModelChange}
          providerName={providerName}
          kind={providerKind}
          compact
          isStreaming={running}
          onBlocked={() => notice('Agent 正在运行——本回合结束后才能切换模型。', 'warn')}
          thinking={thinkingSeat}
        />
      </div>

      {/* 历史眉批（一次性，6s 自散）：提示长在功能所在处，不常驻占位符 */}
      {histHint && <div className="pp-eyebrow-hint">↑ 可回取上文 · ↓ 返回草稿</div>}

      {/* 目标状态条（2026-10-23 DSH 式目标域）：有目标才出现；暂停/恢复/清除走同一命令面 */}
      <GoalStrip core={core} />

      {/* rework P2-3 / P0-1：全放二次确认 = 独立居中模态（不内嵌创作坞，避免高度/关窗竞态）
          ——同附图预览：坞槽带 transform（版心居中）⇒ 就地渲染的 `position: fixed`
          后代被关进坞的盒子里（遮罩只有坞那么大、点坞外收不回），归位为 portal 全局模态。 */}
      {pendingYolo &&
        createPortal(
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
          </div>,
          document.body,
        )}
    </div>
  );
});

/** 目标状态条 —— 有目标才渲染（无目标零占位）。数据源 = panel-store.goalView
 *  （chat-core 在命令 / 轮次收尾 / 切卷时刷新）；控制动作走同一 `/goal` 命令面，
 *  不新造第二条写路径。 */
function GoalStrip({ core }: { core: ChatCore | null }) {
  if (!core) return null;
  return <GoalStripLive core={core} />;
}

function GoalStripLive({ core }: { core: ChatCore }) {
  const panel = getChatStore(core.panelId).panel;
  const goal = useSyncExternalStore(
    panel.subscribe,
    () => panel.getState().goalView,
    () => null,
  );
  if (!goal) return null;
  const run = (arg: string) => {
    const cmd = core.builtinCommands().find((c) => c.id === 'goal');
    if (cmd) core.executeCommand(cmd, arg);
  };
  const phase =
    goal.phase === 'active'
      ? '进行中'
      : goal.phase === 'paused'
        ? '已暂停'
        : goal.phase === 'blocked'
          ? '已受阻'
          : '已完成';
  return (
    <div className="pp-goal-strip" role="status" aria-live="polite">
      <span className="pp-goal-strip__mark" aria-hidden="true">
        🎯
      </span>
      <span className="pp-goal-strip__text" data-tip={goal.objective}>
        {goal.objective}
      </span>
      <span className="pp-goal-strip__meta">
        {phase} · 第 {goal.roundsStarted}/{goal.maxGoalRounds} 轮
        {goal.phase === 'active' && goal.activation === 'disarmed' ? ' · 续行已停' : ''}
      </span>
      {goal.phase === 'active' && goal.activation === 'armed' && (
        <button type="button" className="pp-goal-strip__btn" onClick={() => run('pause')}>
          暂停
        </button>
      )}
      {(goal.phase === 'paused' || goal.phase === 'blocked') && (
        <button type="button" className="pp-goal-strip__btn" onClick={() => run('resume')}>
          继续
        </button>
      )}
      {goal.phase !== 'complete' && (
        <button type="button" className="pp-goal-strip__btn pp-goal-strip__btn--quiet" onClick={() => run('clear')}>
          清除
        </button>
      )}
    </div>
  );
}
