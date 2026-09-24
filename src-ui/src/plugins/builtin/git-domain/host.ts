// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// git-domain · 宿主依赖面 · 开发/测试域。
//
// 2026-09-24 批 4c-1 归家：git 工具族已搬进本包（原 agent/tools/coding.ts 的 git 段）
// ⇒ 本文件从「桥工厂」翻面成**桥它仍住内核的依赖面**。内核侧仍留
// `agent/git-porcelain.ts`（被 `agent/state-inject.ts` 消费 ⇒ 宿主→插件禁反；
// 随批 6 state-hooks 一并搬）——本包经 faceDeps 取用它的两个解析器。

export { parseGitLogCommits, parseGitStatusPorcelain } from '../../../agent/git-porcelain';
export type { Tool, ToolExecutor } from '../../../agent/tool';
export { toInputJsonSchema } from '../../../agent/tools/define-tool';
