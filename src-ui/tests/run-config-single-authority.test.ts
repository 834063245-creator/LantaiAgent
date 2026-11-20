// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 守门测试 · **四笔只有一个读写入口**（2026-11-29 收口批立法）。
//
// 为什么需要它：题签从 11-15 落地到 11-20，19 次提交里 12 次是真机 fix——其中 9 次是同一
// 类根因的复发形态：「这一笔到底该读谁 / 该写哪儿」，每个宿主自己判一遍：
//   · 读：宿主从 `draft-sheet-store.focusedId` 摸题签 ⇒ 多纸同屏时每张纸显示焦点那张的三笔；
//   · 写：组合 / 模型 / 思考 / 权限各写各的路（题签 / 卷级 / 全局 / 出厂值），互不知情。
// 收口后规则只有一份（`state/run-config`），**组件层不许再自己判**。本测试就是那条闸：
// 谁在组件里重新长出这套判断，测试当场红——而不是等下一次真机报障。
//
// 白名单只有「转换点」，每一条都写明为什么它必须直接摸 picks：
//   · paper-shell/DraftSheet.tsx —— 纸壳本身：按纸渲染 + 出厂题签写入（它是纸的宿主）；
//   · app/chat/chat-core.ts      —— 发送即开卷：把焦点那张纸的题签交给开卷（唯一转换点）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/** 去掉注释（判据只看代码——本仓注释里大量引用这些名字）。 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => p.slice(SRC.length + 1).replace(/\\/g, '/');

/** 组件层（插件产物 + 应用编排）：四笔的读写都只许经 run-config。 */
function uiFiles(): string[] {
  return [...walk(join(SRC, 'plugins')), ...walk(join(SRC, 'app'))];
}

describe('守门 · 「这一卷打算怎么跑」四笔只有一个入口', () => {
  it('没有任何组件再「经 focusedId 取题签」', () => {
    /* 病灶形态：同一个文件里既读焦点、又读题签 ⇒ 多纸同屏必然张冠李戴。 */
    const offenders = uiFiles()
      .filter((f) => {
        const src = code(f).replace(/pp-folio-picks/g, '');
        return /\bfocusedId\b/.test(src) && /\.picks\b|picks\?\./.test(src);
      })
      .map(rel);
    expect(offenders.sort(), '这些文件又在「自己判读哪张纸的题签」——改走 resolveRunConfig(目标)').toEqual([
      'app/chat/chat-core.ts',
      'plugins/builtin/paper-shell/DraftSheet.tsx',
    ]);
  });

  it('插件产物里不许直接读 `.picks`（只有纸壳的出厂写入例外）', () => {
    const offenders = walk(join(SRC, 'plugins'))
      .filter((f) => /\.picks\b|picks\?\./.test(code(f)))
      .map(rel);
    expect(offenders, '插件读题签 = 又一处第二真源（经 useRunConfig / resolveRunConfig 取）').toEqual([
      'plugins/builtin/paper-shell/DraftSheet.tsx',
    ]);
  });

  it('组件层不许绕开 run-config 写「出生默认 / 待题纸出厂值」', () => {
    const banned = /setGlobalModel\s*\(|setGlobalThinking\s*\(|setSheetPermissionDefault\s*\(/;
    const offenders = uiFiles()
      .filter((f) => banned.test(code(f)))
      .map(rel);
    expect(offenders, '写这四笔只许经 patchRunConfig（组件自己调 = 又一条写路径，迟早和三处语义对不上）').toEqual([]);
  });

  it('组件层不许自己写题签（纸壳的出厂填充例外）', () => {
    const offenders = walk(join(SRC, 'plugins'))
      .filter((f) => /\bsetPicks\s*\(|\.setPresetId\s*\(/.test(code(f)))
      .map(rel)
      .sort();
    expect(offenders, '写题签只许经 patchRunConfig（纸壳的出厂填充是唯一例外）').toEqual([
      'plugins/builtin/paper-shell/DraftSheet.tsx',
    ]);
  });
});
