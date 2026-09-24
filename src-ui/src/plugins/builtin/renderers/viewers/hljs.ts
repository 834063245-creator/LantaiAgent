// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 查看器面 hljs 单一真源（批 8c，2026-09-25）——代码查看器（code）与笔记本查看器（ipynb）
// 共用**一份** highlight.js 实例与**一张**语言补注册表。
//
// 为什么内联进产物（而不是走宿主桥，同 mermaid/pdf/three 的重依赖例外相反）：hljs 是**轻依赖**
// （lib/common ~36 语言 + 本项目补注册的若干语言各几 KB）——内联换来「零新依赖 + 只换产物热更」；
// 重依赖（pdf/mermaid/three）才需要应用 bundle 分片（判据见 `docs/plugins/README.md` §3）。
//
// 批 8c 之前这里有两份独立内联副本（`viewers/code.tsx` 与内置块渲染器文件各注册一遍、语言表还不一致）
// ——本模块是那次合并的产物：**加语言 = 改这一处**（`EXTRA_LANGS` 表）。
// 墨阶映射（`.hljs-*` → 纸面墨色）仍在 paper-shell 的 `PaperPanel.css`（跨产物共享类名，不重复配色）。

import hljs from 'highlight.js/lib/common';
import hljsClojure from 'highlight.js/lib/languages/clojure';
import hljsDart from 'highlight.js/lib/languages/dart';
import hljsDockerfile from 'highlight.js/lib/languages/dockerfile';
import hljsDos from 'highlight.js/lib/languages/dos';
import hljsGradle from 'highlight.js/lib/languages/gradle';
import hljsHaskell from 'highlight.js/lib/languages/haskell';
import hljsJulia from 'highlight.js/lib/languages/julia';
import hljsLatex from 'highlight.js/lib/languages/latex';
import hljsMatlab from 'highlight.js/lib/languages/matlab';
import hljsPowershell from 'highlight.js/lib/languages/powershell';
import hljsProtobuf from 'highlight.js/lib/languages/protobuf';
import hljsScala from 'highlight.js/lib/languages/scala';
import hljsScheme from 'highlight.js/lib/languages/scheme';

/** 补注册表（`lib/common` 不含这些本项目认领的语言）。hljs 对已注册语言重复 register 是覆盖，
 *  幂等放行；注册时机 = 模块装载期一次（同 asset-kinds 尾部先例）。 */
const EXTRA_LANGS: ReadonlyArray<[string, unknown]> = [
  ['clojure', hljsClojure],
  ['dart', hljsDart],
  ['dockerfile', hljsDockerfile],
  ['dos', hljsDos],
  ['gradle', hljsGradle],
  ['haskell', hljsHaskell],
  ['julia', hljsJulia],
  ['latex', hljsLatex],
  ['matlab', hljsMatlab],
  ['powershell', hljsPowershell],
  ['protobuf', hljsProtobuf],
  ['scala', hljsScala],
  ['scheme', hljsScheme],
];

for (const [name, def] of EXTRA_LANGS) {
  hljs.registerLanguage(name, def as never);
}

export { hljs };
