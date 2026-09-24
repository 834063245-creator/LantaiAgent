// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// PDF 查看器本体（渲染面补全 P2 · B3，2026-09-23）——**重依赖查看器**：
// 产物侧只登记认领（`plugins/builtin/renderers/viewers/pdf.ts` 的 `heavy: 'pdf'`），
// 本体住应用 bundle（`app/paper/viewers/` 目录即白名单，vite 真分片），宿主经宿主桥
// `loadViewer('pdf')` 取件。产物域禁动态裸 import（D3 修订），故 pdfjs 只能编译在这里。
//
// pdfjs 接线（**实测于 pdfjs-dist@6.3.289 的真产物路径**，不是文档抄来的）：
//   · 主模块 = `pdfjs-dist/legacy/build/pdf.mjs`（**legacy** 构建）。取 legacy 不是保守，
//     是**唯一能跑**的一条：非 legacy 的 `build/pdf.mjs` 在模块初始化就算 md5，用到
//     `Uint8Array.prototype.toHex`（ES2026 提案）——Node 24 没有它，jsdom 里 import 即抛
//     `hashOriginal.toHex is not a function`；legacy 构建自带 polyfill，WebView2 老版本同理安全。
//     该文件的 TS 类型走 `legacy/build/pdf.d.mts`（`export * from "pdfjs-dist"`）。
//   · worker = `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url` → `GlobalWorkerOptions.workerSrc`。
//     Vite 把它当**资源**发出去（dist/assets/pdf.worker.min-*.mjs，独立文件），
//     **不走 CDN**（离线桌面应用）。worker 是 module worker（pdfjs 自建时带 `{type:'module'}`）。
//   · 不打包 `cmaps/` / `standard_fonts/` / `wasm/`（三者都要**目录前缀** URL，而 vite 发的
//     资源带内容哈希 ⇒ 前缀拼不出来；落 public/ 或改 vite 配置不在本批文件面内）：
//     非内嵌标准字体走**系统字体回退**（pdfjs 缺省，console 一条 warn）；CJK 标准 CMap
//     取不到 ⇒ **未内嵌 CJK 字体的档文字可能缺失**；JPEG2000（openjpeg wasm）图可能画不出。
//
// 两态（D2 定案）：
//   · `mode:'stream'`（流内）——**首页缩略图 + 页数读数**，点按钮 `onOpenOverlay()` 进浮层；
//   · `mode:'overlay'`（浮层）——全篇：翻页 + 缩放 + **文本层可选中**。
//
// 失败面（宪法「错误不静默」）：无字节 / 字节形态不符 / 坏 base64 / 空载荷 / 非 PDF /
// 加密 / 无页 / 页数超上限 / 单页超像素上限 / 无 canvas 上下文 —— 每一种都出一行**可读错误
// 或显式标注**（带 pdfjs 原话），不空白、不 JSON 兜底。缩略图（canvas）与文本层是**两条独立
// 失败面**：canvas 画不出来不影响页数读数与文本层（反之亦然）。
//
// 如实标注的简化（**未支持项**）：加密 PDF 不给密码输入框（只报「需密码」）· 注释层 / 表单 /
// 签名 / 附件 **不渲染** · 一次一页（无连续滚动、无「适应宽度」档，只有固定缩放档）· 旋转由
// viewport 自带，横向拉伸矫正 scaleX 未做 · 文本层是**近似落位**（自绘 span：用
// `Util.transform` 取位置与字号，不引 pdfjs 自带 text_layer 的 CSS/字体度量）——选文与复制
// 可用，不承诺与字形逐像素重合 · 不做文本搜索 / 大纲 / 缩略图侧栏。

import {
  GlobalWorkerOptions,
  getDocument,
  InvalidPDFException,
  type PageViewport,
  PasswordException,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
  Util,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import * as React from 'react';
import type { ViewerBytes, ViewerProps } from '../../../paper/viewer-contract';
import './pdf.css';

/** worker 资源（Vite 发成独立资源文件；模块装载期一次，`getDocument` 前必须就位）。 */
GlobalWorkerOptions.workerSrc = workerUrl;

/** 逐页浏览的页数上限（超过**显式标注**：仍按当前页渲染，只是不预取整册）。 */
export const PDF_MAX_PAGES = 500;
/** 单页渲染上限（设备像素，宽高各自）；超出按比例缩回并**显式标注**。 */
export const PDF_MAX_PAGE_PX = 4096;
/** 缩放档（浮层）；1 = 原始尺寸。 */
export const PDF_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
/** 默认缩放档的**下标**（`PDF_ZOOM_STEPS` 里 1 = 原始尺寸 那一档）。 */
const DEFAULT_ZOOM_IDX = 2;

/** base64 字符 4 → 3 字节：宿主按原始字节判 maxBytes，这里只做解码。 */
function decodePdfDataUri(value: string): Uint8Array {
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma < 0) {
    throw new Error('字节不是 data URI 形态（宿主读取形态与查看器声明不一致）');
  }
  const header = value.slice(0, comma);
  if (!header.includes(';base64')) {
    throw new Error(`字节不是 base64 编码的 data URI（收到 ${header}）`);
  }
  const payload = value.slice(comma + 1).trim();
  if (!payload) throw new Error('PDF 字节为空（base64 载荷长度 0）');
  let binary: string;
  try {
    binary = atob(payload);
  } catch (e) {
    throw new Error(`base64 解码失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** pdfjs 异常 → **一行可读中文**（带 pdfjs 原话，错误即导航）。导出 = 测试直呼面。 */
export function pdfErrorMessage(err: unknown): string {
  if (err instanceof PasswordException) {
    return `PDF 已加密、需要密码（pdfjs：${err.message}）——本查看器不提供密码输入`;
  }
  if (err instanceof InvalidPDFException) {
    return `不是有效的 PDF（pdfjs：${err.message}）`;
  }
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** 渲染被取消（卸载/换页/换缩放档）不是失败——不落错误行（pdfjs 抛 RenderingCancelledException）。 */
function isRenderCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'RenderingCancelledException';
}

/** 文本层条目（`pdfjs-dist` 入口不导出 `TextItem` 类型，取结构子集）。 */
export interface PdfTextItem {
  text: string;
  /** 文本矩阵 [a,b,c,d,e,f]（PDF 用户空间） */
  transform: number[];
}

/** 一条已落位的文本 span（CSS px，相对页面左上角）。*/
export interface PdfTextSpan {
  text: string;
  left: number;
  top: number;
  fontSize: number;
  /** 旋转角（弧度；0 = 横排） */
  angle: number;
}

/** `getTextContent()` 的 items → 结构子集（`TextMarkedContent` 无 `str`，跳过）。 */
function collectTextItems(items: ReadonlyArray<unknown>): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const item of items) {
    if (item == null || typeof item !== 'object' || !('str' in item)) continue;
    const it = item as { str: unknown; transform?: unknown };
    if (typeof it.str !== 'string' || !Array.isArray(it.transform)) continue;
    out.push({ text: it.str, transform: it.transform as number[] });
  }
  return out;
}

/** 文本层落位（**纯函数**，导出 = 测试直呼面）：pdfjs 的 `Util.transform(viewport.transform,
 *  item.transform)` 给出该段文字在页面坐标系里的矩阵——`[4]/[5]` 是基线与原点，字高 =
 *  `hypot([2],[3])`，旋转角 = `atan2([1],[0])`。**不复制** pdfjs 自带 TextLayer 的横向
 *  拉伸矫正（scaleX），故与字形是近似重合（头注「如实标注」栏）。 */
export function layoutPdfText(items: readonly PdfTextItem[], viewport: PageViewport): PdfTextSpan[] {
  const out: PdfTextSpan[] = [];
  for (const item of items) {
    if (!item.text) continue;
    const tx = Util.transform(viewport.transform, item.transform);
    const fontSize = Math.hypot(tx[2], tx[3]);
    if (!(fontSize > 0) || !Number.isFinite(tx[4]) || !Number.isFinite(tx[5])) continue;
    out.push({
      text: item.text,
      left: tx[4],
      top: tx[5] - fontSize,
      fontSize,
      angle: Math.atan2(tx[1], tx[0]),
    });
  }
  return out;
}

/** 单页渲染上限解算（**纯函数**，导出 = 测试直呼面）：请求缩放 × 设备像素比后的设备像素
 *  宽高若超过 `PDF_MAX_PAGE_PX`，按同一比例缩回并置 `clamped`（渲染面据此**显式标注**）。 */
export function clampPageScale(opts: { baseW: number; baseH: number; scale: number; outputScale: number }): {
  scale: number;
  width: number;
  height: number;
  clamped: boolean;
} {
  const { baseW, baseH, outputScale } = opts;
  const dims = (s: number): { width: number; height: number } => ({
    width: Math.max(1, Math.round(baseW * s * outputScale)),
    height: Math.max(1, Math.round(baseH * s * outputScale)),
  });
  let scale = opts.scale;
  let px = dims(scale);
  let clamped = false;
  const over = Math.max(px.width, px.height);
  if (over > PDF_MAX_PAGE_PX) {
    scale *= PDF_MAX_PAGE_PX / over;
    px = dims(scale);
    clamped = true;
  }
  return { scale, width: px.width, height: px.height, clamped };
}

/** 一条文本 span 的 inline 样式（位置 / 字号 / 旋转；字号是数字 ⇒ React 补 px）。 */
function textSpanStyle(s: PdfTextSpan): React.CSSProperties {
  return {
    left: s.left,
    top: s.top,
    fontSize: s.fontSize,
    transform: s.angle !== 0 ? `rotate(${s.angle}rad)` : undefined,
  };
}

/** 设备像素比（夹到 1–2：高分屏清晰度 vs 渲染预算，单页上限另由 clampPageScale 兜）。 */
function devicePixelRatioClamped(): number {
  const raw = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.min(Math.max(raw, 1), 2);
}

type DocState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy }
  | { status: 'error'; message: string };

type PageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; width: number; height: number; ratio: number; clamped: boolean }
  | { status: 'error'; message: string };

/** 查看器本体（宿主渲染面契约见 viewer-registry 的 ViewerProps）。 */
export default function PdfViewer({ label, ext, filePath, bytes, mode, onOpenOverlay }: ViewerProps) {
  const overlay = mode === 'overlay';
  const dataUri: string | undefined = bytes?.kind === 'data-uri' ? bytes.value : undefined;
  const textBytes: ViewerBytes | undefined = bytes?.kind === 'text' ? bytes : undefined;
  const [docState, setDocState] = React.useState<DocState>({ status: 'idle' });
  const [pageState, setPageState] = React.useState<PageState>({ status: 'idle' });
  /** 页面盒尺寸（CSS px）——viewport 一算出来就落，**不等 canvas 成功**：
   *  浮层里文本层与画布共用这个参照系，canvas 失败时选文仍不会被压成 0 高。 */
  const [pageBox, setPageBox] = React.useState<{ width: number; height: number } | null>(null);
  const [spans, setSpans] = React.useState<PdfTextSpan[]>([]);
  const [textNote, setTextNote] = React.useState<string | null>(null);
  const [pageNum, setPageNum] = React.useState(1);
  const [zoomIdx, setZoomIdx] = React.useState(DEFAULT_ZOOM_IDX);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  /* ① 解析文档：字节 →（解码）→ getDocument。换文件/字节即整册重建，卸载即销毁
   *    （v6 的销毁入口在 loadingTask 上——`PDFDocumentProxy.destroy` 已不存在）。 */
  React.useEffect(() => {
    setDocState({ status: 'idle' });
    setPageState({ status: 'idle' });
    setSpans([]);
    setTextNote(null);
    setPageNum(1);
    if (!dataUri) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    setDocState({ status: 'loading' });
    void (async () => {
      try {
        const data = decodePdfDataUri(dataUri);
        task = getDocument({
          data,
          // 不打包 standard_fonts ⇒ 标准字体走系统字体（pdfjs 缺省行为，写明意图）。
          // 注：v6 已无 `isEvalSupported`（eval 路径整条拆掉），解析在本进程外的 worker 里跑。
          useSystemFonts: true,
        });
        const loading = task;
        if (cancelled) {
          void loading.destroy().catch(() => undefined);
          return;
        }
        const proxy = await loading.promise;
        if (cancelled) return;
        if (proxy.numPages < 1) throw new Error('PDF 里没有页面（pdfjs numPages=0）');
        setDocState({ status: 'ready', doc: proxy });
      } catch (e) {
        if (!cancelled) setDocState({ status: 'error', message: pdfErrorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
      const t = task;
      task = null;
      void t?.destroy().catch(() => undefined);
    };
  }, [dataUri]);

  const doc = docState.status === 'ready' ? docState.doc : null;
  const numPages = docState.status === 'ready' ? docState.doc.numPages : 0;
  const zoom = PDF_ZOOM_STEPS[zoomIdx];

  /* ② 渲染当前页：文本层（仅浮层）先落 → canvas 绘制。两条失败面各自可读、互不吞：
   *    jsdom 这类无 2D 上下文的环境里 canvas 必败，页数读数与选文仍成立（真实环境反之亦然）。 */
  React.useEffect(() => {
    setSpans([]);
    setTextNote(null);
    setPageBox(null);
    const canvas = canvasRef.current;
    if (!doc || !canvas) {
      setPageState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    setPageState({ status: 'loading' });
    void (async () => {
      let page: PDFPageProxy | null = null;
      try {
        page = await doc.getPage(pageNum);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const fit = clampPageScale({
          baseW: base.width,
          baseH: base.height,
          scale: zoom,
          outputScale: devicePixelRatioClamped(),
        });
        const viewport = page.getViewport({ scale: fit.scale });
        setPageBox({ width: viewport.width, height: viewport.height });
        if (overlay) {
          try {
            const content = await page.getTextContent();
            if (cancelled) return;
            setSpans(layoutPdfText(collectTextItems(content.items), viewport));
          } catch (e) {
            if (!cancelled) setTextNote(`文本层不可用：${pdfErrorMessage(e)}`);
          }
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('此环境取不到 2D 画布上下文（无 canvas 实现）');
        const ratio = devicePixelRatioClamped();
        canvas.width = Math.max(1, Math.round(viewport.width * ratio));
        canvas.height = Math.max(1, Math.round(viewport.height * ratio));
        task = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        await task.promise;
        if (cancelled) return;
        setPageState({
          status: 'ready',
          width: viewport.width,
          height: viewport.height,
          ratio: fit.scale / zoom,
          clamped: fit.clamped,
        });
      } catch (e) {
        if (!cancelled && !isRenderCancelled(e)) setPageState({ status: 'error', message: pdfErrorMessage(e) });
      } finally {
        page?.cleanup();
      }
    })();
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* 已结束的渲染任务 cancel 会抛——清理路径不吵 */
      }
    };
  }, [doc, pageNum, zoom, overlay]);

  /* ── 无字节 / 形态不符 / 解析失败：三条可读出口（都不空白） ── */
  if (!bytes) {
    return <div className="pp-viewer-empty">未取到 PDF 字节（{label || ext || filePath || '文件'}）——无法预览</div>;
  }
  if (textBytes) {
    return (
      <div className="pp-viewer-error">
        PDF 查看器要 base64 data URI 字节，收到的是文本形态（{textBytes.value.length} 字符）
        ——宿主读取形态与查看器声明不一致
      </div>
    );
  }
  if (docState.status === 'error') {
    return (
      <div className="pp-viewer-error">
        {docState.message}
        {filePath ? ` · ${filePath}` : ''}
      </div>
    );
  }
  if (docState.status !== 'ready') {
    return <div className="pp-viewer-empty">正在解析 PDF…</div>;
  }

  const pageLabel = overlay ? `第 ${pageNum} / ${numPages} 页` : `共 ${numPages} 页`;
  const target = overlay ? `第 ${pageNum} 页` : '首页';
  const ready = pageState.status === 'ready';
  return (
    <div className={`pp-viewer-pdf pp-viewer-pdf--${overlay ? 'overlay' : 'stream'}`}>
      <div className="pp-viewer-pdf-bar">
        <span className="pp-viewer-pdf-pages">{pageLabel}</span>
        {overlay ? (
          <>
            <button
              type="button"
              className="pp-viewer-pdf-btn"
              onClick={() => setPageNum((n) => Math.max(1, n - 1))}
              disabled={pageNum <= 1}
            >
              上一页
            </button>
            <button
              type="button"
              className="pp-viewer-pdf-btn"
              onClick={() => setPageNum((n) => Math.min(numPages, n + 1))}
              disabled={pageNum >= numPages}
            >
              下一页
            </button>
            <button
              type="button"
              className="pp-viewer-pdf-btn"
              onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
              disabled={zoomIdx <= 0}
              aria-label="缩小"
            >
              −
            </button>
            <span className="pp-viewer-pdf-zoom">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              className="pp-viewer-pdf-btn"
              onClick={() => setZoomIdx((i) => Math.min(PDF_ZOOM_STEPS.length - 1, i + 1))}
              disabled={zoomIdx >= PDF_ZOOM_STEPS.length - 1}
              aria-label="放大"
            >
              +
            </button>
          </>
        ) : (
          <button type="button" className="pp-viewer-pdf-btn" onClick={onOpenOverlay} disabled={!onOpenOverlay}>
            翻页 · 缩放 · 选文
          </button>
        )}
      </div>
      {numPages > PDF_MAX_PAGES && (
        <div className="pp-viewer-note">
          共 {numPages} 页，超过查看器页数上限 {PDF_MAX_PAGES} 页——只渲染当前页，不预取整册
        </div>
      )}
      {pageState.status === 'error' && (
        <div className="pp-viewer-error">
          {target}渲染失败：{pageState.message}
        </div>
      )}
      {ready && pageState.clamped && (
        <div className="pp-viewer-note">
          单页渲染上限 {PDF_MAX_PAGE_PX}px：本页已按 {Math.round(pageState.ratio * 100)}% 缩放渲染
        </div>
      )}
      {textNote && <div className="pp-viewer-note">{textNote}</div>}
      <div className="pp-viewer-pdf-stage">
        <div
          className="pp-viewer-pdf-page"
          style={overlay && pageBox ? { width: pageBox.width, height: pageBox.height } : undefined}
        >
          <canvas
            ref={canvasRef}
            className="pp-viewer-pdf-canvas"
            aria-label={`${label || ext || 'PDF'} · ${pageLabel}`}
          />
          {overlay && spans.length > 0 && (
            <div className="pp-viewer-pdf-text">
              {spans.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 文本层按 pdfjs 给出的次序铺，序即身份
                <span key={i} className="pp-viewer-pdf-text-item" style={textSpanStyle(s)}>
                  {s.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
