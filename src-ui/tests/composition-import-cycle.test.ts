// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// composition 图导入成环守卫（S6 P1c，2026-09-15 实测）——**静态面守卫**。
//
// 背景（本批实测连踩两次）：composition 图的模块体求值落在同一个环上——
//   - `state/composition-store` 模块体调 `factoryComposition()`；
//   - `state/preset-store` 模块体调 `builtinPresets()`；
//   两条链都要经 `composition/roster → shell-rows → src/shell/rows/*`，而
//   `rows/chat` 又静态 import `app/chat/chat-core`。于是只要 `chat-core` 侧**静态**
//   可达这两个 store 之一（或 `composition/preset-assembly`），环即闭合，症状：
//   `Cannot access 'BUILTIN_PRESETS' / '__vite_ssr_import_N__' before initialization`
//   （同族错误 2026-09-14 在卷持久化层炸过一次，连坐 46 个测试文件）。
//
// 为何是**源码断言**而不是运行时探针：运行时症状依赖模块求值顺序（vitest 的 SSR
// 模块图按解析先后求值）——实测把静态 import 换回去后，「单独 import
// state/preset-store」的运行时探针时红时绿（同一份代码先红后绿），拿它当守卫会变成
// 随机红。故守卫钉**静态面**：静态 import 白名单逐项相等（多一个即红）。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TARGET = 'src/app/chat/session-composition.ts';

const read = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

/** 取文件里静态 import 语句的模块说明符（含 type-only）。 */
function staticSpecifiers(src: string): string[] {
  return src
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line))
    .map((line) => line.match(/from\s+'([^']+)'/)?.[1] ?? line);
}

describe('composition 图导入成环守卫（P1c）', () => {
  it('静态面白名单：只准 chat-core 已静态依赖的三个模块（多一个即可能成环）', () => {
    const specs = staticSpecifiers(read(TARGET));
    // chat-store / chat-session / agent-session-state——三者都在 chat-core 的既有
    // 静态图里（不引入新模块进环），且模块体不消费未初始化的绑定。
    expect([...specs].sort()).toEqual(
      ['../../agent/agent-session-state', '../../ui/chat-session', '../../ui/chat-store'].sort(),
    );
  });

  it('store 与 composition 解析面一律动态 import（静态可达即成环）', () => {
    const src = read(TARGET);
    expect(src).toContain("await import('../../composition/preset-assembly')");
    expect(src).toContain("await import('../../state/preset-store')");
  });

  // S6 P2a：装配期 seam 作用域是**键控叶模块**——被工具层（agent/tools/coding）、
  // 会话基础设施与 agent 构造三面静态依赖，一旦它自己长出一条通往 store /
  // roster 的静态边，环立刻闭合（同族症状见文件头注）。故此守卫钉它的叶性：
  // 只准 type-only import（esbuild 擦除，运行时零边）。
  it('seam-scope 叶性：零项目内运行时静态 import（type-only 允许）', () => {
    const src = read('src/composition/seam-scope.ts');
    const runtimeSpecs = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) && !/^\s*import\s+type\b/.test(line));
    expect(runtimeSpecs).toEqual([]);
  });
});
