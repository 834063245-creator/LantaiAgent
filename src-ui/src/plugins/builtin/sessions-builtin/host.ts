// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话持久化 provider · 宿主依赖面 · 开发/测试域。
// 运行时依赖 kernel* 具名 helper 经宿主桥 mods.faceDeps 取用（产物域）；
// tsc/vitest/bundle 域直连真源。esbuild 产物域重定向到 host.aliased.ts。

export { kernelListDirectory, kernelReadFileRaw, kernelWriteFile } from '../../../rpc-contract';
