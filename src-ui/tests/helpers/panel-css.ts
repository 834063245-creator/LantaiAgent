// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸壳样式的**读取面**（测试专用）。
//
// 2026-11-06 上帝文件治理 P2：PaperPanel.css 6778 行按主题段拆成 12 个分片，
// 入口只剩 @import。断言面语义不变——测的是「这份样式长什么样」，不是「某个
// 文件的字节」；唯一变化是读法（入口 + 按序展开分片）。
//
// 只展开同目录的 `./paper-*.css`：跨包 @import（app/type-scale.css）不在纸壳断言
// 面内，与拆分前「只读 PaperPanel.css」的口径一致。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PAPER_CSS_DIR = join(__dirname, '..', '..', 'src', 'plugins', 'builtin', 'paper-shell');
const ENTRY = join(PAPER_CSS_DIR, 'PaperPanel.css');
const SLICE = /@import\s+['"](\.\/paper-[a-z-]+\.css)['"]/g;

/** 纸壳样式的完整文本（入口 + 按声明序展开的分片）。 */
export function readPanelCss(): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const load = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    parts.push(text);
    for (const m of text.matchAll(SLICE)) load(join(dirname(file), m[1]));
  };
  load(ENTRY);
  return parts.join('\n');
}
