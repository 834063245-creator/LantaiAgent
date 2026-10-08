// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// bootstrap.ts has been replaced by agent/runtime/agent-builder.ts (pure, zero
// ui/ imports) and ui/runtime-adapter.ts (UI implementation). All agent/ files
// must remain pure — no UI imports, no browser APIs.
// If you need a new agent→ui channel, add a callback to AgentUINotifier /
// RuntimeNotifier / constructor injection instead.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const AGENT_DIR = join(process.cwd(), 'src', 'agent');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// import ... from '../ui/...' or '../../ui/...'
const UI_IMPORT_RE = /from\s+['"][^'"]*\.\.\/ui\//;
/** 浏览器 API 检测走 **AST**（2026-10-08 修：正则版把字面量里的代码示例误判——
 *  「教模型用状态桥」批把 `window.lantai.state` 写进了 asset-kinds.ts 的 kind
 *  描述字符串，正则 `window\.[A-Za-z]` 照样命中 ⇒ 红线误报。AST 节点天然区分
 *  代码与字符串，且检测语义不放松：真调用（属性访问 / 元素访问 / rAF 调用）照旧命中。 */
function findBrowserApiUsage(file: string, src: string): string | null {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  let hit: string | null = null;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'requestAnimationFrame'
    ) {
      hit = 'requestAnimationFrame(';
      return;
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'window' || node.expression.text === 'document')
    ) {
      hit = ts.isPropertyAccessExpression(node)
        ? `${node.expression.text}.${node.name.text}`
        : `${node.expression.text}[...]`;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
}

describe('agent → ui one-way boundary', () => {
  const files = walk(AGENT_DIR);

  it('scans a non-trivial number of agent files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${relative(AGENT_DIR, file)} — no ui/ imports, no browser APIs`, () => {
      const src = readFileSync(file, 'utf8');
      const uiHit = src.match(UI_IMPORT_RE);
      expect(uiHit, `ui/ import found: ${uiHit?.[0]}`).toBeNull();
      const domHit = findBrowserApiUsage(file, src);
      expect(domHit, `browser API found: ${domHit}`).toBeNull();
    });
  }
});
