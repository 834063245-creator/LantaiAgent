// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 内置渲染器插件（P1，first-party-hot-reload-plan）——12 个资产表现原语
// （grid/chart/metric/media/graph/tree/html/form/board/timeline/citation/chem）
// 的唯一真源。
//
// 原位置 src-ui/src/composition/asset-renderers.tsx（已迁移，薄壳 re-export）。
// 双走查设计：
//   - 测试/开发域：直接 import 本组件（经 renderer-host 直连 react/overlay/rpc）；
//   - 生产/插件产物域：esbuild 构建时 alias renderer-host → host 桥取用面，
//     产出自包含 ESM（react/overlay/rpc 从 window.__lantai_plugin_host__ 取）。
//
// 纪律（协议 §2.9，自 asset-renderers.tsx 沿用）：
//   - 渲染器只渲染块体；壳件（签/手柄/钉住/占位）不进注册表。
//   - graph = 确定性分层布局（A5 二期）、tree = 深度列树布局（A5 首发；
//     力导向不做）；空数据一律「数据不可用」占位，不画空白 SVG。
//   - html 走沙箱 iframe（WO-8）：sandbox + 文档内 CSP，网络全 never。
//   - form（confirm kind）带活决议回调时全交互（选项/确认/修改/拒绝）；
//     无回调（历史卡/重载）只读态——回调不持久化（PlanPart._callback 先例）。
//   - 依赖纪律（2026-09-07 #10/#16 起更新）：默认纯 CSS/SVG 自绘 + 纸面墨色；
//     领域格式解析/交互渲染借 npm 库（smiles-drawer 结构式 / ECharts 交互图），
//     esbuild 产物域 bundle:true 内联——只有对应 presentation 的组件消费。
//
// 类型导入纪律：type-only import 编译期擦除（esbuild 产物无裸运行时 import）。
// smiles-drawer（scientific-rendering #10，2026-09）：npm 依赖，esbuild 产物域
// bundle:true 自动内联（react-bridge.cjs 注释 @react-aria 先例；本包零 react
// 依赖——chroma-js 一并内联，不进宿主桥）。vitest 域真实加载本包：parse 是纯
// 字符串处理不碰 DOM，SvgDrawer/ReactionDrawer 只在组件 effect 挂载后 draw 时
// 才碰 svg DOM。类型：包自带 dist/types（SmilesDrawerNS 默认导出）。
// ECharts（scientific-rendering #16，2026-09）：按需组合（core+charts+
// components+renderers 顶层 use 一次）——交互图 canvas 自绘，init 在 effect；
// SSR/测试无 effect → 空盒占位（measure 固定盒镜像 + RO 实测兜底）。体积
// +219KB gzip 进共享产物（用户拍板接受——交互科研图表是 #16 硬缺口）。

import { useVirtualizer } from '@tanstack/react-virtual';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { ReactNode } from 'react';
import SmilesDrawer from 'smiles-drawer';
import type { ConfirmCardResponse } from '../../../agent/agent-types';
import type { BlockRendererProps } from '../../../composition/renderer-service';
import { rendererHooks, rendererOverlay, rendererRpc } from './renderer-host';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

const { useEffect, useRef, useState } = rendererHooks;

/* ── grid ── */

/** 大表虚拟滚动触发阈值（科研渲染 #11，2026-09）：≤1000 行全量平铺（现状
 *  零变化——DOM/交互/measure 语义同旧）；>1000 行转虚拟滚动（div 网格：
 *  表头固定 + 行窗口化，浏览几千行 CSV 不卡）。阈值与 token 分离——是性能
 *  语义常量不是版式数字，放组件侧。 */
const GRID_VIRTUAL_THRESHOLD = 1000;

/** 虚拟滚动行高（镜像 ASSET_TOKENS.grid.virtualRowH 29——CSS
 *  .pp-grid-virtual-row height 走 var(--pp-asset-grid-virtualRowH)；
 *  virtualizer estimateSize 需 JS 数值，graph 组件同款几何常量模式）。 */
const GRID_VIRTUAL_ROW_H = 29;

/** 单元格字符串化（number/string/null/对象 → 文本；null/undefined → ''）。 */
function cellText(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function GridBody({ block }: BlockRendererProps) {
  const p = block.payload as { columns?: unknown[]; rows?: unknown[][]; caption?: string };
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const first = rows[0];
  const cols = Array.isArray(p.columns) ? p.columns.map(String) : first ? first.map((_, i) => `#${i + 1}`) : [];
  // 大表（>1000 行）转虚拟滚动（hooks 不能条件调——独立组件 VirtualGridBody）
  if (rows.length > GRID_VIRTUAL_THRESHOLD) {
    return <VirtualGridBody rows={rows} cols={cols} caption={typeof p.caption === 'string' ? p.caption : ''} />;
  }
  return (
    <div className="pp-grid">
      {p.caption && <div className="pp-grid-caption">{p.caption}</div>}
      <table className="pp-grid-table">
        {cols.length > 0 && (
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 表格行按位置渲染，行序即身份
            <tr key={i}>
              {row.map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 单元格按行列位置渲染
                <td key={j}>{cellText(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── grid 大表虚拟滚动（科研渲染 #11，2026-09）──
 * >GRID_VIRTUAL_THRESHOLD 行时启用：table 结构（thead 固定 + tbody 滚动 +
 * 绝对定位虚拟行窗口）——CSS table 在几千行下布局/滚动都慢，虚拟化只渲染
 * 可视窗口 ± overscan。固定行高（GRID_VIRTUAL_ROW_H——单行截断语义，长单元
 * 格省略号，.pp-grid-virtual td 的 nowrap 约束）。table-layout: fixed 列宽
 * 稳定 → 绝对定位行与表头列对齐。tbody 自持滚动条（纸面页式隐喻：大表 =
 * "卷内长物"，滚动浏览）。SSR/无布局期 getVirtualItems 空 → 只出总高容器，
 * 挂载后 effect 填充可视行（虚拟列表标准行为）。 */

function VirtualGridBody({ rows, cols, caption }: { rows: unknown[][]; cols: string[]; caption: string }) {
  const scrollRef = useRef<HTMLTableSectionElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_VIRTUAL_ROW_H,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  return (
    <div className="pp-grid pp-grid-virtual">
      {caption && <div className="pp-grid-caption">{caption}</div>}
      <table className="pp-grid-virtual-table">
        {cols.length > 0 && (
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
        )}
      </table>
      {/* tbody 自持滚动：thead 固定在外（table 拆两半——上半表头无 body，
          下半 body 无表头，table-layout fixed 保证列宽同源） */}
      <div className="pp-grid-virtual-scroll">
        <table className="pp-grid-virtual-table pp-grid-virtual-table--body">
          <tbody ref={scrollRef} className="pp-grid-virtual-tbody">
            <tr className="pp-grid-virtual-total" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              <td />
            </tr>
            {items.map((vi) => {
              const row = rows[vi.index];
              return (
                <tr key={vi.key} className="pp-grid-virtual-row" style={{ transform: `translateY(${vi.start}px)` }}>
                  {Array.isArray(row)
                    ? row.map((cell, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: 单元格按列位置渲染
                        <td key={j}>{cellText(cell)}</td>
                      ))
                    : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── chart 几何真源（D4-D8，2026-09-16）──────────────────────────────
 * 组件域不 import paper 层（插件产物自包含纪律），故这里硬编码镜像
 * ASSET_TOKENS.chart（type-tokens.ts 是真源；GRID_VIRTUAL_ROW_H 先例）。
 * 一致性由 tests/chart-geometry.test.ts 钉住（防两侧漂移——本轮修的
 * 「测高与渲染对不上」正是漂移产物）。 */

const CHART_GEO = {
  vbH: 180,
  leftPad: 30,
  rightPad: 10,
  topPad: 14,
  bottomPad: 20,
  barSlot: 40,
  barW: 22,
  scatterVbW: 400,
  valueMaxItems: 20,
} as const;

/** chart 数据归一（单一真源——渲染与 measure 共用同一套语义）。
 *  返回 {values, labels}；形状非法返回 null（渲染层落「数据不可用」占位）。
 *  D3：只接受已声明的三种合法形状（schema 已在校验层拒掉其余），
 *  不再「宽容」吸收任意形状。 */
function normalizeChartData(data: unknown): { values: number[]; labels: string[] } | null {
  if (Array.isArray(data)) {
    if (data.length === 0) return { values: [], labels: [] };
    const values: number[] = [];
    const labels: string[] = [];
    for (const d of data) {
      if (typeof d === 'number') {
        if (!Number.isFinite(d)) return null;
        values.push(d);
        labels.push('');
      } else if (d && typeof d === 'object') {
        const o = d as { label?: unknown; value?: unknown };
        if (typeof o.value !== 'number' || !Number.isFinite(o.value)) return null;
        values.push(o.value);
        labels.push(typeof o.label === 'string' ? o.label : '');
      } else {
        return null;
      }
    }
    return { values, labels };
  }
  if (data && typeof data === 'object') {
    const o = data as { labels?: unknown; values?: unknown };
    if (!Array.isArray(o.values) || !Array.isArray(o.labels)) return null;
    if (o.labels.length !== o.values.length) return null; // 等长契约（写入侧已拦，读取侧兜底）
    const values: number[] = [];
    const labels: string[] = [];
    for (let i = 0; i < o.values.length; i++) {
      const v = o.values[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      values.push(v);
      labels.push(typeof o.labels[i] === 'string' ? (o.labels[i] as string) : '');
    }
    return { values, labels };
  }
  return null;
}

/** 有效标签：首尾含非空字符才认为这组数据「有标签」（与 measure 同判据）。 */
function hasRealLabels(labels: string[]): boolean {
  return labels.some((l) => l.length > 0);
}

/* ── chart ── */

/** 归一化 chart 数据为数值数组（D3 起委托 normalizeChartData——单一真源）。
 *  无法解析 → 返回 []（渲染层落「数据不可用」占位，不静默空白）。 */
function chartValues(data: unknown): number[] {
  return normalizeChartData(data)?.values ?? [];
}

/** 归一化 chart 标签：委托 normalizeChartData（与 values 同源同序）。 */
function chartLabels(data: unknown): string[] {
  return normalizeChartData(data)?.labels ?? [];
}

/** data 是否无可用数值（空/形状不符）——驱动「数据不可用」占位（错误不静默纪律）。 */
function chartEmpty(data: unknown): boolean {
  return chartValues(data).length === 0;
}

/** 饼图扇区几何（D5）：按累计角度生成 SVG 弧路径。
 *  单一真源——渲染与测试共用（tart 前必失败：旧实现是 0 宽的 conic-gradient 空 span）。 */
export function pieSlices(values: number[]): Array<{ d: string; start: number; end: number; ratio: number }> {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return [];
  const R = 70;
  const cx = 80;
  const cy = 80;
  let acc = -90; // 从 12 点方向起画
  const out: Array<{ d: string; start: number; end: number; ratio: number }> = [];
  for (const v of values) {
    const ratio = Math.max(0, v) / total;
    const start = acc;
    const end = acc + ratio * 360;
    const x1 = cx + R * Math.cos((start * Math.PI) / 180);
    const y1 = cy + R * Math.sin((start * Math.PI) / 180);
    const x2 = cx + R * Math.cos((end * Math.PI) / 180);
    const y2 = cy + R * Math.sin((end * Math.PI) / 180);
    const large = end - start > 180 ? 1 : 0;
    // 满圆（单片占 100%）时 arc 起终点重合 → 用两段半圆逼近
    const d =
      ratio >= 1
        ? `M ${cx} ${cy - R} A ${R} ${R} 0 1 1 ${cx} ${cy + R} A ${R} ${R} 0 1 1 ${cx} ${cy - R} Z`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
    out.push({ d, start, end, ratio });
    acc = end;
  }
  return out;
}

function ChartBody({ block }: BlockRendererProps) {
  const p = block.payload as { type?: string; data?: unknown; config?: Record<string, unknown> };
  const type = typeof p.type === 'string' ? p.type : 'bar';
  const norm = normalizeChartData(p.data);
  const cfg = p.config ?? {};
  const title = typeof cfg.title === 'string' ? cfg.title : '';
  if (!norm || norm.values.length === 0) {
    // 错误不静默：数据形状不符/为空时渲染占位，不画空白 SVG
    return <div className="pp-chart pp-chart-empty">数据不可用 · 期望数组或 {`{labels, values}`} 形状</div>;
  }
  const { values, labels } = norm;
  const max = Math.max(1, ...values);
  const n = Math.max(values.length, 1);
  const showLabels = hasRealLabels(labels);
  const showValues = values.length <= CHART_GEO.valueMaxItems;

  const { vbH, leftPad, topPad, bottomPad, barSlot, barW, scatterVbW } = CHART_GEO;
  const plotW = n * barSlot;
  const vbW = type === 'scatter' ? scatterVbW : leftPad + plotW + CHART_GEO.rightPad;
  const baseY = vbH - bottomPad;

  // 柱：等高线映射 + 数值标注（D7）
  const bar = (
    <svg
      className="pp-chart-svg"
      viewBox={`0 0 ${vbW} ${vbH}`}
      role="img"
      aria-label="bar chart"
      preserveAspectRatio="xMidYMid meet"
    >
      <line className="pp-chart-axis" x1={leftPad} y1={baseY} x2={vbW - CHART_GEO.rightPad} y2={baseY} />
      <line className="pp-chart-axis" x1={leftPad} y1={topPad} x2={leftPad} y2={baseY} />
      {values.map((v, i) => {
        const h = (v / max) * (baseY - topPad);
        const x = leftPad + i * barSlot + (barSlot - barW) / 2;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 柱状图按数据序渲染（同图表族既有约定）
          <g key={`b${i}`}>
            <rect x={x} y={baseY - h} width={barW} height={Math.max(h, 1)} className="pp-chart-bar" />
            {showValues && (
              <text className="pp-chart-value" x={x + barW / 2} y={baseY - h - 4} textAnchor="middle">
                {v}
              </text>
            )}
            {showLabels && (
              <text className="pp-chart-cat" x={x + barW / 2} y={baseY + 12} textAnchor="middle">
                {labels[i] ?? ''}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );

  // 线：折线 + 点 + 数值（D7）
  const line = (
    <svg
      className="pp-chart-svg"
      viewBox={`0 0 ${vbW} ${vbH}`}
      role="img"
      aria-label="line chart"
      preserveAspectRatio="xMidYMid meet"
    >
      <line className="pp-chart-axis" x1={leftPad} y1={baseY} x2={vbW - CHART_GEO.rightPad} y2={baseY} />
      <line className="pp-chart-axis" x1={leftPad} y1={topPad} x2={leftPad} y2={baseY} />
      <polyline
        points={values
          .map((v, i) => `${leftPad + i * barSlot + barSlot / 2},${baseY - (v / max) * (baseY - topPad)}`)
          .join(' ')}
        className="pp-chart-line"
      />
      {values.map((v, i) => {
        const cx = leftPad + i * barSlot + barSlot / 2;
        const cy = baseY - (v / max) * (baseY - topPad);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 折线图按数据序渲染（同图表族约定）
          <g key={`p${i}`}>
            <circle className="pp-chart-dot" cx={cx} cy={cy} r={3} />
            {showValues && (
              <text className="pp-chart-value" x={cx} y={cy - 7} textAnchor="middle">
                {v}
              </text>
            )}
            {showLabels && (
              <text className="pp-chart-cat" x={cx} y={baseY + 12} textAnchor="middle">
                {labels[i] ?? ''}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );

  // 饼：真扇区（D5）——旧实现是 0 宽 conic-gradient 空 span，渲染成空圈
  const slices = pieSlices(values);
  const pie = (
    <svg className="pp-chart-svg pp-chart-pie-svg" viewBox="0 0 160 160" role="img" aria-label="pie chart">
      {slices.map((s, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: 饼图扇区按数据序渲染（同图表族约定）
          key={`s${i}`}
          className={`pp-chart-slice pp-chart-slice-${i % 6}`}
          d={s.d}
          data-start={s.start}
          data-end={s.end}
          data-ratio={s.ratio}
        />
      ))}
    </svg>
  );

  // 散点：x = 真实序列位置（D6）——旧实现 cx 是 (i*37)%380 的伪随机数，与数据无关
  const scatter = (
    <svg
      className="pp-chart-svg"
      viewBox={`0 0 ${scatterVbW} ${vbH}`}
      role="img"
      aria-label="scatter chart"
      preserveAspectRatio="xMidYMid meet"
    >
      <line className="pp-chart-axis" x1={leftPad} y1={baseY} x2={scatterVbW - CHART_GEO.rightPad} y2={baseY} />
      <line className="pp-chart-axis" x1={leftPad} y1={topPad} x2={leftPad} y2={baseY} />
      {values.map((v, i) => {
        const cx = leftPad + (i / Math.max(1, n - 1)) * (scatterVbW - leftPad - CHART_GEO.rightPad);
        const cy = baseY - (v / max) * (baseY - topPad);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 散点图按数据序渲染（同图表族约定）
          <g key={`d${i}`}>
            <circle className="pp-chart-dot" cx={cx} cy={cy} r={4} data-x={cx} data-y={cy} />
            {showValues && (
              <text className="pp-chart-value" x={cx} y={cy - 8} textAnchor="middle">
                {v}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );

  // 轴名（D4）：config.xName / config.yName
  const xName = typeof cfg.xName === 'string' ? cfg.xName : '';
  const yName = typeof cfg.yName === 'string' ? cfg.yName : '';

  return (
    <div className="pp-chart">
      <div className="pp-chart-type">{type}</div>
      {title && <div className="pp-chart-title">{title}</div>}
      {type === 'line' ? line : type === 'pie' ? pie : type === 'scatter' ? scatter : bar}
      {showLabels && type === 'pie' && (
        <div className="pp-chart-labels">
          {labels.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 饼图图例按数据序渲染（同图表族约定）
            <span key={`pl${i}`}>
              {l}
              {l ? ' ' : ''}
              {values[i]}
            </span>
          ))}
        </div>
      )}
      {(xName || yName) && (
        <div className="pp-chart-axis-names">
          {xName && <span className="pp-chart-xname">{xName}</span>}
          {yName && <span className="pp-chart-yname">{yName}</span>}
        </div>
      )}
    </div>
  );
}

/* ── chart interactive（交互图表——scientific-rendering #16，2026-09）──
 * chart kind 的第二个表现（presentation='interactive'，协议 §5.3 双维度正交）：
 * 同一 payload {type, data, config}，渲染走 ECharts（canvas）——tooltip/缩放/
 * 图例/工具箱交互。静态 chart 表现与历史块（presentation 缺省 → 'chart'）零影响。
 *
 * data 形状与静态版同源（chartValues/chartLabels 复用）：数组 [{label,value}]
 * 或 {labels, values}；config 透传标题/图例等 ECharts option 片段。
 *
 * ECharts init 是 effect（要真实 canvas DOM + 2D ctx）——SSR/测试（jsdom 无
 * canvas）→ 空容器占位（measure 固定盒镜像 + RO 实测兜底——资产族恒挂 RO）；
 * init 失败（异常环境）→ 「初始化失败」可见不崩（错误不静默纪律）。 */

/** 交互图固定盒高由 CSS 承载（.pp-chart-interactive-box height 走
 *  --pp-asset-chart-interactiveBoxH token——measure 镜像同 token 派生）。 */

/** 数据 → ECharts option（纯函数——测试直引，不碰 DOM/canvas）。
 *  data 形状与静态版同源（chartValues/chartLabels）；config 透传 title/xName/
 *  yName/palette；>40 项长数据自动加 dataZoom（滚动/缩放交互）。 */
export function buildEchartsOption(
  type: string,
  data: unknown,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const values = chartValues(data);
  const labels = chartLabels(data);
  const title = config && typeof config.title === 'string' ? { text: config.title } : undefined;
  const base: Record<string, unknown> = {
    title,
    tooltip: {},
    color: config && Array.isArray(config.palette) ? config.palette : undefined,
  };
  if (type === 'pie') {
    return {
      ...base,
      legend: labels.length > 0 ? { bottom: 0 } : undefined,
      series: [
        {
          type: 'pie',
          radius: '62%',
          data: values.map((v, i) => ({ name: labels[i] ?? `#${i + 1}`, value: v })),
        },
      ],
    };
  }
  const xAxis = labels.length > 0 ? { type: 'category', data: labels } : { type: 'category' };
  const seriesData = type === 'scatter' ? values.map((v, i) => [labels[i] ?? i, v]) : values;
  return {
    ...base,
    grid: { left: 44, right: 16, top: title ? 48 : 28, bottom: labels.length > 0 ? 40 : 28 },
    xAxis: { ...xAxis, name: config && typeof config.xName === 'string' ? config.xName : undefined },
    yAxis: { type: 'value', name: config && typeof config.yName === 'string' ? config.yName : undefined },
    // bar/line 单系列；scatter 以 [x,y] 点列
    series: [{ type, data: seriesData, ...(type === 'line' ? { smooth: true } : {}) }],
    dataZoom: values.length > 40 ? [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 2 }] : undefined,
  };
}

function InteractiveChartBody({ block }: BlockRendererProps) {
  const p = block.payload as { type?: string; data?: unknown; config?: Record<string, unknown> };
  const type = typeof p.type === 'string' ? p.type : 'bar';
  const domRef = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!domRef.current || chartEmpty(p.data)) return;
    let chart: ReturnType<typeof echarts.init> | null = null;
    try {
      chart = echarts.init(domRef.current);
      chart.setOption(buildEchartsOption(type, p.data, p.config));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    return () => {
      chart?.dispose();
    };
  }, [type, p.data, p.config]);
  if (chartEmpty(p.data)) {
    // 与静态版同文案（错误不静默）
    return <div className="pp-chart pp-chart-empty">数据不可用 · 期望数组或 {`{labels, values}`} 形状</div>;
  }
  return (
    <div className="pp-chart pp-chart-interactive">
      <div className="pp-chart-type">{type} · 交互</div>
      {err ? (
        <div className="pp-chart-interactive-err">交互图初始化失败：{err}</div>
      ) : (
        /* ECharts 固定盒（init 后 canvas 撑满盒）——SSR/测试无 effect → 空盒占位 */
        <div ref={domRef} className="pp-chart-interactive-box" />
      )}
    </div>
  );
}

/* ── metric ── */

function MetricBody({ block }: BlockRendererProps) {
  const p = block.payload as {
    items?: Array<{ label?: string; value?: unknown; unit?: string; tone?: string }>;
    caption?: string;
  };
  const items = Array.isArray(p.items) ? p.items : [];
  return (
    <div className="pp-metric">
      {p.caption && <div className="pp-metric-caption">{p.caption}</div>}
      <div className="pp-metric-grid">
        {items.map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 指标卡按数据序渲染
          <div key={i} className={`pp-metric-card${it.tone ? ` pp-metric-tone-${it.tone}` : ''}`}>
            <div className="pp-metric-label">{it.label ?? ''}</div>
            <div className="pp-metric-value">
              {String(it.value ?? '')}
              {it.unit && <span className="pp-metric-unit">{it.unit}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── media ── */

/** 媒体扩展名 → MIME 类型（冻结常量表——初始化后只读，模块级归属第 4 类） */
const MEDIA_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
};

/** 图片扩展名集合 */
const MEDIA_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
/** 视频扩展名集合 */
const MEDIA_VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'mov']);

/** 媒体加载状态（base64 拉取 + 生命周期守卫） */
type MediaLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: string }
  | { status: 'error'; error: string };

/**
 * 经 read_file_base64 拉取本地文件（Tauri WebView 拦裸本地路径——
 * <img src="D:/..."> 打不开，必须走后端读成 base64 再喂 data: URI）。
 * 组件卸载/路径变化时丢弃在途结果（epoch 语义，防串流）。
 */
function useMediaData(filePath: string | undefined): MediaLoadState {
  const [state, setState] = useState<MediaLoadState>({ status: filePath ? 'loading' : 'idle' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: filePath ? 'loading' : 'idle' });
    if (!filePath) return;
    // fs 域收口（kernel-capability-c3-design.md）：read_file_base64 从 tool_call
    // 信封换 fs_cap read_base64 能力口直呼（用户路径 is_agent=false）——返回
    // JSON {path, base64}，取 base64 字段喂 data: URI。
    rendererRpc('fs_cap', { action: 'read_base64', file_path: filePath, is_agent: false })
      .then((res) => {
        if (cancelled) return;
        const raw = typeof res === 'string' ? res : JSON.stringify(res);
        try {
          const parsed = JSON.parse(raw) as { base64?: unknown };
          setState({ status: 'ready', data: String(parsed.base64 ?? raw) });
        } catch {
          setState({ status: 'ready', data: raw });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setState({ status: 'error', error: msg });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  return state;
}

function MediaBody({ block }: BlockRendererProps) {
  const p = block.payload as { fileId?: string; filePath?: string; label?: string; ext?: string };
  const label = p.label || p.fileId || p.filePath || '文件';
  const ext = (p.ext || '').toLowerCase();
  const mime = MEDIA_MIME[ext];
  const isImage = MEDIA_IMAGE_EXTS.has(ext);
  const isVideo = MEDIA_VIDEO_EXTS.has(ext);
  // 只有图片/视频才需要读文件内容；未知类型走文件壳，不浪费一次 RPC
  const isMedia = isImage || isVideo;
  const loaded = useMediaData(isMedia ? p.filePath : undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const loadingNode =
    loaded.status === 'error' ? (
      <div className="pp-media-loading">读取失败：{loaded.error}</div>
    ) : (
      <div className="pp-media-loading">加载中…</div>
    );
  const src =
    loaded.status === 'ready' && loaded.data
      ? `data:${mime ?? (isVideo ? 'video/mp4' : 'image/png')};base64,${loaded.data}`
      : null;
  const previewBody = isVideo ? (
    // biome-ignore lint/a11y/useMediaCaption: 预览用户本地视频，无字幕轨道来源（非交互媒体）
    <video className="pp-media-preview" src={src ?? undefined} controls autoPlay aria-label={label} />
  ) : (
    <img className="pp-media-preview" src={src ?? undefined} alt={label} />
  );
  const Overlay = rendererOverlay;
  return (
    <div className="pp-media">
      <div className="pp-media-label">{label}</div>
      {isImage && p.filePath ? (
        src ? (
          <button type="button" className="pp-media-open" onClick={() => setPreviewOpen(true)}>
            <img className="pp-media-img" src={src} alt={label} />
          </button>
        ) : (
          loadingNode
        )
      ) : isVideo && p.filePath ? (
        // biome-ignore lint/a11y/useMediaCaption: 展示用户本地视频，无字幕轨道来源（非交互媒体）
        <video className="pp-media-video" src={src ?? undefined} controls aria-label={label} />
      ) : (
        <div className="pp-media-file">
          {ext && <span className="pp-media-ext">{ext}</span>}
          <span className="pp-media-path">{p.filePath ?? ''}</span>
        </div>
      )}
      {/* 点击放大浏览：全局浮层（portal 到 body）+ Escape/点遮罩关闭 */}
      <Overlay open={previewOpen} onClose={() => setPreviewOpen(false)} portal className="pp-media-preview-overlay">
        {previewBody}
      </Overlay>
    </div>
  );
}

/* ── graph / tree（确定性 SVG 布局，A5：tree 首发 + layered 二期）── */

interface GraphNode {
  id: string;
  label?: string;
  depth?: number;
  children?: GraphNode[];
}

interface GraphEdge {
  from: string;
  to: string;
}

function normalizeGraph(payload: unknown): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const p = payload as { nodes?: GraphNode[]; edges?: GraphEdge[] };
  const nodes = Array.isArray(p.nodes) ? p.nodes : [];
  if (Array.isArray(p.edges)) return { nodes, edges: p.edges };
  // tree 形态：nodes 内 children 展开为边
  const edges: GraphEdge[] = [];
  const walk = (node: GraphNode) => {
    for (const child of node.children ?? []) {
      edges.push({ from: node.id, to: child.id });
      walk(child);
    }
  };
  for (const node of nodes) walk(node);
  return { nodes, edges };
}

/** 几何常量（镜像 ASSET_TOKENS.graph：colW/rowH/origin——measure.ts 同源取数） */
const GRAPH_COL_W = 160;
const GRAPH_ROW_H = 52;
const GRAPH_ORIGIN_X = 40;
const GRAPH_ROW_Y = 26;

/** 空数据占位（错误不静默——查询式 {nodeId, depth} 无直通数据/空 nodes 不画空白 SVG） */
function graphEmptyPlaceholder(): ReactNode {
  return (
    <div className="pp-graph pp-graph-empty">
      数据不可用 · 期望 nodes/edges 直通数据（查询式 nodeId 请改用 trace_impact 输出的 nodes/edges）
    </div>
  );
}

/** 共享 SVG 视图：pos 以「列号/行号」为单位的网格坐标，此处乘几何常量落位。 */
function GraphBodySvg({
  nodes,
  edges,
  pos,
  cols,
  rows,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  pos: Map<string, { x: number; y: number }>;
  cols: number;
  rows: number;
}) {
  const W = Math.max(320, cols * GRAPH_COL_W + GRAPH_ORIGIN_X);
  const H = Math.max(80, rows * GRAPH_ROW_H + 30);
  return (
    <div className="pp-graph">
      <svg className="pp-graph-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="graph">
        {edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          return (
            <line
              key={`${e.from}->${e.to}`}
              x1={a.x * GRAPH_COL_W + GRAPH_ORIGIN_X}
              y1={a.y * GRAPH_ROW_H + GRAPH_ROW_Y}
              x2={b.x * GRAPH_COL_W + GRAPH_ORIGIN_X}
              y2={b.y * GRAPH_ROW_H + GRAPH_ROW_Y}
              className="pp-graph-edge"
            />
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x * GRAPH_COL_W + GRAPH_ORIGIN_X}, ${p.y * GRAPH_ROW_H + GRAPH_ROW_Y})`}
              className="pp-graph-node"
            >
              <rect x={-36} y={-14} width={72} height={28} rx={0} className="pp-graph-node-box" />
              <text textAnchor="middle" dominantBaseline="middle" className="pp-graph-node-text">
                {n.label ?? n.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** tree 表现：深度列布局（无父节点起 DFS，逐行下探——A5 首发形态）。 */
function GraphTreeBody({ block }: BlockRendererProps) {
  const { nodes, edges } = normalizeGraph(block.payload);
  if (nodes.length === 0) return graphEmptyPlaceholder();
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    const list = children.get(e.from);
    if (list) list.push(e.to);
    else children.set(e.from, [e.to]);
    hasParent.add(e.to);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let cursorY = 0;
  const place = (id: string, depth: number) => {
    if (pos.has(id)) return;
    pos.set(id, { x: depth, y: cursorY });
    cursorY += 1;
    for (const c of children.get(id) ?? []) place(c, depth + 1);
  };
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  if (roots.length === 0) for (const n of nodes) place(n.id, 0);
  else for (const r of roots) place(r.id, 0);
  const maxDepth = Math.max(0, ...nodes.map((n) => pos.get(n.id)?.x ?? 0));
  return <GraphBodySvg nodes={nodes} edges={edges} pos={pos} cols={maxDepth + 1} rows={nodes.length} />;
}

/** graph 表现：确定性分层布局（A5 二期）——最长路径分层（无入边 = 第 0 层），
 *  同层按 nodes 表序排布；环防御 = 松弛轮数封顶（edges+2 轮，环上节点确定性铺开，
 *  不崩不循环）。无交叉优化——轻量易读即可（交互留给纸壳钉住/拖出）。 */
function GraphLayeredBody({ block }: BlockRendererProps) {
  const { nodes, edges } = normalizeGraph(block.payload);
  if (nodes.length === 0) return graphEmptyPlaceholder();
  // 层号松弛：layer(n) = 0（无入边）| max(layer(parent)+1)，迭代至稳定
  const layer = new Map<string, number>();
  for (const n of nodes) layer.set(n.id, 0);
  const maxPasses = edges.length + 2;
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const e of edges) {
      const from = layer.get(e.from);
      const to = layer.get(e.to);
      if (from === undefined || to === undefined) continue;
      if (from + 1 > to) {
        layer.set(e.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 同层按 nodes 表序排 y，层号排 x——输入序即输出序（确定性断言可钉）
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    const list = byLayer.get(l);
    if (list) list.push(n.id);
    else byLayer.set(l, [n.id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  let maxLayer = 0;
  let maxRows = 0;
  for (const [l, ids] of byLayer) {
    maxLayer = Math.max(maxLayer, l);
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, i) => {
      pos.set(id, { x: l, y: i });
    });
  }
  return <GraphBodySvg nodes={nodes} edges={edges} pos={pos} cols={maxLayer + 1} rows={maxRows} />;
}

/* ── html 沙箱（WO-8）── */

const HTML_CARD_MAX_BYTES = 512 * 1024;
const HTML_CARD_HEIGHT_CAP = 1000;
const HTML_CARD_NS = 'lantai.card-resize';
const HTML_CARD_PING = 'lantai.card-ping';

/** html 卡 capability 行（WO-8/A2）：v1 网络口全 never；ask/allow 挂权限引擎留待后需。 */
export const HTML_CARD_CAPABILITY = { id: 'builtin/html', network: 'never' } as const;

/** 生成沙箱 iframe 文档（WO-8）。
 *  文档自带 CSP：default-src 'none' + 内联 script/style 白名单 + connect-src 'none'，
 *  配合 iframe sandbox="allow-scripts"（无 allow-same-origin），实现无网络/无父页访问/
 *  禁导航禁表单三要素。 */
export function buildHtmlCardDocument(code: string): string {
  const safeCode = code.length > HTML_CARD_MAX_BYTES ? code.slice(0, HTML_CARD_MAX_BYTES) : code;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html { background: transparent; }
body { padding: 8px 12px; font-family: var(--f-song, serif); color: var(--ink-1, #26221c); }
svg { display: block; max-width: 100%; }
</style>
</head>
<body>
${safeCode}
<script>
(function () {
  var NS = '${HTML_CARD_NS}';
  var last = 0;
  function report() {
    var h = document.documentElement.scrollHeight;
    if (h !== last) { last = h; window.parent.postMessage({ type: NS, height: h }, '*'); }
  }
  if (document.readyState === 'complete') report();
  else window.addEventListener('load', report);
  new ResizeObserver(function () { report(); }).observe(document.body);
  window.addEventListener('message', function (e) {
    if (e.data === '${HTML_CARD_PING}') { last = 0; report(); }
  });
})();
</script>
</body>
</html>`;
}

function HtmlBody({ block }: BlockRendererProps) {
  const p = block.payload as { code?: string };
  const code = typeof p.code === 'string' ? p.code : '';
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const srcDoc = buildHtmlCardDocument(code);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type !== HTML_CARD_NS) return;
      const h = Number(e.data.height);
      if (Number.isFinite(h) && h > 0) setHeight(Math.min(h, HTML_CARD_HEIGHT_CAP));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const onLoad = () => {
    iframeRef.current?.contentWindow?.postMessage(HTML_CARD_PING, '*');
  };

  return (
    <div className="pp-html">
      <iframe
        ref={iframeRef}
        className="pp-html-frame"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={block.asset?.title ?? 'html card'}
        style={height != null ? { height } : undefined}
        onLoad={onLoad}
      />
    </div>
  );
}

/* ── form（confirm）── */

function FormBody({ block }: BlockRendererProps) {
  const p = block.payload as {
    title?: string;
    body?: string;
    options?: Array<{ label: string; description?: string }>;
    confirmLabel?: string;
  };
  const options = Array.isArray(p.options) ? p.options : [];
  // 决议回调（executor 预发卡经事件管道挂进 asset；PlanPart._callback 同构）。
  // 无回调 = 历史卡（重载只读态）/无界面通道卡——维持信息展示，不出操作钮。
  const cb = block.asset?._confirm;
  const [selected, setSelected] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [done, setDone] = useState(false);
  // 已决议终态（活引用 part 上随决议写入，纯 JSON 持久化）——重挂载/重载后
  // 仍「已处理」，不复挂操作钮；比本地 done 态优先（本地态只管当帧观感）。
  // BlockSource.part 是宽型 object（block-model 不引 BlockPart 类型）——守卫边界收窄。
  const part = block.source.part as { type?: string; confirmResolution?: ConfirmCardResponse } | null;
  const resolution = part && part.type === 'block' ? part.confirmResolution : undefined;

  if (!cb) {
    return (
      <div className="pp-form">
        <div className="pp-form-title">{p.title || '确认'}</div>
        {p.body && <div className="pp-form-body">{p.body}</div>}
        {options.length > 0 && (
          <div className="pp-form-options">
            {options.map((o) => (
              <div key={o.label} className="pp-form-option">
                <span className="pp-form-option-label">{o.label}</span>
                {o.description && <span className="pp-form-option-desc">{o.description}</span>}
              </div>
            ))}
          </div>
        )}
        {resolution && <div className="pp-pc-done">已处理</div>}
      </div>
    );
  }

  const hasOptions = options.length >= 2;
  const canApprove = !hasOptions || selected !== null;
  const canRevise = feedback.trim().length > 0;
  const settle = (response: ConfirmCardResponse) => {
    cb(response);
    if (part && part.type === 'block') part.confirmResolution = response;
    setDone(true);
  };
  return (
    <div className="pp-form">
      <div className="pp-form-title">{p.title || '确认'}</div>
      {p.body && <div className="pp-form-body">{p.body}</div>}
      {options.length > 0 && (
        <div className="pp-form-options">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              className={`pp-form-option${selected === o.label ? ' pp-form-option--on' : ''}`}
              disabled={!hasOptions}
              onClick={() => setSelected(o.label)}
            >
              <span className="pp-form-option-label">{o.label}</span>
              {o.description && <span className="pp-form-option-desc">{o.description}</span>}
            </button>
          ))}
        </div>
      )}
      {done || resolution ? (
        <div className="pp-pc-done">已处理</div>
      ) : (
        <>
          {feedbackOpen && (
            <div className="pp-pc-feedback">
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="修改意见…" />
            </div>
          )}
          {/* 操作区复用拟策卡钤印语言（确认卡 = plan 审批模式泛化——同为人手
           * 决策，同一钮面；主操作随态让位同拟策：反馈框展开时「提交」当家） */}
          <div className="pp-pc-actions">
            <button
              type="button"
              className={`pp-pc-btn${feedbackOpen ? '' : ' pp-pc-btn--primary'}`}
              disabled={!canApprove}
              title={canApprove ? undefined : '先选择方案'}
              onClick={() => settle({ decision: 'approved', ...(selected ? { selectedLabel: selected } : {}) })}
            >
              {p.confirmLabel || '确认'}
            </button>
            <button type="button" className="pp-pc-btn" onClick={() => setFeedbackOpen((v) => !v)}>
              修改
            </button>
            {feedbackOpen && (
              <button
                type="button"
                className="pp-pc-btn pp-pc-btn--primary"
                disabled={!canRevise}
                title={canRevise ? undefined : '先填写修改意见'}
                onClick={() => settle({ decision: 'revise', feedback: feedback.trim() })}
              >
                提交
              </button>
            )}
            <button
              type="button"
              className="pp-pc-btn pp-pc-btn--reject"
              title="回绝此确认"
              onClick={() => settle({ decision: 'rejected' })}
            >
              拒绝
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── board（看板——列+卡，§2.9 原语补齐）── */

function BoardBody({ block }: BlockRendererProps) {
  const p = block.payload as {
    columns?: Array<{ title?: string; cards?: Array<{ label?: string; body?: string; tone?: string }> }>;
  };
  const columns = Array.isArray(p.columns) ? p.columns : [];
  if (columns.length === 0) {
    return <div className="pp-board pp-board-empty">数据不可用 · 期望 columns: [{`{title, cards}`}] 形状</div>;
  }
  return (
    <div className="pp-board">
      {columns.map((col, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 看板列按数据序渲染，列序即身份
        <div key={i} className="pp-board-col">
          <div className="pp-board-col-title">{col.title ?? ''}</div>
          {(col.cards ?? []).map((card, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 卡按列内序渲染
            <div key={j} className={`pp-board-card${card.tone ? ` pp-board-card-${card.tone}` : ''}`}>
              <div className="pp-board-card-label">{card.label ?? ''}</div>
              {card.body && <div className="pp-board-card-body">{card.body}</div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── timeline（时间轴——事件流，§2.9 原语补齐）── */

function TimelineBody({ block }: BlockRendererProps) {
  const p = block.payload as { items?: Array<{ ts?: string; title?: string; body?: string }> };
  const items = Array.isArray(p.items) ? p.items : [];
  if (items.length === 0) {
    return <div className="pp-timeline pp-timeline-empty">数据不可用 · 期望 items: [{`{ts, title, body?}`}] 形状</div>;
  }
  return (
    <div className="pp-timeline">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 时间轴按事件序渲染，序即身份
        <div key={i} className="pp-timeline-item">
          <span className="pp-timeline-node" aria-hidden="true" />
          <div className="pp-timeline-ts">{it.ts ?? ''}</div>
          <div className="pp-timeline-main">
            <div className="pp-timeline-title">{it.title ?? ''}</div>
            {it.body && <div className="pp-timeline-body">{it.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── citation（学术引用卡——scientific-rendering 4B，2026-09）──
 * 文献元数据的结构化呈现：标题 / 作者 / 年份·venue / 标识行（DOI/PMID/arXiv/
 * URL 一律纯文本 mono——本会话不做外部浏览器跳转，等 opener RPC 机制落地再
 * 链接化）＋ 可折叠 BibTeX 原文（<details> 语义；details/summary 原生折叠，
 * 无 JS 状态，历史卡与实时卡同构只读——引用是既成事实，没有交互回调）。 */

function CitationBody({ block }: BlockRendererProps) {
  const p = block.payload as {
    title?: string;
    authors?: string | string[];
    year?: string | number;
    venue?: string;
    doi?: string;
    pmid?: string;
    arxiv?: string;
    url?: string;
    bibtex?: string;
  };
  const title = typeof p.title === 'string' ? p.title : '';
  const authors = Array.isArray(p.authors) ? p.authors : typeof p.authors === 'string' ? [p.authors] : [];
  const venue = typeof p.venue === 'string' ? p.venue : '';
  const year = p.year != null ? String(p.year) : '';
  const ids: Array<[string, string]> = [];
  if (typeof p.doi === 'string' && p.doi) ids.push(['DOI', p.doi]);
  if (typeof p.pmid === 'string' && p.pmid) ids.push(['PMID', p.pmid]);
  if (typeof p.arxiv === 'string' && p.arxiv) ids.push(['arXiv', p.arxiv]);
  if (typeof p.url === 'string' && p.url) ids.push(['URL', p.url]);
  const bibtex = typeof p.bibtex === 'string' ? p.bibtex : '';
  const empty = !title && authors.length === 0 && ids.length === 0 && !bibtex;
  if (empty) {
    return (
      <div className="pp-citation pp-citation-empty">
        数据不可用 · 期望引用元数据（title/authors/year/venue/doi/pmid/arxiv/bibtex 之一）
      </div>
    );
  }
  const venueLine = venue || year ? `${venue}${venue && year ? ' · ' : ''}${year}` : '';
  return (
    <div className="pp-citation">
      {title && <div className="pp-citation-title">{title}</div>}
      {authors.length > 0 && (
        <div className="pp-citation-authors">
          {authors.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 作者按数据序渲染，静态内容无重排身份
            <span key={i} className="pp-citation-author">
              {a}
              {i < authors.length - 1 ? ', ' : ''}
            </span>
          ))}
        </div>
      )}
      {venueLine && <div className="pp-citation-venue">{venueLine}</div>}
      {ids.length > 0 && (
        <div className="pp-citation-ids">
          {ids.map(([tag, val]) => (
            <span key={tag} className="pp-citation-id">
              <span className="pp-citation-tag">{tag}</span>
              {val}
            </span>
          ))}
        </div>
      )}
      {bibtex && (
        <details className="pp-citation-bib">
          <summary>BibTeX</summary>
          <pre className="pp-citation-bibtex">{bibtex}</pre>
        </details>
      )}
    </div>
  );
}

/* ── chem（化学式/反应卡——scientific-rendering #10，2026-09）──
 * name/formula/smiles 的结构化呈现：展示名（宋体）+ SMILES 结构图 + 分子式。
 * 结构图走 smiles-drawer SvgDrawer（SVG 只写 viewBox 不写尺寸——CSS 100%×100%
 * 自适应；scale<=0 时 viewBox 被归一为方形包围盒，盒内 meet 居中不失真）。
 * 绘制是 effect（要真实 svg DOM 挂载）——SSR/测试无 effect → 空盒（measure
 * 静态镜像恒 boxH，挂载后 RO 实测兜底——chem 属资产族恒挂 RO）。
 * 错误可见不崩：parse/draw 失败 → 错误行 + formula/name 兜底仍在；smiles
 * 原文只在异常时展示（成功时图即正文，不重复堆原文）。 */

function ChemBody({ block }: BlockRendererProps) {
  const p = block.payload as { name?: unknown; formula?: unknown; smiles?: unknown };
  const name = typeof p.name === 'string' ? p.name : '';
  const formula = typeof p.formula === 'string' ? p.formula : '';
  const smiles = typeof p.smiles === 'string' ? p.smiles : '';
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const empty = !name && !formula && !smiles;
  useEffect(() => {
    if (!smiles || !svgRef.current) return;
    let cancelled = false;
    const svg = svgRef.current;
    const onErr = (e: unknown): void => {
      if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
    };
    const draw = (tree: unknown): void => {
      if (cancelled || !svg.isConnected) return;
      try {
        // 分子 options（SvgDrawer/ReactionDrawer 内部 SvgDrawer 共用）：
        // 键控比例小一号（box 内 fit——默认 500×500 / bond 30 会撑满 180 盒）
        const molOpts = {
          width: 500,
          height: 500,
          bondThickness: 0.9,
          bondLength: 22,
          padding: 6,
          fontSizeLarge: 7,
          fontSizeSmall: 3,
        };
        if (smiles.includes('>>')) {
          // 反应式（A>>B）：ReactionDrawer(reactionOptions, moleculeOptions)
          const drawer = new SmilesDrawer.ReactionDrawer(
            { spacing: 14, arrow: { length: 40, headSize: 6, thickness: 1 } },
            molOpts,
          );
          drawer.draw(tree, svg, 'light');
        } else {
          const drawer = new SmilesDrawer.SvgDrawer(molOpts);
          drawer.draw(tree, svg, 'light');
        }
      } catch (e) {
        onErr(e);
      }
    };
    if (smiles.includes('>>')) {
      SmilesDrawer.parseReaction(smiles, draw, onErr);
    } else {
      SmilesDrawer.parse(smiles, draw, onErr);
    }
    return () => {
      cancelled = true;
    };
  }, [smiles]);
  if (empty) {
    return <div className="pp-chem pp-chem-empty">数据不可用 · 期望化学字段（name/formula/smiles 之一）</div>;
  }
  return (
    <div className="pp-chem">
      {name && <div className="pp-chem-name">{name}</div>}
      {smiles && (
        <div className="pp-chem-box">
          {/* smiles-drawer 经 ref 原地绘制本 svg（append defs/g/paths）——元素自闭合写法无影响 */}
          <svg ref={svgRef} className="pp-chem-svg" role="img" aria-label={name || formula || smiles} />
        </div>
      )}
      {(formula || (smiles && err)) && (
        <div className="pp-chem-meta">
          {formula && <div className="pp-chem-formula">{formula}</div>}
          {smiles && err && (
            <div className="pp-chem-err" title={smiles}>
              结构解析失败：{err}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 13 个资产表现原语/表现的注册表入口（供渲染器 cordis 插件装载）。
 *  注：presentation 名与渲染器 kind 命名空间共用——chart kind 的
 *  presentation='interactive'（科研渲染 #16）注册为渲染器 kind='interactive'
 *  行，resolveAssetBlock 按 presentation 名查行即中。 */
export type AssetRendererKind =
  | 'grid'
  | 'chart'
  | 'metric'
  | 'media'
  | 'graph'
  | 'tree'
  | 'html'
  | 'form'
  | 'board'
  | 'timeline'
  | 'citation'
  | 'chem'
  | 'interactive';

export function assetRendererComponents(): Record<AssetRendererKind, (props: BlockRendererProps) => ReactNode> {
  return {
    grid: GridBody,
    chart: ChartBody,
    metric: MetricBody,
    media: MediaBody,
    graph: GraphLayeredBody,
    tree: GraphTreeBody,
    html: HtmlBody,
    form: FormBody,
    board: BoardBody,
    timeline: TimelineBody,
    citation: CitationBody,
    chem: ChemBody,
    interactive: InteractiveChartBody,
  };
}
