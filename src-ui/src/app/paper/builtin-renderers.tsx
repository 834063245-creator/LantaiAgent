// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 出厂块渲染器（内置注疏渲染器十一件 + '*' 兜底）——M2 收口（2026-09-14）。
//
// 缘起：这些实现原与「第五贡献通道」（RendererRegistry / RenderersService /
// resolveRenderer）同处 composition/renderer-service.tsx——通道属内核线
// （永不插件化），实现是产品；两者同居使该文件 1106 行里只有约 120 行是通道，
// 其余约 980 行是 markdown / 代码高亮 / katex 数学 / diff / plan / tool / user
// 的体渲染实现。M2 把实现搬到 UI 层（本文件），通道文件恢复成通道。
//
// 归属纪律：本文件随应用编译进 bundle——**不是** plugins/builtin/renderers
// 产物（后者是资产表现原语十一件，随插件开关可禁用）；本文件的十一 kind 全谱
// 是纸壳的默认渲染面，禁用它等于纸壳裸奔。
//
// 注册点：rendererServicePlugin（装配点/wiring）——不是 RenderersService
// 构造器（通道/registry）。通道类只做注册表，出厂行由产品装配点喂入。

import hljs from 'highlight.js/lib/common';
import hljsClojure from 'highlight.js/lib/languages/clojure';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsHaskell from 'highlight.js/lib/languages/haskell';
import hljsJulia from 'highlight.js/lib/languages/julia';
import hljsLatex from 'highlight.js/lib/languages/latex';
import hljsMatlab from 'highlight.js/lib/languages/matlab';
import hljsScala from 'highlight.js/lib/languages/scala';
import hljsScheme from 'highlight.js/lib/languages/scheme';
import katex from 'katex';
import type { ReactNode } from 'react';
import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import type { PlanApprovalResponse, PlanOptionOutcome } from '../../agent/plan/plan-tools';
import type { BlockRendererContribution, BlockRendererProps } from '../../composition/renderer-service';
import { foldLabel, foldPreviewLine } from '../../paper/fold';
import {
  type MdBlock,
  type MdInline,
  type MdParseState,
  parseMarkdown,
  parseMarkdownIncremental,
} from '../../paper/markdown';
import { parseCircledSegments } from '../../paper/marks';
import {
  codeDisplay,
  hasArgsToShow,
  hasPayloadToShow,
  type ToolDisplay,
  type ToolSpan,
  type ToolTone,
  toolDisplay,
} from '../../paper/tool-text';
import type { ChatImageRef } from '../../provider/types';
import { previewUrlFor, readAttachmentBase64 } from '../chat/image-intake';
import { Overlay } from '../overlay';
import { useShellStore } from '../shell-store';
// mermaid 围栏渲染器（B6 · P2）：本体在应用侧（`mermaid` 重依赖走动态 import 分片），
// 解析失败时它把 fallback（原代码块）原样放回——降级链在它内部，本文件只做认领。
import MermaidBlock from './mermaid-block';

/* ── 流式增量渐显（streaming-fade-render-plan 2026-08-30）──
 * 把「新长出来的文本」与「旧文本」分开：旧文本零动画（流式重渲染不闪），
 * 增量段做一次极轻淡入（0.2s，Claude Code 桌面端同款观感）。
 *
 * 识别原理（零数据层侵入）：流式 = 文本在尾部追加。渲染器用 ref 记上一帧
 * 文本，本帧文本以它为前缀 → 尾部就是增量；非追加（编辑/回填）→ 整块稳定。
 * 分隔点取「旧文本最后一个换行」：旧部分以完整行收尾，增量段从行首开始，
 * markdown 结构在边界两侧都不会被腰斩。
 *
 * 折叠态（reasoning 收折/展开）会整体重渲染：folded 变化时重置 ref，
 * 不把已经展示过的内容误判成增量。 */

interface StreamDelta {
  /** 稳定段文本 = 旧文本全部（已展示内容，零动画、零重复） */
  stable: string;
  /** 增量段文本 = 真正新到达的部分（只有它淡入） */
  delta: string;
}

/**
 * 流式增量识别：文本尾部追加 → 增量；否则整块稳定。
 * 稳定段永远 = 旧文本全部（渲染层镜像：markdown 走 parseMarkdown、纯文本原样）——
 * 已展示内容不重复、不重淡。增量段 = 新字符（markdown 里作为独立块从行边界开始，
 * 流式半成型可接受；纯文本里行内接续）。
 */
function useStreamDelta(text: string, resetKey: unknown): StreamDelta {
  const prevRef = useRef<string | null>(null);
  const lastKeyRef = useRef<unknown>(undefined);

  // resetKey（folded 等）变化 → 重置：整块稳定，不留增量尾巴
  if (lastKeyRef.current !== resetKey) {
    lastKeyRef.current = resetKey;
    prevRef.current = text;
    return { stable: text, delta: '' };
  }

  const prev = prevRef.current;
  if (prev === null || text === prev) {
    prevRef.current = text;
    return { stable: text, delta: '' };
  }
  if (text.startsWith(prev)) {
    prevRef.current = text;
    return { stable: prev, delta: text.slice(prev.length) };
  }
  // 非追加（编辑/重置）：整块稳定
  prevRef.current = text;
  return { stable: text, delta: '' };
}

/** 增量段：持久容器不重建（旧文本在 stable，永不重淡），只让 fresh（新到达）淡入。
 *  block=true：块级 div（markdown——新内容从行边界开始，保结构）；
 *  block=false：行内 span（纯文本接续——不换行不跳）。
 *  delta 为空时不渲染（稳定段独占）。 */
function DeltaZone({ delta, className, block }: { delta: string; className?: string; block?: boolean }) {
  if (!delta) return null;
  const inner = (
    // key 驱动：每次新内容重挂载 → 动画重新触发（旧内容在 stable 不受影响）
    <span className="pp-ink-delta" key={delta}>
      {delta}
    </span>
  );
  // 容器只带布局 class（无动画——不重淡）；动画只挂在 fresh span 上
  if (block) return <div className={className}>{inner}</div>;
  return <span className={className}>{inner}</span>;
}
// ── 内置注疏渲染器（默认行）──
// 体渲染从 PaperPanel BlockView 的 kind 分支迁出（V3b）；兰台换装（2026-08-22）：
// 视觉由 PaperPanel.css 的分体字体/墨色承载（.pp-body 钩子 + kind 作用域选择器），
// 渲染器只补结构语义（diff 行着色 / 拟策条目化）。壳件（文类签/手柄/收回）留在
// PaperPanel（结构件不进注册表）。

/* ── 正文 markdown 渲染（2026-08-30 会话流渲染专项）──
 * 消费 paper/markdown.ts 的结构模型（与 measure.ts 测高同一解析——镜像纪律：
 * 两边结构必须同源）。视觉版式常量在 PaperPanel.css .pp-md-*，测量镜像在
 * measure.ts MD_* 常量——改版式三处同步（CSS/measure/此处类名契约）。 */

/** 数学渲染（科研 LaTeX）：KaTeX renderToString——确定性 HTML，离线无网络。
 *  throwOnError=false：流式半成型/未知命令公式不崩块，落 KaTeX 错误标记
 *  （红色源码，用户一眼看出公式没写完）；块渲染崩溃保险丝在壳层 PluginBoundary。 */
function mathHtml(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      output: 'html',
      strict: false,
    });
  } catch {
    // renderToString 理论上不 throw（throwOnError:false）；兜底不静默：落源码
    return source;
  }
}

/** 行内公式不可折行原子（KaTeX span + 包裹 span.pp-md-math-inline 防行内被拆） */
function MathInline({ source }: { source: string }) {
  const html = mathHtml(source, false);
  return (
    // KaTeX 输出 span 自带 .katex；外层 span 提供行内垂直对齐 + 侧距
    // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX 输出为可信本地渲染（非模型 HTML）
    <span className="pp-md-math-inline" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/* ── 代码高亮（科研渲染 #5，2026-09）：markdown 围栏码补 hljs token 层 ──
 * lang 解析已捕获（paper/markdown.ts）——只在此消费。lib/common 36 语言
 * 主流集（js/ts/py/rust/go/cpp/bash…）；科研语言 common 缺的显式补注册
 * （matlab/julia/scala/haskell/clojure/latex/scheme/dockerfile——科研会话
 * 高频，模块极小）。
 * 语义：
 *   - 高亮只包 span（不改字体/行数/换行）→ measure 高度镜像零改动（源码
 *     逐字字符与折行不变）；
 *   - 无 lang / lang 不识别 → 原文（纯 mono，不炸不误着色）；
 *   - 流式半成型围栏 tolerate（ignoreIllegals:true）。
 * 纸面墨色协调：hljs 类名在 .pp-md-code 作用域映射到纸面 token（CSS 侧）。 */

/** 补注册（模块装载期一次；hljs 已注册语言重复 register 会覆盖——幂等放行）。 */
function registerResearchLanguages(): void {
  hljs.registerLanguage('matlab', hljsMatlab);
  hljs.registerLanguage('julia', hljsJulia);
  hljs.registerLanguage('scala', hljsScala);
  hljs.registerLanguage('haskell', hljsHaskell);
  hljs.registerLanguage('clojure', hljsClojure);
  hljs.registerLanguage('latex', hljsLatex);
  hljs.registerLanguage('scheme', hljsScheme);
  hljs.registerLanguage('dockerfile', hljsDockerfile);
}
registerResearchLanguages();

/** 代码段 → 高亮 HTML（lang 不识别/空 → null = 原文纯 mono）。 */
function highlightCode(text: string, lang: string | undefined): string | null {
  if (!lang || !hljs.getLanguage(lang)) return null;
  try {
    // 半成型代码 tolerate：流式围栏未闭合也不崩
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** 行内片段 → 节点（标志位解析期已打平，无嵌套结构）。 */
function InlineRuns({ inl }: { inl: MdInline[] }) {
  return (
    <>
      {inl.map((seg, i) => {
        let node: ReactNode = seg.text;
        if (seg.math !== undefined) node = <MathInline source={seg.math} />;
        else if (seg.c) node = <code className="pp-md-ci">{seg.text}</code>;
        else if (seg.href) {
          node = (
            <a className="pp-md-a" href={seg.href} target="_blank" rel="noreferrer">
              {seg.text}
            </a>
          );
        }
        if (seg.s) node = <del>{node}</del>;
        if (seg.i) node = <em>{node}</em>;
        if (seg.b) node = <strong>{node}</strong>;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 解析段按位置渲染，静态内容无重排身份
          <Fragment key={i}>{node}</Fragment>
        );
      })}
    </>
  );
}

/** 块序列渲染（quote 内层 / 列表项嵌套递归复用；top = .pp-body 直排面）。
 *  tail：流式行内增量（无换行部分）——只落在最后一个块上（字符级接续）。 */
function MdBlocksView({ blocks, tail }: { blocks: MdBlock[]; tail?: ReactNode }) {
  return (
    <>
      {blocks.map((el, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态解析结果按位渲染
        <Fragment key={i}>{renderMdBlock(el, i === blocks.length - 1 ? tail : undefined)}</Fragment>
      ))}
    </>
  );
}

/** 围栏码块（markdown code）：hljs 高亮层（#5）。独立组件承载 useMemo——
 *  switch case 内不可调 hook（hooks 规则），块渲染在这里抽顶。 */
function MdCodeBlock({ el, tail }: { el: Extract<MdBlock, { t: 'code' }>; tail?: ReactNode }) {
  const highlighted = useMemo(() => highlightCode(el.text, el.lang), [el.lang, el.text]);
  const codeBlock = (
    <pre className="pp-md-code">
      {highlighted !== null ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: hljs 输出为可信本地渲染（非模型 HTML；转义由 hljs 内建）
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code>{el.text}</code>
      )}
      {tail}
    </pre>
  );
  // mermaid 围栏（B6 · P2）：只在模型**显式**写 ```mermaid 时触发 ⇒ 与 show_asset(chart)
  // 零竞争；渲染失败由 MermaidBlock 出「图渲染失败：<原因>」并把本代码块原样放回（不吞错、不空白）。
  if (el.lang === 'mermaid') return <MermaidBlock code={el.text} fallback={codeBlock} />;
  return codeBlock;
}

/* ── 远端图（B4 multimodal-image-plan · D-9）：独立行 ![alt](http/https) ──
 * 固定盒高（--pp-md-imgBoxH token，chem boxH 先例）——加载/失败态都不改
 * 版面（measure 静态镜像即精确）；加载失败换 alt 行（mono 弱墨，盒界常在，
 * 错误不静默）。src 已在解析层过协议白名单（remoteImageSrc）。 */
function MdImage({ el, tail }: { el: Extract<MdBlock, { t: 'img' }>; tail?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <div className="pp-md-imgbox">
        {failed ? (
          <span className="pp-md-img-alt" title={el.src}>
            {el.alt || el.src}
          </span>
        ) : (
          <img
            className="pp-md-img"
            src={el.src}
            alt={el.alt}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {/* 流式尾块续写兜底：同表格先例——图盒固定不接行内，增量独立跟随 */}
      {tail}
    </>
  );
}

function renderMdBlock(el: MdBlock, tail?: ReactNode): ReactNode {
  switch (el.t) {
    case 'p':
      return (
        <p className="pp-md-p">
          <InlineRuns inl={el.inl} />
          {tail}
        </p>
      );
    case 'h': {
      const Tag = `h${el.lv}` as 'h1' | 'h2' | 'h3' | 'h4';
      return (
        <Tag className={`pp-md-h pp-md-h${el.lv}`}>
          <InlineRuns inl={el.inl} />
          {tail}
        </Tag>
      );
    }
    case 'list': {
      const Tag = el.ord ? 'ol' : 'ul';
      return (
        <Tag className="pp-md-list">
          {el.items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表项按位渲染，序号即身份
            <li key={i} className={`pp-md-li${it.check !== undefined ? ' pp-md-li--check' : ''}`}>
              {it.check !== undefined ? (
                /* 任务列表复选框（GFM - [ ] / - [x]，2026-09 #15）：纯 CSS 自绘
                 * span（纸面墨色铁律，无原生表单控件）——绝对定位在标记列
                 * （.pp-md-mark 同位）；展示态：状态是正文陈述，勾选写回语义
                 * 归 task/board 通道。 */
                <span className={`pp-md-check${it.check ? '' : ' pp-md-check--on'}`} aria-hidden="true" />
              ) : (
                <span className="pp-md-mark" aria-hidden="true">
                  {el.ord ? `${el.start + i}.` : '·'}
                </span>
              )}
              <InlineRuns inl={it.inl} />
              {/* 流式尾块续写（会话流偶发吞尾字根因修复）：tail = 无换行的行内
               * 增量——接进最后一项（列表尾项同行续写是模型常见产出）。丢 tail
               * 即该帧新字符从 DOM 消失（数据未丢，重挂/全量重解析又出现）。 */}
              {i === el.items.length - 1 && tail}
              {it.sub && (
                <div className="pp-md-sub">
                  <MdBlocksView blocks={it.sub} />
                </div>
              )}
            </li>
          ))}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote className="pp-md-quote">
          <MdBlocksView blocks={el.blocks} tail={tail} />
        </blockquote>
      );
    case 'code':
      return <MdCodeBlock el={el} tail={tail} />;
    case 'img':
      return <MdImage el={el} tail={tail} />;
    case 'math': {
      // 块级 display 公式（KaTeX .katex-display 自带上下留白与居中）
      const html = mathHtml(el.text, true);
      return (
        <>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX 输出为可信本地渲染（非模型 HTML） */}
          <div className="pp-md-math" dangerouslySetInnerHTML={{ __html: html }} />
          {tail}
        </>
      );
    }
    case 'hr':
      return (
        <>
          <hr className="pp-md-hr" />
          {tail}
        </>
      );
    case 'table':
      return (
        <>
          <table className="pp-md-table">
            <thead>
              <tr>
                {el.head.map((cell, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 表头按位渲染
                  <th key={i}>
                    <InlineRuns inl={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {el.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 表行按位渲染
                <tr key={r}>
                  {row.map((cell, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 表格按位渲染
                    <td key={c}>
                      <InlineRuns inl={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {/* 流式尾块续写兜底：表格结构无法行内接续 → 增量独立跟随表尾（不丢字） */}
          {tail}
        </>
      );
  }
}

/** 正文（markdown）：结构化渲染——标题/段落/列表/引用/图码/表格 + 行内强调。
 *  流式友好：parseMarkdown 对未闭合围栏/未配对标记按已闭合/字面量处理。
 *  增量渐显（streaming-fade，方案 B 三级切分）：
 *    - 旧文本（stable）零动画，走完整 parseMarkdown；
 *    - 增量按首个换行切：换行前 = 行内续写（tail 接进最后一个块，字符级淡入）；
 *    - 换行后 = 新块（块级 DeltaZone，从行首开始不腰斩 markdown 结构）。
 *    - stable 为空（首 token）时行内尾也兜底渲染，不丢字。 */
function MarkdownBody({
  block,
  sidecarFolded,
  onToggleSidecarFold,
  onSidecarPinMouseDown,
  sidecarOut,
  onSidecarRestore,
}: BlockRendererProps) {
  const text = (block.payload as { text?: string }).text ?? '';
  // P5 眉批化：配对吸附的夹注全文 → 右侧眉批栏（.pp-marginalia，绝对定位
  // 锚 .pp-block——世界层块是唯一定位祖先，侧栏在块宽之外不挤正文列）
  const sidecar = (block.payload as { sidecar?: { text: string } }).sidecar;
  const { stable, delta } = useStreamDelta(text, null);
  // 增量解析：stable 尾部追加时只重解析最后一个块，稳定前缀块跨 token
  // 引用不变（parseMarkdownIncremental 复用 prev 的 prefix blocks）。
  // parseStateRef 生命周期 = 组件实例（block 每次流式 bump 重挂？——不，块体
  // 组件随 block 引用稳定而 memo 保持，ref 跨 bump 存活）。非追加（编辑/重置）
  // 自动回退全量，ref 更新为最新全量状态。
  const parseStateRef = useRef<MdParseState | null>(null);
  const blocks = useMemo(() => {
    const res = parseMarkdownIncremental(stable, parseStateRef.current);
    parseStateRef.current = res.state;
    return res.blocks;
  }, [stable]);
  // 三级切分：换行前行内尾 / 换行后新块（剥掉分块换行——它属于块边界非内容）
  const nl = delta.indexOf('\n');
  const inlineTail = nl < 0 ? delta : delta.slice(0, nl);
  const blockDelta = nl < 0 ? '' : delta.slice(nl + 1);
  const tailNode = inlineTail && <span className="pp-ink-delta">{inlineTail}</span>;
  return (
    <div className="pp-body pp-md">
      {sidecar?.text ? (
        <aside className="pp-marginalia">
          {sidecarOut ? (
            /* 已钉出（移出语义）：眉批栏原位留洞——点击拔 `:sc` 快照钉恢复夹注 */
            <button
              type="button"
              className="pp-marginalia-out"
              onClick={(e) => {
                e.stopPropagation();
                onSidecarRestore?.(block);
              }}
            >
              已移出 · 点击恢复
            </button>
          ) : (
            <>
              {sidecarFolded ? (
                <button
                  type="button"
                  className="pp-marginalia-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSidecarFold?.(block);
                  }}
                >
                  {foldLabel('reasoning', { text: sidecar.text }, true)}
                </button>
              ) : (
                <>
                  {sidecar.text}
                  <button
                    type="button"
                    className="pp-marginalia-toggle"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSidecarFold?.(block);
                    }}
                  >
                    {foldLabel('reasoning', { text: sidecar.text }, false)}
                  </button>
                </>
              )}
              {/* 拖出钉画布：独立夹注快照（移出语义——钉出后本栏换「已移出」占位） */}
              <button
                type="button"
                className="pp-marginalia-pin"
                title="拖出钉上画布"
                onMouseDown={(e) => onSidecarPinMouseDown?.(e, block)}
              >
                钉
              </button>
            </>
          )}
        </aside>
      ) : null}
      {blocks.map((el, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同上
        <Fragment key={i}>{renderMdBlock(el, i === blocks.length - 1 ? tailNode : undefined)}</Fragment>
      ))}
      {/* stable 为空（首 token / 全空追加）：行内尾直接落体（不丢字） */}
      {blocks.length === 0 && inlineTail && (
        <span className="pp-ink-delta" key={inlineTail}>
          {inlineTail}
        </span>
      )}
      <DeltaZone delta={blockDelta} block />
    </div>
  );
}

/** 回合错误体（2026-08-31 贴黄拆迁）：纯文本墓碑行，样式由
 *  .pp-block.pp-turn-error 承载（朱砂底线 + 次级墨）；换行由 pre-line 承载。 */
function TurnErrorBody({ block }: BlockRendererProps) {
  const text = (block.payload as { text: string }).text ?? '';
  return <div className="pp-body">{text}</div>;
}

/** 夹注/贴黄体：纯文本单段流（夹注折叠态 = 一行预览，folded 由壳层递下）。 */
function TextBody({ block, folded }: BlockRendererProps) {
  const text = (block.payload as { text: string }).text ?? '';
  const { stable, delta } = useStreamDelta(text, folded ?? null);
  if (block.kind === 'reasoning') {
    if (folded) {
      const preview = foldPreviewLine(text);
      return <div className="pp-body">{preview ? <div className="pp-fold-preview">{preview}</div> : null}</div>;
    }
  }
  return (
    <div className="pp-body">
      {stable}
      <DeltaZone delta={delta} />
    </div>
  );
}

/** 来文体：圈点解析（C7）——【词】→ 朱砂圈，其余字面。
 *  圈永不拆行由 .pp-circled 的 inline-block 保证（CSS 侧纪律）。
 *  增量渐显：稳定段走圈点，增量段纯文本淡入（稳定化后并入圈点）。
 *  附件行（C10）：payload.files 独立渲染——石青 mono 小行，不混楷书正文。 */

/* ── 来文附图缩略行（B4 multimodal-image-plan · D-9）──
 * 引用 → 展示 URL 两径：进程内预览 URL（准入 seedPreviewUrl——同进程零 RPC
 * 快径）；未命中（重启/跨进程历史卷）经 B3 同款 readAttachmentBase64 回读
 * 盘上附件 → data URI（INVARIANTS #14：字节只在渲染期成 URI，不进卷）。
 * epoch 防串流同 useMediaData 语义（组件卸载/换图丢弃在途结果）。 */

interface UserImageState {
  src: string | null;
  err: string | null;
}

function useUserImageSrc(img: ChatImageRef): UserImageState {
  const projectPath = useShellStore((s) => s.projectPath);
  const [state, setState] = useState<UserImageState>(() => ({ src: previewUrlFor(img.id) ?? null, err: null }));
  const { id, mediaType, name } = img;
  useEffect(() => {
    let cancelled = false;
    // 快径：进程内 object URL（准入时种）——同步命中零 RPC
    const seeded = previewUrlFor(id);
    if (seeded !== undefined) {
      setState({ src: seeded, err: null });
      return;
    }
    if (!projectPath) {
      setState({ src: null, err: '工作区未打开，附图不可读' });
      return;
    }
    // 慢径：盘上附件回读（读取中不清旧 src——同 id 换引用防闪）
    readAttachmentBase64(projectPath, { id, mediaType, name })
      .then((b64) => {
        if (!cancelled) setState({ src: `data:${mediaType};base64,${b64}`, err: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ src: null, err: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [id, mediaType, name, projectPath]);
  return state;
}

function UserImageThumb({ img, onOpen }: { img: ChatImageRef; onOpen: (src: string) => void }) {
  const { src, err } = useUserImageSrc(img);
  const label = img.name ?? img.id.slice(0, 8);
  return (
    <button
      type="button"
      className="pp-user-image"
      title={err ?? label}
      aria-label={`预览附图：${label}`}
      onClick={() => {
        if (src !== null) onOpen(src);
      }}
    >
      {src !== null ? (
        <img src={src} alt={label} loading="lazy" />
      ) : (
        <span className="pp-user-image-fallback">{err !== null ? '读取失败' : label}</span>
      )}
    </button>
  );
}

function UserImagesRow({ images }: { images: ChatImageRef[] }) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  return (
    <>
      <div className="pp-user-images">
        {images.map((img) => (
          <UserImageThumb key={img.id} img={img} onOpen={setPreviewSrc} />
        ))}
      </div>
      {/* 点击放大：media 渲染器同款浮层（.pp-media-preview-overlay 全局模态） */}
      <Overlay
        open={previewSrc !== null}
        onClose={() => setPreviewSrc(null)}
        portal
        className="pp-media-preview-overlay"
      >
        {previewSrc !== null && <img className="pp-media-preview" src={previewSrc} alt="附图" />}
      </Overlay>
    </>
  );
}

function UserBody({ block }: BlockRendererProps) {
  const text = (block.payload as { text: string }).text;
  const files = (block.payload as { files?: Array<{ path: string; name: string }> }).files;
  const images = (block.payload as { images?: ChatImageRef[] }).images;
  const { stable, delta } = useStreamDelta(text ?? '', null);
  const segs = parseCircledSegments(stable);
  return (
    <div className="pp-body">
      {segs.map((s, i) =>
        s.circled ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 解析段按位置渲染，静态内容无重排身份
          <span key={i} className="pp-circled">
            {s.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同上
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
      <DeltaZone delta={delta} />
      {files && files.length > 0 && (
        <div className="pp-user-files">
          {files.map((f) => (
            <div key={f.path} className="pp-user-file" title={f.path}>
              附 · {f.name}
            </div>
          ))}
        </div>
      )}
      {images && images.length > 0 && <UserImagesRow images={images} />}
      {/* asterism（B1）：来文收尾三星——古代卷子每卷末的花押句号。
       * 视觉尾距 30px 在 .pp-user-asterism（margin-top），测量镜像 measure.ts。 */}
      <span className="pp-user-asterism" aria-hidden="true">
        ⁂
      </span>
    </div>
  );
}

/** 统一 diff 行分类：+ 新增（松绿 --pass）/ - 删除（朱砂深 --seal-deep 删除线）/ @@ hunk 头（注记）。
 *  B5 环2 红绿墨色化定稿——颜色落点在 PaperPanel.css .pp-add/.pp-del。 */
function diffLineClass(line: string): string | undefined {
  if (line.startsWith('+')) return 'pp-add';
  if (line.startsWith('-')) return 'pp-del';
  if (line.startsWith('@@')) return 'pp-hunk';
  return undefined;
}

function DiffBody({ block }: BlockRendererProps) {
  const p = block.payload as { lang?: string; text: string };
  const lines = p.text.split('\n');
  return (
    <>
      {p.lang && <div className="pp-lang">{p.lang}</div>}
      <pre>
        {lines.map((line, i) => {
          const cls = diffLineClass(line);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff 行按位置渲染，行序即身份
            <Fragment key={i}>
              {i > 0 && '\n'}
              {cls ? <span className={cls}>{line}</span> : line}
            </Fragment>
          );
        })}
      </pre>
    </>
  );
}

function PlanBody({ block }: BlockRendererProps) {
  const p = block.payload as {
    title: string;
    content: string;
    options?: { label: string; description: string; outcome?: PlanOptionOutcome }[];
    _callback?: (response: PlanApprovalResponse) => void;
  };
  // 拟策内容 = 完整 markdown 体（2026-09-10 拟策卡渲染专项）：标题/列表/加粗/
  // 围栏码/表格按结构渲染（旧 parsePlanItems 剥标记平铺成行号清单——「太毛坯」
  // 的直接根因）；与 measure 的 plan 分支共用 parseMarkdown（同源纪律）。
  const mdBlocks = useMemo(() => parseMarkdown(p.content ?? ''), [p.content]);
  const mdBody =
    mdBlocks.length > 0 ? (
      <div className="pp-pc-body pp-md">
        <MdBlocksView blocks={mdBlocks} />
      </div>
    ) : null;
  const cb = p._callback;
  const [selected, setSelected] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [done, setDone] = useState(false);

  if (!cb) {
    // 只读态（历史块 / 无审批回调）：维持拟策展示
    return (
      <div className="pp-pc">
        <div className="pp-pc-head">
          <span className="pp-pc-t">{p.title || '拟策'}</span>
        </div>
        {mdBody}
      </div>
    );
  }

  const hasOptions = (p.options?.length ?? 0) >= 2;
  const canApprove = !hasOptions || selected !== null;
  const canRevise = feedback.trim().length > 0;
  const settle = (response: PlanApprovalResponse) => {
    cb(response);
    setDone(true);
  };

  return (
    <div className="pp-pc">
      <div className="pp-pc-head">
        <span className="pp-pc-t">{p.title || '拟策'}</span>
      </div>
      {mdBody}
      {hasOptions && (
        <div className="pp-pc-options">
          {(p.options ?? []).map((o) => (
            <button
              key={o.label}
              type="button"
              className={`pp-pc-option${selected === o.label ? ' pp-pc-option--on' : ''}`}
              onClick={() => setSelected(o.label)}
            >
              <span className="pp-pc-option-label">{o.label}</span>
              <span className="pp-pc-option-desc">{o.description}</span>
            </button>
          ))}
        </div>
      )}
      {done ? (
        <div className="pp-pc-done">已处理</div>
      ) : (
        <>
          {feedbackOpen && (
            <div className="pp-pc-feedback">
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="修改意见…" />
            </div>
          )}
          <div className="pp-pc-actions">
            {/* 主操作随态让位：反馈框展开时「提交」当家，批准退行（避免双主钮） */}
            <button
              type="button"
              className={`pp-pc-btn${feedbackOpen ? '' : ' pp-pc-btn--primary'}`}
              disabled={!canApprove}
              title={canApprove ? undefined : '先选择方案'}
              onClick={() => settle({ decision: 'approved', selectedLabel: selected ?? undefined })}
            >
              批准
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
              title="回绝此拟策"
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

/* ── 工具卡载荷段（2026-09-14 可读性专项）──
 * 旧观感：args 原始 JSON 单行串 + output 原样倾倒，同一块内两层无标签地叠在
 * 一起，长 token 被 break-all 从中间剁开——用户报「跟乱码一样」。新观感：
 *   ① 分段：参数/输出/错误各有段头（小字注记 + 细规线），一眼分清进出；
 *   ② 结构：JSON 载荷走 paper/tool-text 的结构化打印（一键一行、缩进、
 *      短容器内联、数组条目列表化、字符串值解转义——Windows 路径单反斜杠）；
 *   ③ 洁净：ANSI 转义与控制字符在展示变换里剔除（终端的 [36m 不再是内容）；
 *   ④ 着色：键/字符串/数字/结构符分色，扫读时结构与数据分离。
 * 展示文本是唯一变换产物——measure.ts 与 inkSourcesFor 消费同一 text，
 * 行数与渲染逐字一致（镜像纪律见 paper/tool-text 头注）。 */

/** 片段语义 → 纸面类（'plain' 无类——直接文本节点）。 */
const TONE_CLASS: Record<ToolTone, string> = {
  key: 'pp-tv-k',
  str: 'pp-tv-s',
  num: 'pp-tv-n',
  punct: 'pp-tv-p',
  note: 'pp-tv-c',
  plain: '',
};

/** 一行里的片段序列（键/值/字面量/结构符逐片着色）。 */
function LineParts({ parts }: { parts: ToolSpan[] }) {
  return (
    <>
      {parts.map((part, j) => {
        const cls = TONE_CLASS[part.tone];
        const body = cls ? <span className={cls}>{part.text}</span> : part.text;
        // biome-ignore lint/suspicious/noArrayIndexKey: 展示行内片段按位渲染，静态内容无重排身份
        return <Fragment key={j}>{body}</Fragment>;
      })}
    </>
  );
}

/** 结构化载荷：逐行逐片渲染（缩进=2 空格/级、条目 `· ` 标记——与展示文本
 *  逐字同源）。纯文本载荷直出 text：47KB 文件内容不炸成几千个节点。 */
function PayloadText({ display }: { display: ToolDisplay }) {
  if (display.lines === null) return <>{display.text}</>;
  return (
    <>
      {display.lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 展示行按位渲染，静态内容无重排身份
        <Fragment key={i}>
          {i > 0 && '\n'}
          {line.level > 0 && '  '.repeat(line.level)}
          {line.marker && <span className="pp-tv-p">· </span>}
          <LineParts parts={line.parts} />
        </Fragment>
      ))}
    </>
  );
}

/** 载荷段（段头 + 盒）。variant 即语义：args=石青直排（机器的输入面）/
 *  out=中性滚动盒 / result=石青段头（程序产出的答案段）/ err=错误墨段。
 *  段类同时是段头的染色挂点。
 *  useMemo 按原始串记忆展示模型（20–30KB JSON 的解析+摊行不随无关重渲染重跑）。 */
const PayloadSection = memo(function PayloadSection({
  label,
  raw,
  variant,
  gap,
}: {
  label: string;
  raw: string;
  variant: 'args' | 'out' | 'err' | 'result';
  /** 段头前留空档（首段紧跟折叠行/程序体，不留） */
  gap?: boolean;
}) {
  const display = useMemo(() => toolDisplay(raw), [raw]);
  const boxClass = variant === 'err' ? 'pp-out pp-out--err' : variant === 'args' ? 'pp-args' : 'pp-out';
  const body = <PayloadText display={display} />;
  return (
    <div className={`pp-sec pp-sec--${variant}${gap ? ' pp-sec--gap' : ''}`}>
      <div className="pp-sec-head">
        <span className="pp-sec-label">{label}</span>
      </div>
      {variant === 'args' ? <pre className={boxClass}>{body}</pre> : <div className={boxClass}>{body}</div>}
    </div>
  );
});

function ToolBody({ block, folded }: BlockRendererProps) {
  const p = block.payload as { args: string; output?: string; err?: string };
  if (folded) return null; // 折叠态只留壳层折叠行（paper/fold.ts 规则）——参数/输出全收
  // F1（2026-09-01 三轴审计）：空/无意义参数（`{}` 等 JSON 骨架）不裸奔
  const showArgs = hasArgsToShow(p.args);
  const showOut = hasPayloadToShow(p.output);
  const showErr = hasPayloadToShow(p.err);
  return (
    <>
      {showArgs && <PayloadSection label="参数" raw={p.args} variant="args" />}
      {showOut && <PayloadSection label="输出" raw={p.output ?? ''} variant="out" gap={showArgs} />}
      {showErr && <PayloadSection label="错误" raw={p.err ?? ''} variant="err" gap={showArgs || showOut} />}
    </>
  );
}

/** 程序执行卡（P2-A）：三段式——程序体（等宽）→ 日志/完成值（终态写入）。
 *  与 ToolBody 的分离点：code 是程序语义（体/出）而非调用语义（参/果）。
 *  折叠态收程序体、留输出/错误（执行结果一眼可见——测量端同款镜像）。
 *  2026-09-19 换代：输出不再是「一段直出」——信封解析成真段（日志/完成值/错误），
 *  段序与测高由 paper/tool-text 的 codeDisplay 单一真源给出（渲染/测量同源）。 */
function CodeBody({ block, folded }: BlockRendererProps) {
  const p = block.payload as { code: string; output?: string; err?: string };
  const showSrc = !folded && !!p.code;
  const secs = useMemo(() => codeDisplay(p.output), [p.output]);
  const showErr = hasPayloadToShow(p.err);
  return (
    <>
      {showSrc && <pre className="pp-code-src">{p.code}</pre>}
      {secs.map((sec, i) => (
        <PayloadSection
          // biome-ignore lint/suspicious/noArrayIndexKey: 段按位渲染（信封段序稳定，无重排身份）
          key={`${sec.kind}-${i}`}
          label={sec.label}
          raw={sec.raw}
          variant={sec.kind === 'error' ? 'err' : sec.kind === 'result' ? 'result' : 'out'}
          gap={showSrc || i > 0}
        />
      ))}
      {showErr && <PayloadSection label="错误" raw={p.err ?? ''} variant="err" gap={showSrc || secs.length > 0} />}
    </>
  );
}

/** 兜底 JSON 视图（WO-4）：未知/资产 kind 未接表现原语时，不崩且保信息保真。
 *  只渲染块体；kind/presentation/title 作为文类签补充，payload 以漂亮 JSON 展示。 */
export function JsonBody({ block }: BlockRendererProps) {
  const p = block.payload;
  const pretty = (() => {
    try {
      return JSON.stringify(p, null, 2);
    } catch {
      return String(p);
    }
  })();
  return (
    <div className="pp-json">
      <div className="pp-json-head">
        <span className="pp-json-kind">{block.kind}</span>
        {block.asset?.presentation && <span className="pp-json-pres">{block.asset.presentation}</span>}
        {block.asset?.title && <span className="pp-json-title">{block.asset.title}</span>}
      </div>
      <pre className="pp-json-pre">{pretty}</pre>
    </div>
  );
}

/** 工具组头（2026-08-30 会话流专项）：体恒空——信息全部在壳层折叠行
 *  （foldLabel 摘要：×N · 名字分布 · 在跑数），子卡是独立 tool 块。
 *  不注册会落 '*' JSON 兜底（payload 含活 part 引用，绝不能 JSON 化）。 */
function ToolGroupBody(): null {
  return null;
}

/** 子代理组头（2026-09-01 三轴审计 F4）：与工具组头同构——体恒空，
 *  信息在壳层折叠行（foldLabel：描述 · 段数 · 在跑/出错），子 parts 是
 *  独立块（reasoning/text/tool…），折叠摘除复用 collapseToolGroups。 */
function SubagentGroupBody(): null {
  return null;
}

/** 内置渲染器行（默认行——视觉由纸壳 CSS 承载，渲染器只管体结构）。 */
export function builtinRendererDefs(): BlockRendererContribution[] {
  return [
    { id: 'builtin/user', kind: 'user', component: UserBody },
    { id: 'builtin/markdown', kind: 'markdown', component: MarkdownBody },
    { id: 'builtin/reasoning', kind: 'reasoning', component: TextBody },
    { id: 'builtin/notice', kind: 'notice', component: TextBody },
    { id: 'builtin/diff', kind: 'diff', component: DiffBody },
    { id: 'builtin/plan', kind: 'plan', component: PlanBody },
    { id: 'builtin/tool', kind: 'tool', component: ToolBody },
    { id: 'builtin/code', kind: 'code', component: CodeBody },
    { id: 'builtin/toolgroup', kind: 'toolgroup', component: ToolGroupBody },
    { id: 'builtin/subagent', kind: 'subagent', component: SubagentGroupBody },
    { id: 'builtin/turn-error', kind: 'turn-error', component: TurnErrorBody },
  ];
}
