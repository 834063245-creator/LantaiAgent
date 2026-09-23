// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/paper/viewers/mermaid-block — ```mermaid 围栏的代码块渲染器（渲染面补全 P2 · B6，2026-09-23）。
//
// 分工：围栏认领（lang === 'mermaid'）在 `app/paper/builtin-renderers.tsx` 的 MdCodeBlock；
// 本件只管「码 → 图」这一段。契约两个 props：原样源码 + 回落体（原代码块 ReactNode）。
//
// 五条落地裁定（施工单 + 宪法取舍留痕）：
//   ① **mermaid 走动态 import** —— 本件自身已是应用 bundle 的懒分片，mermaid 本体（MB 级）
//      再分一片，不进入口 chunk。装载失败与渲染失败同一条降级路；装载失败**不重试**
//      （坏分片不该被逐块重试打成风暴，刷新即重来）。
//   ② **主题跟随纸面墨阶** —— theme:'base' + themeVariables 全部自宿主元素现读 token
//      （--ink-1/2/3/4、--paper、--paper-deep、--seal*、--indigo、--graphite…），不用
//      mermaid 默认配色；**token 不可读（纸面样式未装载）⇒ 不出图**，走
//      「图渲染失败：纸面墨阶 token 不可读（--xxx）」+ 回落——宁可回落代码块，也不出
//      一张默认配色的图。
//   ③ **降级不静默** —— 语法错 / 装载失败 / 渲染抛错 / 空码 / 源码超长 ⇒ 一行可读
//      「图渲染失败：<原因>」+ 回落体（原代码块）。空 code 判「代码块为空」（同一机制，
//      不另立空态）；**渲染中出回落体**（不空白、不加占位行、高度不跳）。
//   ④ **高度口径 = 上限 + 内部滚动** —— 容器宽撑满版心；图保 mermaid 写在 svg 上的自然
//      宽度上限（小图不放大成巨型字），超版心则缩进版心内；高随图自适应，上限
//      --pp-asset-viewer-boxH + 容器内滚动。不靠 JS 量高（无布局时算出 0 的坑不碰）。
//   ⑤ **流式护栏** —— 围栏在流式期间逐字生长，逐 chunk 真渲染 = 主线程渲染风暴 ⇒ 160ms
//      防抖（最后一次变更后起渲，过期结果丢弃）；成图按源码进有界缓存（纸面虚拟化让块
//      滚出/滚回即重挂，命中即同步出图，不重渲）。
//
// 未做（如实登记）：mermaid 的交互面不接（`bindFunctions` 回调 / 节点点击）——纸上图是**读**面；
// 超大图靠本件源码上限 + 容器内滚动兜底，不做降级缩略图。

import type { MermaidConfig } from 'mermaid';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import './mermaid-block.css';

export interface MermaidBlockProps {
  /** 围栏里的源码（原样，已去掉 ```mermaid 围栏行） */
  code: string;
  /** 渲染失败的回落体（父层传原代码块 ReactNode） */
  fallback: ReactNode;
}

/** 防抖窗（ms）：流式逐 chunk 变更不逐次真渲染。 */
const RENDER_DEBOUNCE_MS = 160;
/** 成图缓存条数上限（FIFO）。 */
const SVG_CACHE_MAX = 24;
/** 源码字符上限（与 mermaid 的 maxTextSize 同一把尺）：超长围栏不往主线程上送。 */
const MAX_CODE_CHARS = 32_000;
/** 错误原因单行截断（mermaid 的 Parse error 会甩一大串期望 token）。 */
const REASON_MAX = 180;

/* ── 模块级态（CONVENTIONS §1.10 级别 3：进程级单例 / 键控自清理——无跨面板所有权问题）──
 * loader：懒分片句柄（**连拒绝态一起缓存**，见头注①）
 * cache ：源码 → 成图（内容寻址；主题一次会话内固定，不另设失效代际）
 * seq   ：唯一 DOM id 计数（mermaid.render 的 id 必须唯一） */
let mermaidLoader: Promise<typeof import('mermaid')> | null = null;
const svgCache = new Map<string, { svg: string; id: string }>();
let renderSeq = 0;

function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidLoader ??= import('mermaid');
  return mermaidLoader;
}

function nextRenderId(): string {
  renderSeq += 1;
  return `pp-mermaid-${renderSeq}`;
}

/** 必读 token（缺一即不出图——见头注②）。 */
const REQUIRED_TOKENS = ['--ink-1', '--ink-2', '--paper', '--paper-deep'] as const;

/** 选读 token（缺则退到最近一档墨/纸，仍不出裸色值）。 */
const OPTIONAL_TOKENS = [
  '--ink-3',
  '--ink-4',
  '--seal',
  '--seal-deep',
  '--indigo',
  '--graphite',
  '--pass',
  '--fail',
  '--f-mono',
  '--pp-type-mono-size',
] as const;

/** 现读 token：宿主元素 computed —— `--ink-*` 声明在 :root，`--pp-*` 由 injectPaperTokens
 *  注入 .pp-root（inline），两者都经继承落到本件宿主上，故一处取全。 */
function readTokens(host: Element): Map<string, string> {
  const styles = document.defaultView?.getComputedStyle(host);
  const out = new Map<string, string>();
  for (const name of [...REQUIRED_TOKENS, ...OPTIONAL_TOKENS]) {
    out.set(name, styles?.getPropertyValue(name).trim() ?? '');
  }
  return out;
}

interface InkTheme {
  /** theme:'base' 的取色全表（纸面墨阶 / 矿物色，零裸色值）。 */
  variables: Record<string, string | boolean>;
  /** 机读位字体栈（--f-mono）——同时给根配置的 fontFamily；读不到就整条不给。 */
  fontFamily: string;
}

/** 纸面墨阶 → mermaid 主题变量（缺必读项即抛 —— 上层转「图渲染失败：…」+ 回落）。 */
function inkTheme(host: Element): InkTheme {
  const tokens = readTokens(host);
  const need = (name: string): string => {
    const value = tokens.get(name) ?? '';
    if (value === '') throw new Error(`纸面墨阶 token 不可读（${name}）`);
    return value;
  };
  const soft = (name: string, fallback: string): string => tokens.get(name) || fallback;

  const ink1 = need('--ink-1');
  const ink2 = need('--ink-2');
  const paper = need('--paper');
  const paperDeep = need('--paper-deep');
  const ink3 = soft('--ink-3', ink2);
  const ink4 = soft('--ink-4', ink3);
  const seal = soft('--seal', ink1);
  const sealDeep = soft('--seal-deep', seal);
  const indigo = soft('--indigo', ink2);
  const graphite = soft('--graphite', ink3);
  const pass = soft('--pass', indigo);
  const fail = soft('--fail', seal);
  const fontFamily = tokens.get('--f-mono') ?? '';
  const fontSize = tokens.get('--pp-type-mono-size') ?? '';

  const variables: Record<string, string | boolean> = {
    darkMode: false,
    background: paper,
    // 流程 / 状态 / 类 / ER：节点 = 深纸底 + 正文墨字 + 次级墨框，连线 = 次级墨
    primaryColor: paperDeep,
    primaryTextColor: ink1,
    primaryBorderColor: ink2,
    mainBkg: paperDeep,
    nodeBorder: ink2,
    nodeTextColor: ink1,
    lineColor: ink2,
    textColor: ink1,
    labelColor: ink1,
    // 分组框（subgraph / cluster）：纸底 + 三级墨框
    clusterBkg: paper,
    clusterBorder: ink3,
    // 二三级面：base 主题的派生取色都从这三档走，不给就漏 base 的默认亮色
    secondaryColor: paper,
    secondaryTextColor: ink1,
    secondaryBorderColor: ink3,
    tertiaryColor: paper,
    tertiaryTextColor: ink1,
    tertiaryBorderColor: ink3,
    edgeLabelBackground: paper,
    titleColor: ink1,
    // 时序图：参与者 / 信号 / 激活条 / 注释（注释走石青——机注的既有语义）
    actorBkg: paperDeep,
    actorBorder: ink2,
    actorTextColor: ink1,
    actorLineColor: ink2,
    signalColor: ink2,
    signalTextColor: ink1,
    labelBoxBkgColor: paperDeep,
    labelBoxBorderColor: ink2,
    labelTextColor: ink1,
    loopTextColor: ink2,
    activationBkgColor: paper,
    activationBorderColor: ink2,
    sequenceNumberColor: paper,
    noteBkgColor: paperDeep,
    noteTextColor: ink1,
    noteBorderColor: indigo,
    // 甘特 / 时间轴：分段纸底交替 + 任务条石青 + 今日线朱砂（人的当下）
    sectionBkgColor: paperDeep,
    altSectionBkgColor: paper,
    sectionBkgColor2: paper,
    taskBkgColor: indigo,
    taskTextColor: paper,
    taskTextOutsideColor: ink1,
    taskTextLightColor: paper,
    taskTextDarkColor: ink1,
    gridColor: ink4,
    todayLineColor: seal,
    // 类图 / 状态图
    classText: ink1,
    altBackground: paper,
    // 饼图 / 象限：色板取自矿物色 + 墨阶（base 主题的默认亮彩一律不要）
    pie1: indigo,
    pie2: seal,
    pie3: graphite,
    pie4: ink2,
    pie5: ink3,
    pie6: pass,
    pie7: sealDeep,
    pie8: ink4,
    // 失败面（错误图已被 suppressErrorRendering 挡在 DOM 外，取值保持同纸）
    errorBkgColor: paperDeep,
    errorTextColor: fail,
  };
  if (fontFamily !== '') variables.fontFamily = fontFamily;
  if (fontSize !== '') variables.fontSize = fontSize;

  return { variables, fontFamily };
}

function mermaidConfig(theme: InkTheme): MermaidConfig {
  const config: MermaidConfig = {
    startOnLoad: false,
    securityLevel: 'strict', // 标签走 mermaid 内建 DOMPurify（strict 禁 HTML 标签/脚本）
    theme: 'base', // base = themeVariables 全权接管（其余主题自带配色，不可用）
    maxTextSize: MAX_CODE_CHARS, // 与源码上限同一把尺（mermaid 自身的超长闸）
    suppressErrorRendering: true, // 不把 'Syntax error' 图塞进 DOM——错误面本件自管
    themeVariables: theme.variables,
  };
  if (theme.fontFamily !== '') config.fontFamily = theme.fontFamily;
  return config;
}

/** 缓存命中：把首渲时的 DOM id 换成本次唯一 id 再贴（同码两块不撞 id）。 */
function retagCached(entry: { svg: string; id: string }): string {
  return entry.svg.split(entry.id).join(nextRenderId());
}

function storeCached(code: string, entry: { svg: string; id: string }): void {
  svgCache.set(code, entry);
  while (svgCache.size > SVG_CACHE_MAX) {
    const oldest = svgCache.keys().next();
    if (oldest.done) break;
    svgCache.delete(oldest.value);
  }
}

/** 码 → 图（缓存未命中才真渲；成功才入缓存）。 */
async function renderDiagram(code: string, host: Element): Promise<string> {
  const cached = svgCache.get(code);
  if (cached !== undefined) return retagCached(cached);
  const { default: mermaid } = await loadMermaid();
  mermaid.initialize(mermaidConfig(inkTheme(host)));
  const id = nextRenderId();
  const { svg } = await mermaid.render(id, code);
  if (!svg.includes('<svg')) throw new Error('mermaid 没有产出 SVG');
  storeCached(code, { svg, id });
  return svg;
}

/** 抛错 → 一行可读原因（mermaid 的 Parse error 带「...上文 / ---^」指针噪声，收干净再截断）。 */
function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw
    .replace(/\.{3}[\s\S]*?-+\^/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const reason = text === '' ? (err instanceof Error ? err.name : '未知错误') : text;
  return reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}…` : reason;
}

type MermaidState = { phase: 'pending' } | { phase: 'ok'; svg: string } | { phase: 'fail'; reason: string };

export default function MermaidBlock({ code, fallback }: MermaidBlockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<MermaidState>({ phase: 'pending' });

  useEffect(() => {
    const source = code.trim();
    if (source === '') {
      setState({ phase: 'fail', reason: '代码块为空' });
      return;
    }
    if (source.length > MAX_CODE_CHARS) {
      setState({ phase: 'fail', reason: `图源码过长（${source.length} 字符，上限 ${MAX_CODE_CHARS}）` });
      return;
    }
    const cached = svgCache.get(source);
    if (cached !== undefined) {
      // 缓存命中：同步出图（重挂不闪，也不进防抖窗）
      setState({ phase: 'ok', svg: retagCached(cached) });
      return;
    }
    let live = true;
    setState({ phase: 'pending' });
    const timer = setTimeout(() => {
      void renderDiagram(source, hostRef.current ?? document.documentElement).then(
        (svg) => {
          if (live) setState({ phase: 'ok', svg });
        },
        (err: unknown) => {
          if (live) setState({ phase: 'fail', reason: readableError(err) });
        },
      );
    }, RENDER_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code]);

  if (state.phase === 'ok') {
    return (
      <div className="pp-mermaid" data-mermaid-state="ok" ref={hostRef}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid 本地渲染产物（非模型 HTML；
            securityLevel:'strict' 下标签另经 mermaid 内建 DOMPurify） */}
        <div className="pp-mermaid-figure" dangerouslySetInnerHTML={{ __html: state.svg }} />
      </div>
    );
  }

  return (
    <div className="pp-mermaid" data-mermaid-state={state.phase} ref={hostRef}>
      {state.phase === 'fail' ? <div className="pp-mermaid-error">图渲染失败：{state.reason}</div> : null}
      <div className="pp-mermaid-fallback">{fallback}</div>
    </div>
  );
}
