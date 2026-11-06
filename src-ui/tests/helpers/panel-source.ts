// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸壳**源码面**的读取口（测试专用）。
//
// 2026-11-06 上帝文件治理 P3：PaperPanel.tsx 拆成三件（视图 / 装配根
// use-paper-panel.ts / 表现件 paper-panel-parts.tsx）。源码级断言（「这个类名还在
// 不在」「这行调用长什么样」）原本只读 PaperPanel.tsx——拆完就得跟着代码走，
// 否则断言退化成「文件搬家检查」。
//
// 口径与 paper-visual-decisions.test.ts 的既有聚合一致：同目录全部 .ts/.tsx
// 按名排序拼接。断言对象仍是这份源码，只是不再假设它住在一个文件里。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAPER_DIR = join(__dirname, '..', '..', 'src', 'plugins', 'builtin', 'paper-shell');

/** 纸壳全部源码（PaperPanel.tsx + use-paper-panel.ts + paper-panel-parts.tsx + use-*.ts）。 */
export function readPaperSources(): string {
  return readdirSync(PAPER_DIR)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .sort()
    .map((f) => readFileSync(join(PAPER_DIR, f), 'utf8'))
    .join('\n');
}
