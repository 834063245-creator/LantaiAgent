// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 内置渲染器插件（P1，first-party-hot-reload-plan）——11 个资产表现原语
// （grid/chart/metric/media/graph/tree/html/form/board/timeline/citation）的唯一真源。
//
// 原位置 src-ui/src/composition/asset-renderers.tsx（已迁移，薄壳 re-export）。
// 双走查设计：
//   - 测试/开发域：直接 import 本组件（经 renderer-host 直连 react/overlay/rpc）；
//   - 生产/插件产物域：esbuild 构建时 alias renderer-host → host 桥取用面，
//     产出自包含 ESM（react/overlay/rpc 从 window.__lantai_plugin_host__ 取）。
//
// 纪律（协议 §2.9，自 asset-renderers.tsx 沿用）：
//   - 全部纯 CSS+SVG 自绘，零新依赖；纸壳墨色体系由 PaperPanel.css 承载。
//   - 渲染器只渲染块体；壳件（签/手柄/钉住/占位）不进注册表。
//   - graph = 确定性分层布局（A5 二期）、tree = 深度列树布局（A5 首发；
//     力导向不做）；空数据一律「数据不可用」占位，不画空白 SVG。
//   - html 走沙箱 iframe（WO-8）：sandbox + 文档内 CSP，网络全 never。
//   - form（confirm kind）带活决议回调时全交互（选项/确认/修改/拒绝）；
//     无回调（历史卡/重载）只读态——回调不持久化（PlanPart._callback 先例）。
//
// 类型导入纪律：type-only import 编译期擦除（esbuild 产物无裸运行时 import）。

import type { CSSProperties, ReactNode } from 'react';
import type { ConfirmCardResponse } from '../../../agent/agent-types';
import type { BlockRendererProps } from '../../../composition/renderer-service';
import { rendererHooks, rendererOverlay, rendererRpc } from './renderer-host';

const { useEffect, useRef, useState } = rendererHooks;

/* ── grid ── */

function GridBody({ block }: BlockRendererProps) {
  const p = block.payload as { columns?: unknown[]; rows?: unknown[][]; caption?: string };
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const first = rows[0];
  const cols = Array.isArray(p.columns) ? p.columns.map(String) : first ? first.map((_, i) => `#${i + 1}`) : [];
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
                <td key={j}>{String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── chart ── */

/** 归一化 chart 数据为数值数组。支持两种形状：
 *  1. 数组：`[1,2,3]` 或 `[{label,value}]`（value 取数值）
 *  2. 对象：`{ labels: [...], values: [...] }`（values 取数值，labels 与 values 等长取用）
 *  无法解析（非数组且无 values 数组）→ 返回 []（渲染层落"数据不可用"占位，不静默空白）。 */
function chartValues(data: unknown): number[] {
  let raw: unknown[] | null = null;
  if (Array.isArray(data)) {
    raw = data;
  } else if (data && typeof data === 'object') {
    const v = (data as { values?: unknown }).values;
    if (Array.isArray(v)) raw = v;
    else return [];
  } else {
    return [];
  }
  if (raw === null) return [];
  return raw.map((d) => {
    if (typeof d === 'number') return d;
    if (d && typeof d === 'object') {
      const v = (d as { value?: unknown }).value;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    // 数字字符串（"12.5"）也接受；其余 NaN → 0
    const n = Number(d);
    return Number.isFinite(n) ? n : 0;
  });
}

/** 归一化 chart 标签：数组形状取 {label}，对象形状取 {labels}（与 values 对齐）。 */
function chartLabels(data: unknown): string[] {
  let raw: unknown[] | null = null;
  if (Array.isArray(data)) {
    raw = data;
  } else if (data && typeof data === 'object') {
    const v = (data as { labels?: unknown }).labels;
    if (Array.isArray(v)) raw = v;
    else return [];
  } else {
    return [];
  }
  if (raw === null) return [];
  return raw.map((d) => {
    if (d && typeof d === 'object') return String((d as { label?: unknown }).label ?? '');
    // 字符串标签直接取本身（如 {labels: ['feat','docs']}）
    return String(d);
  });
}

/** data 是否无可用数值（空/形状不符）——驱动"数据不可用"占位（错误不静默纪律）。 */
function chartEmpty(data: unknown): boolean {
  return chartValues(data).length === 0;
}

function ChartBody({ block }: BlockRendererProps) {
  const p = block.payload as { type?: string; data?: unknown; config?: Record<string, unknown> };
  const type = typeof p.type === 'string' ? p.type : 'bar';
  const values = chartValues(p.data);
  const labels = chartLabels(p.data);
  if (chartEmpty(p.data)) {
    // 错误不静默：数据形状不符/为空时渲染占位，不画空白 SVG
    return <div className="pp-chart pp-chart-empty">数据不可用 · 期望数组或 {`{labels, values}`} 形状</div>;
  }
  const max = Math.max(1, ...values);
  const n = Math.max(values.length, 1);

  const bar = (
    <svg className="pp-chart-svg" viewBox={`0 0 ${Math.max(320, n * 44)} 220`} role="img" aria-label="bar chart">
      {values.map((v, i) => {
        const h = (v / max) * 180;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 柱状图按数据序渲染
          <rect key={i} x={i * 44 + 14} y={200 - h} width={24} height={Math.max(h, 1)} className="pp-chart-bar" />
        );
      })}
    </svg>
  );

  const line = (
    <svg className="pp-chart-svg" viewBox="0 0 400 220" role="img" aria-label="line chart">
      <polyline
        points={values.map((v, i) => `${(i / Math.max(1, n - 1)) * 380 + 10},${200 - (v / max) * 180}`).join(' ')}
        className="pp-chart-line"
      />
    </svg>
  );

  const pie = (
    <div className="pp-chart-pie" role="img" aria-label="pie chart">
      {values.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 扇区按数据序渲染
          key={i}
          className="pp-chart-pie-seg"
          style={
            {
              '--seg': `${
                (v /
                  Math.max(
                    1,
                    values.reduce((a, b) => a + b, 0),
                  )) *
                360
              }deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );

  const scatter = (
    <svg className="pp-chart-svg" viewBox="0 0 400 220" role="img" aria-label="scatter chart">
      {values.map((v, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 散点图按数据序渲染
        <circle key={i} cx={10 + ((i * 37) % 380)} cy={200 - (v / max) * 180} r={5} className="pp-chart-dot" />
      ))}
    </svg>
  );

  return (
    <div className="pp-chart">
      <div className="pp-chart-type">{type}</div>
      {type === 'line' ? line : type === 'pie' ? pie : type === 'scatter' ? scatter : bar}
      {labels.length > 0 && (
        <div className="pp-chart-labels">
          {labels.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 标签按数据序渲染
            <span key={i}>{l}</span>
          ))}
        </div>
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

/** 11 个资产表现原语的注册表入口（供渲染器 cordis 插件装载）。 */
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
  | 'citation';

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
  };
}
