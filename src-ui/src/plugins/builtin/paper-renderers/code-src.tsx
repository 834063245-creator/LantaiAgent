// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 代码高亮 + 程文程序体 —— 2026-11-22 从 renderers.tsx 拆出（那件已到上帝文件档顶：
// 展开态流式预览又给 CodeSrc 加了一条读法，正好按销账制把「高亮 + 程序体」这棵叶子搬出来）。
//
// 语义沿用不变量（原注）：高亮只包 span（不改字体/行数/换行）⇒ measure.ts 的程序体
// 镜像零改动；无 lang / lang 不识别 → 原文纯 mono；流式半成型代码 tolerate
// （ignoreIllegals:true）；纸面墨色由 CSS 按 .pp-md-code 作用域映射。

import hljs from 'highlight.js/lib/common';
import hljsClojure from 'highlight.js/lib/languages/clojure';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsHaskell from 'highlight.js/lib/languages/haskell';
import hljsJulia from 'highlight.js/lib/languages/julia';
import hljsLatex from 'highlight.js/lib/languages/latex';
import hljsMatlab from 'highlight.js/lib/languages/matlab';
import hljsScala from 'highlight.js/lib/languages/scala';
import hljsScheme from 'highlight.js/lib/languages/scheme';
import { useMemo } from 'react';

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
export function highlightCode(text: string, lang: string | undefined): string | null {
  if (!lang || !hljs.getLanguage(lang)) return null;
  try {
    // 半成型代码 tolerate：流式围栏未闭合也不崩
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** 程文程序体（P2-A 的「体」；2026-11-06 补高亮）——模型写给 code_execution 的
 *  JavaScript 程序。此前裸文本直出：同纸的围栏码 / 抄录块 / 代码查看器三处机器文本
 *  都有 hljs token 层，程文是唯一例外（用户报「模型输入的代码内容需要一个代码高亮
 *  渲染」）。纪律与 markdown 围栏码同款：
 *    · 语言由执行面钉死——`code-run/runtime-service.ts` 的
 *      `readonly language = 'javascript'`，不猜、不嗅探（猜错比不涂更糟）；
 *      hljs 抛错回落原文（不静默空块）；
 *    · **只包 span**（字符/折行/行数一字不改）⇒ measure.ts 的程序体镜像零改动；
 *    · 折叠态不渲染（`showSrc` 由调用方判），高亮不参与折叠规则。 */
export function CodeSrc({ code, plain = false }: { code: string; plain?: boolean }) {
  // plain = 流式预览帧（每 120ms 换一次原文）：半成型代码着色没有意义，20KB 的 span 树
  // 每帧重建还会拖垮纸面——收尾（args 到齐、p.code 就位）再一次性上色。行高/折行
  // 两种形态完全一致（hljs 只包 span），测高镜像不受影响。
  const highlighted = useMemo(() => (plain ? null : highlightCode(code, 'javascript')), [code, plain]);
  return (
    <pre className="pp-code-src">
      {highlighted !== null ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: hljs 输出为可信本地渲染（非模型 HTML；转义由 hljs 内建）
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code>{code}</code>
      )}
    </pre>
  );
}
