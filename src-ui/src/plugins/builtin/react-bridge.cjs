// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 UI 插件构建期 react 别名桥（first-party-hot-reload-plan 增补四施工）。
//
// esbuild alias 把 'react' 指到本文件（CJS）：产物内的全部 react import
// （面组件源码 + 被内联的 npm 依赖如 @react-aria/*）经运行时属性访问落到
// 宿主桥注入的同一份 React——产物零 React 副本（hooks 状态归一）。
//
// 本文件只进 esbuild 产物域，不参与 tsc/vitest（tsconfig include 不含 .cjs；
// biome 按配置跳过）。宿主桥在 loadBuiltinPlugins 装载第一方插件前注入。
module.exports = globalThis.__lantai_plugin_host__.react;
