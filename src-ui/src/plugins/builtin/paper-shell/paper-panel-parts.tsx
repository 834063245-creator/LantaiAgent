// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PaperPanel 的**表现件**（2026-11-06 上帝文件治理 P3：从 PaperPanel.tsx 拆出）。
// 文类签映射表 / ToolStatusChip / BlockView（单块渲染）/ folioSubLine / DeskShelf。
// 装配根只管接线与 JSX；这些件只吃 props，不碰会话与画布状态。

import { memo, useCallback, useEffect, useState } from 'react';
import { volumeDisplayName } from '../../../state/volume-name';
import { formatCNDate } from './folio-date';
import type { RegionView, SourcedBlock } from './host';
import {
  activeSpace,
  foldLabel,
  isFoldable,
  PluginBoundary,
  resolveAssetBlock,
  resolveRenderer,
  useShellStore,
} from './host';
import type { BlockOp } from './use-block-ops';
import { BRANCH_GRIP_TITLE } from './use-branch-drag';
import type { PaperCore } from './use-paper-sessions';

/* ── 文类签（页边注 rubric）：BlockKind → 注疏文类（docs/design/lantai-design-spec.md §4）── */

const KIND_ZH: Record<string, string> = {
  user: '来文',
  markdown: '正文',
  reasoning: '夹注',
  diff: '抄录',
  tool: '脚注',
  code: '程文',
  plan: '拟策',
  toolgroup: '工具组',
  subagent: '子代理',
  notice: '贴黄',
  'turn-error': '错因',
  // 资产 kind（WO-4 文类签）：未知名仍回退 block.kind 字面。
  table: '表格',
  chart: '图表',
  metric: '指标',
  file: '文件',
  deps_impact: '影响',
  html: '卡片',
  confirm: '确认',
  board: '看板',
  timeline: '时间轴',
  citation: '引用',
};
const KIND_EN: Record<string, string> = {
  user: 'USER',
  markdown: 'AGENT',
  reasoning: 'THINK',
  diff: 'CODE',
  tool: 'TOOL',
  code: 'CODE',
  plan: 'PLAN',
  toolgroup: 'TOOLS',
  subagent: 'SUBAGENT',
  notice: 'NOTE',
  'turn-error': 'FAULT',
  table: 'TABLE',
  chart: 'CHART',
  metric: 'METRIC',
  file: 'FILE',
  deps_impact: 'GRAPH',
  html: 'HTML',
  confirm: 'CONFIRM',
  board: 'BOARD',
  timeline: 'TIMELINE',
  citation: 'CITATION',
};

/** 工具/程文卡状态签（2026-09-06 纸面运行态）：running = 石青「行」+行走秒
 *  ——秒数读 part 起跑戳（startedAt，part-mutator 首转 running 落戳）现算，
 *  虚拟化卸挂不丢时长；无戳历史卡降级纯「行」。1s 心跳自持在本签——
 *  走秒只重渲这几颗字，不惊动块体。 */
export const ToolStatusChip = memo(function ToolStatusChip({
  status,
  startedAt,
}: {
  status: string;
  startedAt?: number;
}) {
  const running = status === 'running';
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  let label: string;
  if (!running) label = status;
  else if (startedAt == null) label = '行';
  else {
    const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    label = s < 60 ? `行 ${s}s` : `行 ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  }
  return <span className={`pp-status pp-${status}${running ? ' pp-status--live' : ''}`}>{label}</span>;
});

export const BlockView = memo(function BlockView({
  block,
  seq,
  ops,
  folded,
  sidecarFolded,
  onToggleFold,
  onToggleSidecarFold,
  onSidecarPinMouseDown,
  sidecarOut,
  onSidecarRestore,
  onUnpin,
  onDragHandleMouseDown,
  onBranchGripMouseDown,
  unpinLabel = '收回',
  prov,
  provTitle,
  provTraceable = false,
  onProvClick,
  sessionProjectPath,
  sessionId,
}: {
  block: SourcedBlock;
  /** 文类签机读序号（卷内流水号，三位补零） */
  seq: string;
  /** 消息操作（hover 浮现）——user 块编辑/重发，全部可抄录（施工单 #5） */
  ops: BlockOp[];
  /** 有效折叠态（壳层：用户覆盖 ?? paper/fold 默认规则）——夹注/脚注/程文消费 */
  folded: boolean;
  /** P5 眉批折叠态（夹注恒折拍板延续——复合 markdown 眉批默认收起） */
  sidecarFolded?: boolean;
  /** 折叠行点击（切换覆盖态） */
  onToggleFold: (b: SourcedBlock) => void;
  /** 眉批折叠切换（壳层 foldOv 持久，key = `${block.id}:sc`） */
  onToggleSidecarFold?: (b: SourcedBlock) => void;
  /** 眉批拖出钉画布（移出语义：首动建钉跟手，快照从眉批栏原位揭起） */
  onSidecarPinMouseDown?: (e: React.MouseEvent, block: SourcedBlock) => void;
  /** 眉批已钉出（`:sc` 快照钉在画布）——眉批栏渲染「已移出·点击恢复」占位 */
  sidecarOut?: boolean;
  /** 眉批恢复（拔 `:sc` 快照钉，夹注回眉批栏——占位点击手势的语义端） */
  onSidecarRestore?: (b: SourcedBlock) => void;
  onUnpin: (id: string) => void;
  /** 拖拽手柄（文类签 .pp-kind）——V3a 手势分工：签=整块拖出（D-R2-1） */
  onDragHandleMouseDown: (e: React.MouseEvent, block: SourcedBlock) => void;
  /** **空间手势立枝**（P4-①）：块 hover 出现的「枝」握把——按住拖出一条引线、松手落在
   *  纸上就地立枝。**只在可立枝的块上传**（判据 = `branchPoints`，与「立枝」按钮同一张
   *  表；见 `use-block-ops` 的 `branchGrips`）——缺省 = 不长握把（钉住块/通知块/未落定轮）。 */
  onBranchGripMouseDown?: (e: React.MouseEvent, block: SourcedBlock) => void;
  /** 孤儿钉按钮文案（2026-08-28 会话管理专项）：源卷已删 = 「删除」，否则「收回」 */
  unpinLabel?: string;
  /** 出处行文本（**仅钉住块**，paper/provenance.provenanceText 产出）——页边注
   *  第三行：常显的「从哪来」，不依赖任何视口内目标（引线是 hover 期的空间面）。 */
  prov?: string;
  /** 出处行 hover 说明（provenanceTitle 产出）。 */
  provTitle?: string;
  /** 出处行可点（未删卷）；false = 只读注记（已删卷不发起必落空的定位）。 */
  provTraceable?: boolean;
  /** 出处行点击（A 溯源手势）：参数 = 本块 id（钉 id 与块 id 同空间）。
   *  **传稳定回调 + 由本组件回传 id**——调用点若传内联箭头会击穿 memo
   *  （平移/流式帧全块重渲，§1.9 性能纪律）。 */
  onProvClick?: (id: string) => void;
  /** 状态桥定位（2026-10-07 asset-state）：原样递给块体渲染器——HtmlBody 的沙箱卡
   *  存盘口据此定位 `.lantai/asset-state/<sessionId>.json`（其他渲染器不用可忽略）。 */
  sessionProjectPath?: string;
  sessionId?: string;
}) {
  const p = block.payload;
  const Body = block.asset
    ? resolveAssetBlock(block.kind, block.asset.presentation)
    : resolveRenderer(block.kind)?.component;
  const foldable = isFoldable(block.kind, block);
  /* 折叠行在跑呼吸（2026-09-06 纸面运行态）：被收起的运行中卡片/组头——行内
   * 已有「N 在跑」字样（foldLabel），再给整行石青呼吸让静止的折叠行活
   * 起来。在跑口径与 foldLabel 对齐：running + pending。 */
  const foldBusy =
    foldable &&
    folded &&
    (block.kind === 'tool' || block.kind === 'code'
      ? (p as { status?: string }).status === 'running'
      : block.kind === 'toolgroup' || block.kind === 'subagent'
        ? (block.kind === 'subagent' && (p as { status?: string }).status === 'running') ||
          ((p as { items?: Array<{ status?: string }> }).items ?? []).some(
            (it) => it.status === 'running' || it.status === 'pending',
          )
        : false);
  return (
    <>
      {/* 锚点（2026-09-22 锚点批）：块的**左右缘各一枚圆点**——引线两端的落点，
          高度 = 块顶下 TETHER_ANCHOR_DY（= 文类签 hairline 那一档）。**不常显**：
          进入块才显形（用户判「专门加的锚点圆点没必要常显」），走 --ink-4；
          被引线连上时由引线层自己的朱点标出位置。见 CSS .pp-anchor 注。 */}
      <span className="pp-anchor pp-anchor--l" aria-hidden="true" />
      <span className="pp-anchor pp-anchor--r" aria-hidden="true" />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖拽手柄（D-R2-1 拖出钉住）；收回有原生按钮 */}
      <div className="pp-kind pp-drag-handle" onMouseDown={(e) => onDragHandleMouseDown(e, block)}>
        <span className="pp-zh">{KIND_ZH[block.kind] ?? block.kind}</span>
        <span className="pp-en">
          {KIND_EN[block.kind] ?? 'NOTE'} · {seq}
        </span>
        {(block.kind === 'tool' || block.kind === 'code') && (
          <ToolStatusChip
            status={(p as { status: string }).status}
            startedAt={(p as { startedAt?: number }).startedAt}
          />
        )}
        {/* 出处行（2026-09-18 出处引导批）：页边注第三行——「摘自 卷名」常显，
            点行溯源。mousedown 停传：页边注是拖拽把手（整块拖出），而出处行是
            行内的点击件——不停传则「点一下」变成「起拖」（松手无位移才回到
            点击，手感与语义都不对）。 */}
        {prov !== undefined && (
          <button
            type="button"
            className={`pp-prov${provTraceable ? ' pp-prov--trace' : ''}`}
            data-tip={provTitle}
            aria-disabled={!provTraceable}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (provTraceable) onProvClick?.(block.id);
            }}
          >
            {prov}
          </button>
        )}
      </div>
      {foldable && (
        <button
          type="button"
          className={`pp-fold${foldBusy ? ' pp-fold--busy' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFold(block);
          }}
        >
          {foldLabel(block.kind, p, folded, block)}
        </button>
      )}
      {Body && !(block.asset != null && folded) ? (
        /* 保险丝 b（2026-09-03）：块渲染器（内置 + 资产/插件贡献面）包边界——
         * 单块渲染崩溃只死该块，纸壳与整树永生。
         * 资产块折叠态（2026-09-23 图版架批；2026-10-08 默认态翻成张开后，本分支
         * 专供**用户手动收起**的卡）：**不渲染块体**——折叠行即本体，与脚注族
         * `ToolBody` 的 `if (folded) return null` 同一条语义，只是收在壳层这一层做
         * （资产表现原语十二款各写一遍折叠判断＝十二份重复；这里一处收全）。测高侧同源：
         * `measureBlockHeight` 的资产折叠分支返回 FOLD_ROW_H。 */
        <PluginBoundary label={`块 ${block.kind}`}>
          <Body
            block={block}
            folded={folded}
            sidecarFolded={sidecarFolded}
            onToggleSidecarFold={onToggleSidecarFold}
            onSidecarPinMouseDown={onSidecarPinMouseDown}
            sidecarOut={sidecarOut}
            onSidecarRestore={onSidecarRestore}
            sessionProjectPath={sessionProjectPath}
            sessionId={sessionId}
          />
        </PluginBoundary>
      ) : (
        <div className="pp-body">{(p as { text?: string }).text ?? ''}</div>
      )}
      {(ops.length > 0 || onBranchGripMouseDown) && (
        <div className="pp-msg-ops">
          {ops.map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={o.disabled}
              data-tip={o.title}
              onClick={(e) => {
                e.stopPropagation();
                if (o.disabled) return;
                o.run();
              }}
            >
              {o.label}
            </button>
          ))}
          {/* 空间手势立枝的握把（P4-①，2026-09-19 → 2026-09-20 造型批并入本行行尾）：
              按住拖出一条引线、松手落在纸上就地立枝。旧形态是块右端一枚独立「枝」方框
              ——一个动作两个词、两处落位；并进行盒后只剩**六点握把**（CSS 画的点，
              字形无关），语义落在 title 上。在块体之外/之内不再有别：行盒在块外的块
              （非来文块）行本身就是那条悬空腿。只在可立枝的块上出现（判据与按钮同表）。 */}
          {onBranchGripMouseDown && (
            // biome-ignore lint/a11y/noStaticElementInteractions: 拖拽握把（拖出立枝）；立枝本身另有按钮入口（键盘路径 = 行内那颗「立枝」）
            <div
              className="pp-branch-grip"
              data-tip={BRANCH_GRIP_TITLE}
              onMouseDown={(e) => onBranchGripMouseDown(e, block)}
            />
          )}
        </div>
      )}
      {block.state === 'pinned' && (
        <button
          type="button"
          className="pp-unpin"
          data-tip={unpinLabel === '删除' ? '删除孤儿钉（源卷已删，无法收回）' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onUnpin(block.id);
          }}
        >
          {unpinLabel}
        </button>
      )}
    </>
  );
});

/* ── 主组件 ── */

/** 稳定空引用——无会话/无钉住时避免无谓重渲染 */
export const EMPTY_OPS: BlockOp[] = [];

/** 卷首档行（2026-09-16 版心天头重排）：`立卷日 · N 块`。
 *  立卷日取自卷级 createdAt（真源 = 卷日志头行，见 state/session-store
 *  ChatSessionMeta.createdAt）；**旧卷无此字段 = 只显块数**，不编造日期。
 *  重排前档行是「案卷 #N · M 块」——卷号与眉行重复，且原型原有的日期在移植时
 *  丢了（当时 RegionView 根本拿不到时间字段）。 */
export function folioSubLine(r: RegionView): string {
  const date = formatCNDate(r.createdAt);
  return date ? `${date} · ${r.blocks.length} 块` : `${r.blocks.length} 块`;
}

/* ── 案头签条架（创作坞 v2 2026-08-31）──
 * 空态三件套之一：最近三卷「续写」签条（手迹位批注字，hover 朱砂——样式见
 * .pp-desk-shelf）。数据 = listSavedSessions（savedAt 倒序取三）；点击 =
 * activeSpace().expand 摊开 + requestFocus 定位（SessionSidebar 同款手势）。
 * 只在案头态（零摊开卷）渲染；无已存卷/无工作区 = 架空。 */
export function DeskShelf({ core }: { core: PaperCore | null }) {
  const [recent, setRecent] = useState<Array<{ id: number; label: string }>>([]);
  // 工作区路径（响应式）：进入画布时 projectPath 晚于本组件挂载——路径变化必须重拉
  // （SessionSidebar P4-1 同款教训）
  const projectPath = useShellStore((s) => s.projectPath);
  useEffect(() => {
    if (!core || !projectPath) {
      setRecent([]);
      return;
    }
    let alive = true;
    void core
      .listSavedSessions(projectPath)
      .then((rows) => {
        if (!alive) return;
        const sorted = [...rows].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)).slice(0, 3);
        setRecent(sorted.map((r) => ({ id: r.id, label: volumeDisplayName(r.label, r.id) })));
      })
      .catch(() => {
        if (alive) setRecent([]);
      });
    return () => {
      alive = false;
    };
  }, [core, projectPath]);
  /** 续写签条：expand 自带定位（读盘成功才 requestFocus——签条来自磁盘列表，
   *  点它时卷可能已被删；失败不留悬空定位请求，2026-09-10 收口）。 */
  const onResume = useCallback((sid: string) => {
    activeSpace()?.expand(sid);
  }, []);
  if (recent.length === 0) return null;
  return (
    <div className="pp-desk-shelf">
      {recent.map((r) => (
        <button
          key={r.id}
          type="button"
          className="pp-desk-tag"
          data-tip={`续写「${r.label}」——摊开并定位`}
          onClick={() => onResume(String(r.id))}
        >
          续 · {r.label}
        </button>
      ))}
    </div>
  );
}
