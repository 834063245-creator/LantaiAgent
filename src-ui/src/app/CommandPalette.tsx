// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 全局搜索（Ctrl+K）——2026-11-28 由「命令面板」升级。
//
// 为什么升级（用户 2026-11-28 问「命令面板真的有用吗」）：旧面板的清单实测 ~14 条，
// 九成是别处已有更快入口的东西（侧栏钮 / Ctrl+P / Ctrl+, / 输入框打 / 就地出的斜杠面板），
// 于是它既不是发现面也不是效率面。但它指着一个真需求没人管：**卷多了以后「上次那个
// 话题是哪一卷」找不到**。⇒ 一框搜四类，选中即跳或即做：
//
//   卷    搜卷名 / 卷号 → 已摊开 = 切过去，未摊开 = 摊开并定位（与侧栏、案头签条同一手势
//         = activeSpace().expand，不新造跳转面）
//   命令  原有三源原样（内置动作 + ctx.commands 贡献 + 会话内建/技能命令）
//   设置  八个页签（settings-domain 贡献为 settings/tab/* 命令，无 slash ⇒ 不进斜杠面板）
//         选中 = 打开设置并落到那一页（一次性请求位在 shell-store）
//   文件  工作区文件（与坞内「引」同一把匹配尺子 = app/search/file-match）
//         选中 = 加进当前卷（ChatCore.attachIntakePaths，与「引」同一条路）
//
// 三条成本纪律（打开手感 = 零扫盘）：
//   ① 空查询只列命令（不读卷表、不扫文件）；
//   ② 卷表在首次非空查询时读一次（listSavedSessions，与案头签条同一调用）；
//   ③ 文件扫描要查询 ≥2 字，且**每次打开最多扫一次**（结果缓存到关闭为止）。
//
// 分组与上限（数值可调，但每一组都必须有上限——面板不许滚成瀑布）：
//   卷 5 / 设置 3 / 文件 5 / 其余组 8，总计 20。
//
// 键盘/焦点/外点关闭一律沿用既有原语（mountDialogFocus / useOutsideClose），不另起炉灶。

import { useEffect, useMemo, useRef, useState } from 'react';
import { activeCommandContributions } from '../composition/services';
import { activeSpace } from '../composition/space-service';
import { kernelListDirectory } from '../rpc-contract';
import { shellRefs } from '../shell/runtime';
import { usePanelDefsStore } from '../state/panel-defs-store';
import { volumeDisplayName } from '../state/volume-name';
import { getChatStore } from '../ui/chat-store';
import { type AppAction, listActions } from './actions';
import { mountDialogFocus } from './dialog-focus';
import { Icon } from './Icon';
import { useOutsideClose } from './overlay';
import { flattenDirEntries, fuzzyMatchFiles } from './search/file-match';
import { useShellStore } from './shell-store';

/** 设置页签贡献的 id 前缀（settings-domain 侧同源约定；空查询时这组不占屏）。 */
const SETTINGS_TAB_PREFIX = 'settings/tab/';

/** 每组上限（未在册的组用 DEFAULT_CAP）。 */
const FILE_CAP = 5;
const GROUP_CAP: Record<string, number> = { 卷: 5, 设置: 3, 文件: FILE_CAP };
const DEFAULT_CAP = 8;
/** 全表上限（面板不滚成瀑布）。 */
const TOTAL_CAP = 20;
/** 文件组要查询满几个字才扫盘（空/单字仍在打字中，扫了也白扫）。 */
const FILE_SCAN_MIN_CHARS = 2;

/** 一行搜索结果——命令 / 卷 / 设置页签 / 文件统一成这一种形状（渲染与键盘只认它）。 */
interface PaletteRow {
  id: string;
  group: string;
  label: string;
  /** 右端补充说明（「已摊开」「未摊开」、文件路径等）。 */
  hint?: string;
  kbd?: string;
  icon?: string;
  /** 不可用原因（行变灰、不执行；写了原因就必须看得见）。 */
  blocked?: string;
  run: () => void;
}

/** 卷行（磁盘清单 + 是否已摊开）。 */
interface VolumeRow {
  id: number;
  label: string;
  open: boolean;
}

/** 命令贡献 → AppAction 折算（'plugin/<id>' 命名空间防撞内置动作 id）。 */
function commandContributionActions(): AppAction[] {
  const out: AppAction[] = [];
  for (const c of activeCommandContributions()) {
    if (c == null || typeof c.id !== 'string' || c.id === '' || typeof c.label !== 'string' || c.action == null) {
      continue; // 无效贡献跳过（插件代码不受编译期类型约束；action 缺失会在执行面崩）
    }
    const contribution = c;
    out.push({
      id: 'plugin/' + c.id,
      group: c.group || '插件',
      label: c.label,
      icon: undefined,
      kbd: c.kbd || c.slash || undefined,
      run: (arg) => {
        // 带参命令（takesArg）= 填入「/cmd 」待编辑，不空参执行（与斜杠面板同一条规矩）
        if (contribution.takesArg) {
          shellRefs.chatPanel?.prepareCommand(contribution);
          return;
        }
        // 折算为 local handler 型 AppAction：run 调用贡献的执行面（§2.3）。
        // local → 直接调 handler；send/fill/skill → 经聊天面板的命令执行面
        //（executeCommand 四型全语义：清输入/聚焦/发文本）。
        if (contribution.action.type === 'local') {
          contribution.action.handler(arg ?? '');
          return;
        }
        const panel = shellRefs.chatPanel;
        if (panel) {
          panel.executeCommand(contribution, arg ?? '');
        } else {
          console.warn('[palette] 无聊天面板承接命令贡献（send/fill/skill 型）:', contribution.id);
        }
      },
    });
  }
  return out;
}

/** 会话内建命令 → AppAction 折算（与斜杠面板同一清单、同一执行面）。 */
function sessionCommandActions(): AppAction[] {
  const panel = shellRefs.chatPanel;
  if (!panel) return [];
  return panel.builtinCommands().map((c) => ({
    id: 'session/' + c.id,
    group: c.group,
    label: c.label,
    kbd: c.slash ?? c.kbd,
    // 带参命令（takesArg）选中 = 填入待编辑；无参命令照旧直接执行
    run: (arg) => (c.takesArg ? panel.prepareCommand(c) : panel.executeCommand(c, arg ?? '')),
  }));
}

/** 一组行按组上限与全表上限截断（顺序 = 出现序：卷 → 命令 → 设置 → 文件）。 */
function capRows(rows: readonly PaletteRow[]): PaletteRow[] {
  const perGroup = new Map<string, number>();
  const out: PaletteRow[] = [];
  for (const r of rows) {
    const used = perGroup.get(r.group) ?? 0;
    if (used >= (GROUP_CAP[r.group] ?? DEFAULT_CAP)) continue;
    perGroup.set(r.group, used + 1);
    out.push(r);
    if (out.length >= TOTAL_CAP) break;
  }
  return out;
}

export function CommandPalette() {
  const open = useShellStore((s) => s.paletteOpen);
  const setOpen = useShellStore((s) => s.setPaletteOpen);
  const projectPath = useShellStore((s) => s.projectPath);
  const commandsTick = usePanelDefsStore((s) => s.commandsTick);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0); // 动作在 init 期间注入 — 打开时重取列表
  /** 卷表（null = 还没读；读失败 → 空表 + volError）。每次打开清一次。 */
  const [volumes, setVolumes] = useState<VolumeRow[] | null>(null);
  const [volError, setVolError] = useState<string | null>(null);
  /** 工作区文件清单（null = 还没扫；每次打开最多扫一次）。 */
  const [files, setFiles] = useState<Array<{ path: string; name: string }> | null>(null);
  const volLoading = useRef(false);
  const fileLoading = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  void commandsTick; // 贡献变更信号——长驻打开态也重取清单（S4-1.5）

  const q = query.trim().toLowerCase();

  // 打开：清查询 + 焦点入面板 + Tab 圈定 + 关闭归还打开者 + 清本次打开的数据缓存
  // （「每次打开最多扫一次」的那两个 null 就在这儿复位）。
  useEffect(() => {
    if (!open || !boxRef.current) return;
    setQuery('');
    setActive(0);
    setTick((t) => t + 1);
    setVolumes(null);
    setVolError(null);
    setFiles(null);
    volLoading.current = false;
    fileLoading.current = false;
    return mountDialogFocus(boxRef.current, { initial: inputRef.current });
  }, [open]);

  // 点击面板外关闭（2026-11-17 交互原语收口批 A：收进 overlay.tsx 的 useOutsideClose，
  // 与 Escape 同门——同一次「点空白」不再有第二个半场）
  useOutsideClose(boxRef, () => setOpen(false), { enabled: open });

  /** 卷表：首次非空查询读一次（空查询零成本——打开面板不读盘）。 */
  useEffect(() => {
    if (!open || q === '' || volumes !== null || volLoading.current) return;
    const core = shellRefs.chatPanel;
    if (!core || !projectPath) {
      setVolumes([]);
      return;
    }
    volLoading.current = true;
    let alive = true;
    void core
      .listSavedSessions(projectPath)
      .then((rows) => {
        if (!alive) return;
        const openIds = new Set(
          getChatStore(core.panelId)
            .sess.getState()
            .sessions.map((s) => s.id),
        );
        const sorted = [...rows].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
        setVolumes(sorted.map((r) => ({ id: r.id, label: r.label, open: openIds.has(r.id) })));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // 读不出来就**说清楚**（不静默吞）：卷这一组整体消失 + 一行可见原因
        setVolumes([]);
        setVolError(`卷表读不出：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        volLoading.current = false;
      });
    return () => {
      alive = false;
    };
  }, [open, q, volumes, projectPath]);

  /** 文件清单：查询 ≥2 字才扫，每次打开最多一次（复用「引」的 Rust 护栏：深 3 / 2000 项 / ignore）。 */
  useEffect(() => {
    if (!open || q.length < FILE_SCAN_MIN_CHARS || files !== null || fileLoading.current) return;
    if (!projectPath) {
      setFiles([]);
      return;
    }
    fileLoading.current = true;
    let alive = true;
    void kernelListDirectory(projectPath, true)
      .then((entries) => {
        if (alive) setFiles(flattenDirEntries(entries));
      })
      .catch(() => {
        // 扫不出来 = 该组整体不出现（此刻的失败多半是工作区刚切换/无权限；文件组是附加能力，
        // 用户可在坞内「引」面板重试——不在这里多挂一行错误，免得搜索框变成报错区）
        if (alive) setFiles([]);
      })
      .finally(() => {
        fileLoading.current = false;
      });
    return () => {
      alive = false;
    };
  }, [open, q, files, projectPath]);

  const rows = useMemo(() => {
    void tick;
    void commandsTick;
    const out: PaletteRow[] = [];
    const panel = shellRefs.chatPanel;
    const panelState = panel ? getChatStore(panel.panelId).sess.getState() : null;

    /* ── ① 卷：搜卷名 / 卷号（「案卷 3」「3」都算）── */
    if (q !== '' && volumes) {
      for (const v of volumes) {
        const name = volumeDisplayName(v.label, v.id).toLowerCase();
        if (!name.includes(q) && !String(v.id).includes(q)) continue;
        out.push({
          id: `vol/${v.id}`,
          group: '卷',
          label: volumeDisplayName(v.label, v.id),
          hint: v.open ? '已摊开' : '未摊开',
          icon: 'file',
          run: () => {
            if (!panel || !panelState) return;
            const idx = panelState.sessions.findIndex((s) => s.id === v.id);
            if (idx >= 0) {
              panel.switchSession(idx);
              return;
            }
            // 未摊开：走空间命令（「摊开 + 定位」的单一权威入口，调用方不得自己补 requestFocus）
            activeSpace()?.expand(String(v.id));
          },
        });
      }
    }

    /* ── ② 命令（设置页签在空查询时让位——它们改的是设置，不是"打开就会用"的动作）── */
    const commandActions = [...listActions(), ...sessionCommandActions(), ...commandContributionActions()];
    for (const a of commandActions) {
      const isSettingsTab = a.id.includes(SETTINGS_TAB_PREFIX);
      if (isSettingsTab && q === '') continue;
      if (q !== '' && !a.label.toLowerCase().includes(q) && !a.id.includes(q)) continue;
      out.push({
        id: a.id,
        group: a.group,
        label: a.label,
        kbd: a.kbd,
        icon: a.icon,
        run: () => a.run(),
      });
    }

    /* ── ③ 文件：与「引」同一把尺子（子序列命中 + basename 加权）── */
    if (files && files.length > 0 && q.length >= FILE_SCAN_MIN_CHARS) {
      const hasVolume = (panelState?.sessions.length ?? 0) > 0;
      for (const f of fuzzyMatchFiles(files, q, FILE_CAP)) {
        out.push({
          id: `file/${f.path}`,
          group: '文件',
          label: f.name,
          hint: f.path,
          icon: 'folder-open',
          blocked: hasVolume ? undefined : '先开一张卷（画布空白处按「＋ 另起一卷」）',
          run: () => {
            if (!panel || !hasVolume) return;
            void panel.attachIntakePaths([f.path]);
          },
        });
      }
    }

    if (volError) {
      out.push({
        id: 'vol/error',
        group: '卷',
        label: volError,
        blocked: volError,
        run: () => {},
      });
    }
    return capRows(out);
  }, [q, tick, commandsTick, volumes, files, volError]);

  if (!open) return null;

  const run = (a: PaletteRow | undefined) => {
    if (a?.blocked) return; // 不可用的行不执行（原因已在行上写着）
    setOpen(false);
    a?.run();
  };

  /* 分组：同名组相邻合并（跨来源可能同组名——2026-08 UI 大清扫：原先相邻分组会导致
   * 「操作」组出现两次）。 */
  const groupMap = new Map<string, Array<{ a: PaletteRow; idx: number }>>();
  rows.forEach((a, idx) => {
    const list = groupMap.get(a.group) ?? [];
    list.push({ a, idx });
    groupMap.set(a.group, list);
  });
  const groups = [...groupMap.entries()].map(([g, items]) => ({ g, items }));

  return (
    <div className="pal-veil" role="presentation">
      <div className="pal-box" role="dialog" aria-label="全局搜索" ref={boxRef}>
        <div className="pal-input">
          <span className="pal-prompt">❯</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="搜卷、命令、设置、文件…"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls="pal-listbox"
            aria-activedescendant={rows.length > 0 ? `pal-opt-${active}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((v) => Math.min(v + 1, rows.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((v) => Math.max(v - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(rows[active]);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
        </div>
        <div className="pal-list" role="listbox" id="pal-listbox" aria-label="搜索结果">
          {rows.length === 0 ? (
            <div className="pal-group" role="presentation">
              {q === '' ? '无命令' : '无匹配'}
            </div>
          ) : null}
          {groups.map((g) => (
            <div key={g.g} role="presentation">
              <div className="pal-group" role="presentation">
                {g.g}
              </div>
              {g.items.map(({ a, idx }) => (
                <button
                  key={a.id}
                  type="button"
                  id={`pal-opt-${idx}`}
                  role="option"
                  aria-selected={idx === active}
                  aria-disabled={a.blocked ? true : undefined}
                  disabled={a.blocked ? true : undefined}
                  className={`pal-row${idx === active ? ' active' : ''}${a.blocked ? ' blocked' : ''}`}
                  data-tip={a.blocked ?? a.hint}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => run(a)}
                >
                  {a.icon ? <Icon name={a.icon} /> : null}
                  <span className="pal-label">{a.label}</span>
                  {a.hint && !a.blocked ? <span className="pal-hint">{a.hint}</span> : null}
                  {a.kbd ? <kbd>{a.kbd}</kbd> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span>
            <kbd>ctrl</kbd>+<kbd>k</kbd> 或 esc 关闭
          </span>
          <span className="pal-foot-right">LANTAI SEARCH</span>
        </div>
      </div>
    </div>
  );
}
