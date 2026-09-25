// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 墨量册 — 创作坞的 token 计量装置（2026-09-13）。
//
// 落位理由（为什么在坞里，而不是新开面板）：坞是「配置+输入」的家，用量是
// 落笔前最该看的读数（还有多少上下文能喂）——DSH 同判，把上下文表放在
// 输入条旁（ContextMeter 环）而不是独立页。坞底那条 1px 墨量线继续承担
// 环境指示（余光可见），本册是它的展开面：点开看账。
//
// 排印（2026-09-13 二版：一版是 13 行等重小字的设置表单面孔，被用户打回
// 「不好看」——重排为**册页**：一屏之内只许一处读数当题字，其余按
// 题字 → 副行 → 条 → 图例 → 段（方墨锚点 + 字距段题 + 账目竖排对齐）分层）：
//   - 读数（percent）= 全册唯一题字（26px/700），近满转朱砂（句读点朱，
//     每屏至多一处红字）；
//   - 副行承载「分子/分母 + 下一请求预计」——数字 mono、语词小字距；
//   - 账目 = dt/dd 两列 grid + **数值右对齐**（账本竖排对齐，读竖列不读横排）；
//   - 段题复刻首页节题语言：11px 实心方墨锚点 + 字距段题（浸墨⑤ 完工动作）。
//
// 口径（全部出自 agent/token-meter，真源 = Agent 侧每卷账本）：
//   - 上下文已用 = 投影占用（提供方回报的压力 + 采样后载荷增量）÷ 模型窗口；
//     「估」= 尚无服务商回报，分子是本地分词器估算；
//   - 构成三段（系统提示 / 工具 schema / 对话）是**估算构成**，不是账单；
//   - 账目四桶来自服务商回报，未缓存/缓存读/缓存写互不重叠；
//   - 逐轮用量按「一次用户输入 = 一轮」分组。

import { memo } from 'react';
// §4-6 A（2026-09-26）：读数类型取内核契约面、分桶代数取内核唯一实例（本包宿主桥）——
// 此前直接从 `agent/token-meter/{types,usage}` import：产物构建期会把代数内联成第二份
// 副本（口径单点被撕开），且「产品 import 内核实现文件」正是归家账上的欠账形态。
import { type TokenMeasurement, tokenAlgebra } from './host';

/** 构成三段的墨阶（浓 → 淡；纸墨体系只有墨，不引第三色）。 */
const SEGMENTS = [
  { key: 'systemTokens', label: '系统', title: '系统提示', cls: 'pp-ink-seg-system' },
  { key: 'toolsTokens', label: '工具', title: '工具 schema', cls: 'pp-ink-seg-tools' },
  { key: 'messageTokens', label: '对话', title: '对话消息', cls: 'pp-ink-seg-messages' },
] as const;

export interface InkLedgerProps {
  /** 本卷计量读数（无活跃卷/无句柄时 null）。 */
  stats: TokenMeasurement | null;
  /** 卷名（册书眉）。 */
  sessionLabel: string;
  /** 无句柄时的累计总量兜底（卷文件 tokensUsed 的旧值）。 */
  fallbackTotal?: number;
  open: boolean;
  onToggle: () => void;
}

/** 触发器文案：有窗口就报占用百分比，否则只报账本有无。 */
function triggerLabel(stats: TokenMeasurement | null): string {
  if (stats?.percent !== undefined) return `${stats.percent}%`;
  if (stats && stats.attempts > 0) return '有账';
  return '—';
}

/** 段题（复刻首页节题：方墨锚点 + 字距题字）。 */
function Section({ title }: { title: string }) {
  return (
    <div className="pp-ink-section">
      <span className="pp-ink-section-mark" aria-hidden="true" />
      <span className="pp-ink-section-title">{title}</span>
    </div>
  );
}

/** 账目行（dt 左、dd 右——数值竖排对齐是账本读法）。 */
function Line({ label, value, strong, title }: { label: string; value: string; strong?: boolean; title?: string }) {
  return (
    <div className={`pp-ink-line${strong ? ' strong' : ''}`} title={title}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * 墨量册（触发器 + 展开面板）。坞内使用：trigger 在设置行右端，
 * 面板向上开（坞贴屏底，向下没有空间）。
 */
export const InkLedger = memo(function InkLedger({
  stats,
  sessionLabel,
  fallbackTotal = 0,
  open,
  onToggle,
}: InkLedgerProps) {
  const percent = stats?.percent;
  const window = stats?.contextWindow;
  const used = stats?.usedTokens;
  const estimated = stats?.usedSource === 'surface';
  const totals = stats?.totals;
  const grandTotal =
    totals !== undefined && totals.outputTokens + tokenAlgebra.billedInputTokens(totals) > 0
      ? tokenAlgebra.totalTokens(totals)
      : 0;
  const shownTotal = grandTotal > 0 ? grandTotal : fallbackTotal;
  const lastTurn = stats?.turns[stats.turns.length - 1];
  const breakdown = stats?.breakdown;
  const breakdownTotal = breakdown ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens : 0;
  const nearFull = percent !== undefined && percent > 80;

  return (
    <div className="pp-ink-sel">
      <button
        type="button"
        className={`pp-ink-trigger${open ? ' open' : ''}${nearFull ? ' full' : ''}`}
        title={
          percent === undefined
            ? '墨量册——本卷 token 账（尚无占用读数）'
            : `墨量册——上下文已用 ${percent}%${estimated ? '（估算）' : ''}`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="pp-ink-trigger-dot" aria-hidden="true" />
        <span className="pp-ink-trigger-label">墨 {triggerLabel(stats)}</span>
      </button>

      {open && (
        <div className="pp-ink-panel" role="dialog" aria-label="墨量册">
          <div className="pp-ink-head">
            <span className="pp-ink-head-title">墨量 · {sessionLabel}</span>
            <span className="pp-ink-head-figures">{estimated ? '估算' : '回报'}</span>
          </div>

          {/* 读数（全册唯一题字）*/}
          <div className="pp-ink-reading">
            <span className={`pp-ink-percent${nearFull ? ' full' : ''}`}>
              {percent === undefined ? '—' : `${percent}%`}
            </span>
            <span className="pp-ink-reading-label">上下文已用</span>
          </div>
          <p className="pp-ink-note">
            {used === undefined || window === undefined
              ? '窗口未知——设为该模型声明的上下文窗口后才有百分比'
              : `${estimated ? '~' : ''}${tokenAlgebra.formatTokens(used)} / ${tokenAlgebra.formatTokens(window)} tok`}
            {stats?.projectedTokens !== undefined && (
              <>
                <span className="pp-ink-note-sep" aria-hidden="true">
                  ·
                </span>
                下一请求预计 ~{tokenAlgebra.formatTokens(stats.projectedTokens)}
              </>
            )}
          </p>

          {/* 占用条：总长 = 窗口占比，段宽 = 三段构成比（估算）*/}
          <div className="pp-ink-bar" aria-hidden="true">
            {percent !== undefined &&
              (breakdown && breakdownTotal > 0 ? (
                SEGMENTS.map((seg) => {
                  const width = (percent * breakdown[seg.key]) / breakdownTotal;
                  return width > 0 ? (
                    <span key={seg.key} className={`pp-ink-seg ${seg.cls}`} style={{ width: `${width}%` }} />
                  ) : null;
                })
              ) : (
                <span className="pp-ink-seg pp-ink-seg-total" style={{ width: `${percent}%` }} />
              ))}
          </div>

          {breakdown && breakdownTotal > 0 && (
            <ul className="pp-ink-legend">
              {SEGMENTS.map((seg) => (
                <li key={seg.key} title={seg.title}>
                  <i className={`pp-ink-swatch ${seg.cls}`} aria-hidden="true" />
                  <span className="pp-ink-legend-label">{seg.label}</span>
                  <span className="pp-ink-legend-value">~{tokenAlgebra.formatTokens(breakdown[seg.key])}</span>
                </li>
              ))}
            </ul>
          )}

          <Section title="账目" />
          <dl className="pp-ink-ledger">
            {totals && (
              <>
                <Line label="未缓存输入" value={tokenAlgebra.formatExactTokens(totals.uncachedInputTokens)} />
                <Line label="缓存读" value={tokenAlgebra.formatExactTokens(totals.cacheReadTokens)} />
                <Line label="缓存写" value={tokenAlgebra.formatExactTokens(totals.cacheWriteTokens)} />
                <Line label="输出" value={tokenAlgebra.formatExactTokens(totals.outputTokens)} />
              </>
            )}
            <Line label="合计" value={tokenAlgebra.formatExactTokens(shownTotal)} strong />
            <Line
              label="缓存命中"
              value={stats?.cacheHitPercent == null ? '—' : `${stats.cacheHitPercent}%`}
              title="命中前缀缓存的输入 ÷ 全部计费输入——部分命中不四舍五入成 100%"
            />
          </dl>

          <Section title="本轮" />
          <dl className="pp-ink-ledger">
            <Line
              label="请求"
              value={`${stats?.attempts ?? 0} 次`}
              title={stats && stats.turns.length > 0 ? `共 ${stats.turns.length} 轮` : undefined}
            />
            <Line
              label={lastTurn ? `第 ${lastTurn.turn} 轮` : '最新一轮'}
              value={lastTurn ? tokenAlgebra.formatExactTokens(lastTurn.totalTokens) : '—'}
              title={lastTurn ? `${lastTurn.steps} 步请求` : undefined}
            />
          </dl>

          <p className="pp-ink-foot">~ 本地分词估算 · 账目四桶来自服务商回报</p>
        </div>
      )}
    </div>
  );
});
