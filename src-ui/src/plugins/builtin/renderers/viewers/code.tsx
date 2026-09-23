// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 代码/文本查看器（渲染面补全 B2，2026-09-23）——hljs 高亮 + 行号列 + 固定盒高
// （`max-height`，超长内部滚动）+ 吸顶截断横幅。认领表真源 = `paper/viewer-exts.ts`
// 的 `VIEWER_CODE_EXTS`（宿主层单一真源：认领与静态测高同一张表）。
//
// 为什么 hljs 内联进产物（而不是像 B6/mermaid 那样走宿主桥）：hljs 是**轻依赖**
// （lib/common ~36 语言 + 本项目补注册的 shell/科研语言各几 KB）——内联换来
// 「零新依赖 + 只换产物热更」；重依赖（pdf/mermaid/three）才需要应用 bundle 分片
// （判据见施工单 D3）。
//
// 墨阶单一真源：hljs 只产出类名，`.hljs-*` → 纸面墨阶的映射在
// `PaperPanel.css` 的「`.pp-md-code / .pp-viewer-code` 共享选择器组」——流内围栏码
// 与查看器同色，不重复一份配色。
//
// 截断纪律（**不静默**）：宿主按 `readLines + 1` 行开窗；本件只显示前 `readLines` 行，
// 窗口里存在下一行 ⇒ 出吸顶横幅说清「只显示前 N 行（文件更长）」。
// （总行数在行窗口读取下不可得——要它得整份读进 IPC，那是白屏先例 INVARIANTS #11 的形态。）

import hljs from 'highlight.js/lib/common';
import hljsClojure from 'highlight.js/lib/languages/clojure';
import hljsDart from 'highlight.js/lib/languages/dart';
import hljsDos from 'highlight.js/lib/languages/dos';
import hljsGradle from 'highlight.js/lib/languages/gradle';
import hljsHaskell from 'highlight.js/lib/languages/haskell';
import hljsJulia from 'highlight.js/lib/languages/julia';
import hljsLatex from 'highlight.js/lib/languages/latex';
import hljsPowershell from 'highlight.js/lib/languages/powershell';
import hljsProtobuf from 'highlight.js/lib/languages/protobuf';
import hljsScala from 'highlight.js/lib/languages/scala';
import { VIEWER_CODE_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';

const { useMemo } = rendererHooks;

/** 补注册（模块装载期一次；hljs 对已注册语言重复 register 是覆盖，幂等放行）。
 *  `lib/common` 不含这几个本项目认领的语言；流内围栏码的补注册表在
 *  `app/paper/builtin-renderers.tsx`（应用域，另一份运行时），语义同源、各自内联。 */
hljs.registerLanguage('clojure', hljsClojure);
hljs.registerLanguage('dart', hljsDart);
hljs.registerLanguage('dos', hljsDos);
hljs.registerLanguage('gradle', hljsGradle);
hljs.registerLanguage('haskell', hljsHaskell);
hljs.registerLanguage('julia', hljsJulia);
hljs.registerLanguage('latex', hljsLatex);
hljs.registerLanguage('powershell', hljsPowershell);
hljs.registerLanguage('protobuf', hljsProtobuf);
hljs.registerLanguage('scala', hljsScala);

/** ext → hljs 语言 id（缺省/不识别 → 原文 mono：`hljs.getLanguage` 判据，与流内围栏码同款）。
 *  `html/htm` 走 `xml`（hljs 的 xml 注册含 html 别名）；`vue/svelte/txt/log` 无语言 ⇒ 原文。 */
const LANG_BY_EXT: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  rs: 'rust',
  py: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  hs: 'haskell',
  clj: 'clojure',
  cljs: 'clojure',
  jl: 'julia',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  dart: 'dart',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  sql: 'sql',
  proto: 'protobuf',
  gradle: 'gradle',
  ini: 'ini',
  cfg: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  tex: 'latex',
};

/** 行窗口（与注册面 `readLines` **同值**——宿主多读 1 行作「文件更长」判据）。 */
const CODE_LINE_CAP = 2000;

/** 体积闸（近似：按窗口文本**字符数**判，文案里如实说「约」）：行窗口挡不住单行
 *  巨型文件（压缩产物/data URI 一行几 MB）——那种输入不该进 DOM/hljs。 */
const CODE_MAX_CHARS = 2 * 1024 * 1024;

interface CodeView {
  /** hljs 输出（null = 原文；hljs 无该语言或高亮抛错） */
  html: string | null;
  plain: string;
  /** 行号列文本（1..lineCount，逐行一行） */
  gutter: string;
  lineCount: number;
  /** 窗口里还有下一行 ⇒ 出了截断横幅 */
  truncated: boolean;
}

/** 文本 → 视图模型（纯函数；`useMemo` 包一层——避免每次重渲染重跑 2000 行 tokenizer）。 */
function buildCodeView(text: string, ext: string): CodeView {
  const all = text.length > 0 ? text.split('\n') : [];
  const truncated = all.length > CODE_LINE_CAP;
  const shown = truncated ? all.slice(0, CODE_LINE_CAP) : all;
  const plain = shown.join('\n');
  const lang = LANG_BY_EXT[ext];
  let html: string | null = null;
  if (lang && hljs.getLanguage(lang)) {
    try {
      // 半成型/超长行 tolerate：与流内围栏码同款 ignoreIllegals
      html = hljs.highlight(plain, { language: lang, ignoreIllegals: true }).value;
    } catch {
      html = null;
    }
  }
  return {
    html,
    plain,
    gutter: shown.map((_, i) => i + 1).join('\n'),
    lineCount: shown.length,
    truncated,
  };
}

function CodeViewer({ bytes, ext, mode }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const view = useMemo(() => buildCodeView(text, ext), [text, ext]);
  // 代码没有放大形态（浮层由宿主渲染，但「点击看大图」语义对文本无意义）
  if (mode === 'overlay') return null;
  if (view.lineCount === 0) return <div className="pp-viewer-code-empty">文件为空（0 行）</div>;
  return (
    <div className="pp-viewer-code">
      {view.truncated && <div className="pp-viewer-code-note">已截断：只显示前 {CODE_LINE_CAP} 行（文件更长）</div>}
      <div className="pp-viewer-code-row">
        <div className="pp-viewer-code-gutter" aria-hidden="true">
          {view.gutter}
        </div>
        {view.html !== null ? (
          <pre className="pp-viewer-code-pre">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: hljs 输出为可信本地渲染（非模型 HTML；转义由 hljs 内建） */}
            <code dangerouslySetInnerHTML={{ __html: view.html }} />
          </pre>
        ) : (
          <pre className="pp-viewer-code-pre">
            <code>{view.plain}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

export const codeViewer: ViewerDef = {
  id: 'code',
  exts: VIEWER_CODE_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: CODE_LINE_CAP,
  maxBytes: CODE_MAX_CHARS,
  component: CodeViewer,
};
