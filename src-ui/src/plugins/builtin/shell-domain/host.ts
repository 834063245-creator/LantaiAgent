// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell-domain · 宿主依赖面 · 开发/测试域。
//
// 2026-09-24 批 4c-3 归家：本族工具已搬进本包（原 agent/tools/coding.ts 的 shell 段）
// ⇒ 本文件从「桥工厂」翻面成**桥它仍住内核的依赖面**（seam 裁剪读面 + 发起方身份 +
// 活跃 provider 表 + sticky-cwd 注册表）。包内符号（`createShellTools` / `shellExecute`）
// 不经本面二次出口——`index.ts` 直连 `./shell-tools`。

export { stickyCwdOf } from '../../../agent/session-context';
export type { Tool, ToolExecutor } from '../../../agent/tool';
export { toInputJsonSchema } from '../../../agent/tools/define-tool';
export { ownerIdOf, ownerSeamView } from '../../../composition/seam-scope';
export type { ShellAction } from '../../../composition/shell-service';
export { activeShellProviders } from '../../../composition/shell-service';
