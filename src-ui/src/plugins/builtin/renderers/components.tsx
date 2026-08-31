// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 内置渲染器插件（P1，first-party-hot-reload-plan）——8 个资产表现原语
// （grid/chart/metric/media/graph/tree/html/form）的唯一真源。
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
//   - graph/tree 用确定性树布局（A5：tree 布局首发，力导向不做）。
//   - html 走沙箱 iframe（WO-8）：sandbox + 文档内 CSP，网络全 never。

import type { CSSProperties, ReactNode } from 'react';
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

function chartValues(data: unknown): number[] {
  if (!Array.isArray(data)) return [];
  return data.map((d) => {
    if (typeof d === 'number') return d;
    if (d && typeof d === 'object') {
      const v = (d as { value?: unknown }).value;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  });
}

function ChartBody({ block }: BlockRendererProps) {
  const p = block.payload as { type?: string; data?: unknown; config?: Record<string, unknown> };
  const type = typeof p.type === 'string' ? p.type : 'bar';
  const values = chartValues(p.data);
  const labels = Array.isArray(p.data)
    ? p.data.map((d) => (d && typeof d === 'object' ? String((d as { label?: unknown }).label ?? '') : ''))
    : [];
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
    rendererRpc('read_file_base64', { file_path: filePath })
      .then((b64) => {
        if (!cancelled) setState({ status: 'ready', data: String(b64) });
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

/* ── graph / tree（确定性 SVG tree 布局，A5）── */

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

function GraphTreeBody({ block }: BlockRendererProps) {
  const { nodes, edges } = normalizeGraph(block.payload);
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
  const W = Math.max(320, (maxDepth + 1) * 160 + 40);
  const H = Math.max(80, nodes.length * 52 + 30);
  const lines = edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return null;
      return (
        <line
          key={`${e.from}->${e.to}`}
          x1={a.x * 160 + 40}
          y1={a.y * 52 + 26}
          x2={b.x * 160 + 40}
          y2={b.y * 52 + 26}
          className="pp-graph-edge"
        />
      );
    })
    .filter(Boolean);
  return (
    <div className="pp-graph">
      <svg className="pp-graph-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="graph">
        {lines}
        {nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          return (
            <g key={n.id} transform={`translate(${p.x * 160 + 40}, ${p.y * 52 + 26})`} className="pp-graph-node">
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
      <div className="pp-form-actions">
        <button type="button" className="pp-form-confirm" disabled>
          {p.confirmLabel || '确认'}
        </button>
      </div>
    </div>
  );
}

/** 8 个资产表现原语的注册表入口（供渲染器 cordis 插件装载）。 */
export type AssetRendererKind = 'grid' | 'chart' | 'metric' | 'media' | 'graph' | 'tree' | 'html' | 'form';

export function assetRendererComponents(): Record<AssetRendererKind, (props: BlockRendererProps) => ReactNode> {
  return {
    grid: GridBody,
    chart: ChartBody,
    metric: MetricBody,
    media: MediaBody,
    graph: GraphTreeBody,
    tree: GraphTreeBody,
    html: HtmlBody,
    form: FormBody,
  };
}
