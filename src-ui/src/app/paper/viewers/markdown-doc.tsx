// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// Markdown 独立查看器本体（渲染面补全 P3 · B14，2026-09-23）——左侧标题树 + 右侧正文，
// 正文交应用侧 markdown 渲染器（`app/paper/builtin-renderers.tsx` 的 `MarkdownBody`，经
// `builtinRendererDefs()` 取件），本件**不写第二份 markdown 解析**。产物域拿不到那个模块
// ⇒ 产物侧只登记认领与读取形态（`plugins/builtin/renderers/viewers/markdown-doc.ts` 的
// `heavy: 'markdown-doc'`），本体住应用 bundle（`app/paper/viewers/` 目录即白名单）。
// 读取形态 = `bytesKind:'text'`（宿主走 `fs_cap read` 开行窗口，不整份进 IPC）。
//
// 标题树与正文的分段**同一份判据**（`splitMarkdownSections`）：在 `#`/`##`/`###` 行处切段，
// 每段自带一个 `<section>` 包裹元素——点标题即 `section.scrollIntoView()`。为什么切段而不是
// 「数第 N 个 h*」：渲染器把引用块内的标题也渲染成 `h*`（`> # x`），按下标找会错位；切段后
// 锚点与标题树同源，**不改应用侧渲染器**就有了稳定落点。围栏码里的 `# 伪标题` 不算标题
// （与 `paper/markdown.ts` 的行纪律同款：进围栏即不动结构）。
//
// 窄容器纪律（**容器宽度**判据，不是视口）：`ResizeObserver` 量本查看器根元素宽度，
// `< 640px` ⇒ 标题树折叠成一行「目录 · N 个标题」按钮（点开覆盖式展开，跳转后自动收起）。
// 取容器宽度而非媒体查询：查看器住在纸面版心列里，视口宽 ≠ 版心宽。
//
// 失败面（宪法「错误不静默」）：无字节 / 字节形态不符（宿主声明 text 却给 data URI）/
// 空文本（含纯空白）——每种都出一行可读错误或空态，不空白。
// 截断**可见**（同 code.tsx 纪律）：宿主按 `readLines + 1` 行开窗，窗口满 ⇒ 只渲染前
// `MDDOC_LINE_CAP` 行 + 吸顶横幅说清「文件更长」，不静默丢尾巴。
//
// 如实标注的未支持项：脚注 / 数学（KaTeX 渲染由应用侧渲染器负责，本件不额外接线）/
// 行内 HTML（渲染器按字面处理，本件不注入 DOM）· 标题树只收 `#`/`##`/`###`（h4+ 与引用块内
// 的标题不进树，仍在正文里照常渲染）· 无编辑入口（只读查看）。

import * as React from 'react';
import { createBlock } from '../../../paper/block-model';
import type { ViewerProps } from '../../../plugins/builtin/renderers/viewer-registry';
import { builtinRendererDefs } from '../builtin-renderers';
import './markdown-doc.css';

/** 窄容器阈值（容器宽度 < 此值 ⇒ 标题树折叠为一行按钮）。 */
export const MDDOC_NARROW_PX = 640;

/** 行窗口（与产物侧注册面 `readLines` **同值**——宿主多读 1 行作「文件更长」判据）。 */
export const MDDOC_LINE_CAP = 8000;

/** 正文一段（标题行起、下一个标题行止；`level: 0` = 首个标题之前的引子，不进标题树）。 */
export interface MdDocSection {
  level: 0 | 1 | 2 | 3;
  title: string;
  text: string;
}

/** 标题树条目（`section` = 它在 `splitMarkdownSections` 结果里的下标 = 锚点）。 */
export interface MdDocHeading {
  level: 1 | 2 | 3;
  title: string;
  section: number;
}

/** 围栏码开标记（与 `paper/markdown.ts` 的 `FENCE_RE` 同形）。 */
const FENCE_RE = /^(```|~~~)\s*([^`]*)$/;
/** 标题行（与 `paper/markdown.ts` 的 `HEADING_RE` 同形，只收 1-3 级——4 级以上不进标题树）。 */
const HEADING_RE = /^(#{1,3})\s+(.*)$/;

/** 标题文本去行内标记（标题树是导航面，不是正文：`**粗**` / `` `码` `` / `[字](url)` 只留字）。 */
function plainTitle(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\$([^$]*)\$/g, '$1')
    .trim();
}

/** 行窗口解算（**纯函数**）：宿主读回的是 `readLines + 1` 行——行数超出上限 ⇒ 截断，
 *  只取前 `MDDOC_LINE_CAP` 行（末行存在即「文件更长」，渲染面据此出吸顶横幅）。 */
export function windowedText(text: string): { text: string; truncated: boolean } {
  if (text.length === 0) return { text, truncated: false };
  const lines = text.split('\n');
  if (lines.length <= MDDOC_LINE_CAP) return { text, truncated: false };
  return { text: lines.slice(0, MDDOC_LINE_CAP).join('\n'), truncated: true };
}

/** markdown 文本 → 正文段（**纯函数**，导出 = 测试直呼面；标题树与锚点同源）。 */
export function splitMarkdownSections(text: string): MdDocSection[] {
  if (text.trim().length === 0) return [];
  const sections: MdDocSection[] = [];
  let cur: MdDocSection | null = null;
  const append = (line: string): void => {
    if (cur === null) {
      cur = { level: 0, title: '', text: '' };
      sections.push(cur);
    }
    cur.text = cur.text === '' ? line : `${cur.text}\n${line}`;
  };
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (fence !== null) {
      // 围栏码内部不动结构（`# 伪标题` 是代码，不是标题）
      if (trimmed.startsWith(fence)) fence = null;
      append(line);
      continue;
    }
    const open = FENCE_RE.exec(trimmed);
    if (open) {
      fence = open[1];
      append(line);
      continue;
    }
    const h = HEADING_RE.exec(trimmed);
    if (h) {
      cur = { level: h[1].length as 1 | 2 | 3, title: plainTitle(h[2].trim()), text: line };
      sections.push(cur);
      continue;
    }
    append(line);
  }
  return sections.filter((s) => s.text.trim() !== '');
}

/** 正文段 → 标题树（按正文序；`level: 0` 的引子不进树）。 */
export function outlineOf(sections: readonly MdDocSection[]): MdDocHeading[] {
  const out: MdDocHeading[] = [];
  sections.forEach((s, i) => {
    if (s.level === 0) return;
    out.push({ level: s.level, title: s.title, section: i });
  });
  return out;
}

/** `builtinRendererDefs()` 是冻结表（模块装载期建一次）——取 kind='markdown' 那一行。 */
const MarkdownView = builtinRendererDefs().find((d) => d.kind === 'markdown')?.component ?? null;

/** 正文一段：构造 viewer 自己的 markdown 块，交给应用侧渲染器（零第二份解析）。 */
function MdDocSectionView({
  text,
  level,
  sectionRef,
}: {
  text: string;
  level: 0 | 1 | 2 | 3;
  sectionRef: (el: HTMLElement | null) => void;
}) {
  const block = React.useMemo(() => createBlock('markdown', { text }, { messageId: 'viewer', part: null }), [text]);
  return (
    <section ref={sectionRef} className={`pp-viewer-mddoc-section pp-viewer-mddoc-section--lv${level}`}>
      {MarkdownView ? (
        React.createElement(MarkdownView, { block })
      ) : (
        <div className="pp-viewer-mddoc-missing">
          应用侧 markdown 渲染器缺失（builtinRendererDefs 里没有 kind='markdown' 的行）——本段原文：
          {text.slice(0, 200)}
        </div>
      )}
    </section>
  );
}

/** 查看器本体（宿主渲染面契约见 viewer-registry 的 ViewerProps）。 */
export default function MarkdownDocViewer({ label, ext, filePath, bytes, mode }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const view = React.useMemo(() => windowedText(text), [text]);
  const sections = React.useMemo(() => splitMarkdownSections(view.text), [view.text]);
  const headings = React.useMemo(() => outlineOf(sections), [sections]);
  const [active, setActive] = React.useState<number | null>(null);
  const [tocOpen, setTocOpen] = React.useState(false);
  const [narrow, setNarrow] = React.useState(false);
  const sectionRefs = React.useRef<Array<HTMLElement | null>>([]);

  /* 窄容器判据 = 本查看器根元素宽度（视口宽 ≠ 版心宽）。
   * ResizeObserver 一处跟上（jsdom 无 RO：只量首帧，测试自铺桩——同 use-composer-float 先例）。 */
  const attachRoot = React.useCallback((el: HTMLDivElement | null) => {
    if (el === null) return undefined;
    const measure = (): void => setNarrow(el.clientWidth > 0 && el.clientWidth < MDDOC_NARROW_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 点标题：滚动到该段锚点（窄档顺手收起目录）。 */
  const jump = (sectionIndex: number): void => {
    setActive(sectionIndex);
    setTocOpen(false);
    sectionRefs.current[sectionIndex]?.scrollIntoView({ block: 'start' });
  };

  // 文本查看器没有放大形态（同 code.tsx：浮层对文本无意义）
  if (mode === 'overlay') return null;
  if (!bytes) {
    return (
      <div className="pp-viewer-empty">未取到 Markdown 内容（{label || ext || filePath || '文件'}）——无法查看</div>
    );
  }
  if (bytes.kind !== 'text') {
    return (
      <div className="pp-viewer-error">
        Markdown 查看器按文本形态读取（宿主声明 bytesKind:'text' 的行窗口），收到的是 base64 data URI（
        {bytes.value.length} 字符）——宿主读取形态与查看器声明不一致
      </div>
    );
  }
  const pathNote = filePath ? ` · ${filePath}` : '';
  if (text.trim().length === 0) {
    return <div className="pp-viewer-empty">Markdown 为空（0 字符）——没有可显示的正文{pathNote}</div>;
  }
  const showToc = headings.length > 0 && (!narrow || tocOpen);
  return (
    <div ref={attachRoot} className={`pp-viewer-mddoc${narrow ? ' pp-viewer-mddoc--narrow' : ''}`}>
      {view.truncated && (
        <div className="pp-viewer-note">
          已截断：只显示前 {MDDOC_LINE_CAP} 行（文件更长）——行窗口是不整份进 IPC 的闸
        </div>
      )}
      {narrow && headings.length > 0 && (
        <button
          type="button"
          className="pp-viewer-mddoc-tocbtn"
          aria-expanded={tocOpen}
          onClick={() => setTocOpen((v) => !v)}
        >
          目录 · {headings.length} 个标题
        </button>
      )}
      <div className="pp-viewer-mddoc-body">
        {showToc && (
          <nav className="pp-viewer-mddoc-toc" aria-label="标题树">
            <div className="pp-viewer-mddoc-tochead">目录 · {headings.length} 个标题</div>
            <ul className="pp-viewer-mddoc-toclist">
              {headings.map((h) => (
                <li key={`${h.section}-${h.level}`} className="pp-viewer-mddoc-tocrow">
                  <button
                    type="button"
                    className={`pp-viewer-mddoc-tocitem pp-viewer-mddoc-lv${h.level}${
                      active === h.section ? ' pp-viewer-mddoc-tocitem--on' : ''
                    }`}
                    title={h.title || '(无标题)'}
                    onClick={() => jump(h.section)}
                  >
                    {h.title || '(无标题)'}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="pp-viewer-mddoc-main">
          {sections.map((s, i) => (
            <MdDocSectionView
              // biome-ignore lint/suspicious/noArrayIndexKey: 正文段按位渲染（文序即身份）
              key={i}
              text={s.text}
              level={s.level}
              sectionRef={(el) => {
                sectionRefs.current[i] = el;
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
