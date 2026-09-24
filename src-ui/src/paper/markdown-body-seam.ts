// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸面 markdown 体渲染登记表（批 8b，2026-09-25）——**内核侧登记表 + 产物登记实现**
// （同 `agent/plan/plan-impl.ts` 接缝，`capability-impl-seam-design.md` §2）。
//
// 为什么需要它：块渲染器十一 kind 归产物 `paper-renderers/`（批 8b），其中 markdown 体渲染
// 是**跨产物的复用面**——`renderers` 产物的 ipynb / markdown-doc 两个查看器要复用同一份
// markdown 渲染（零第二份解析），而产物之间不得互相相对 import（自包含纪律）。故：内核对
// 外只暴露「取当前 markdown 体组件」这一个读面，`paper-renderers` 在 apply 期登记实现。
//
// 分类 = **service 语义**（该产物在名册标 `required: true`，不可禁用 ⇒ 缺实现 = 装歪了）：
// 消费点用 `activeMarkdownBody()` 读并可给出可读缺失态（查看器原有的「渲染器缺失」文案）；
// 需要硬失败的新消费点用 `requireMarkdownBody()`。
//
// 模块级可变态归属：CONVENTIONS §1.10 第 3 类（单键自清理注册表，生命周期 = 进程）。
// **叶模块纪律**：零项目内运行时依赖（仅 type-only 引 React 与块模型）——被查看器与产物
// 宿主面同时引用，长出静态边即成环。

import type { ComponentType } from 'react';
import type { SourcedBlock } from './block-model';

/** markdown 体渲染组件的**最小形状**（渲染器只吃块本体——与 BlockRendererProps 的
 *  必填字段一致；产物侧传的是完整 `MarkdownBody`，形状兼容）。 */
export type MarkdownBodyComponent = ComponentType<{ block: SourcedBlock }>;

let impl: MarkdownBodyComponent | null = null;
let seq = 0;

/** 登记 markdown 体渲染实现。返回 disposer（调用方挂 ctx.effect——插件拆卸即撤销登记）。
 *  栈语义同 plan-impl：disposer 回退到登记前的值，且此后若又有人登记过则不动。 */
export function registerMarkdownBody(next: MarkdownBodyComponent): () => void {
  const prev = impl;
  const token = ++seq;
  impl = next;
  return () => {
    if (token !== seq) return;
    seq++;
    impl = prev;
  };
}

/** 读当前实现。未登记（产物未装载）= null——消费点给可读缺失态，不静默出空白。 */
export function activeMarkdownBody(): MarkdownBodyComponent | null {
  return impl;
}

/** 硬失败读法（service 语义消费点）：缺实现 = 装配断层，当场抛出具名错误。 */
export function requireMarkdownBody(): MarkdownBodyComponent {
  if (!impl) {
    throw new Error(
      'markdown 体渲染实现缺失：hologram/paper-renderers 产物未装载（required 产物不可禁用）——检查产物通道 / loadBuiltinPlugins。',
    );
  }
  return impl;
}

/** 测试隔离辅助——清空登记（生产代码禁用）。 */
export function clearMarkdownBodyForTest(): void {
  impl = null;
}
