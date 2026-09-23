// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 渲染器宿主桥（内置渲染器插件专用）——从宿主桥取 React / Overlay / RPC
// （对齐插件自包含契约：插件模块无裸 import，宿主能力经
// `window.__lantai_plugin_host__` 取用）。
//
// 双走查设计（P1，first-party-hot-reload-plan）：
//   - 测试/开发域：本文件直接 import react / overlay / rpc（模块级真源，
//     测试 plugin 源码组件即走此面——保持现有 asset-primitives 等测试语义）；
//   - 生产/插件产物域：esbuild 构建时用 alias 把本文件替换为
//     renderer-host.aliased.ts（宿主桥取用面）——同一份组件源码，两个运行时
//     解析面，零重复实现。
//
// react 全量（组件）+ hooks 子集（useState/useEffect/useRef）都从这里出
// ——宿主桥的 React 出口（P1a）按此形状注入。

import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Overlay } from '../../../app/overlay';
import { typedRpc } from '../../../rpc-contract';

export const rendererReact: typeof React = React;
export const rendererHooks = { useEffect, useMemo, useRef, useState };
export const rendererOverlay = Overlay;
export type { OverlayProps } from '../../../app/overlay';

/**
 * 媒体渲染器的 RPC 取用（内置渲染器唯一需要 RPC 的地方——read_file_base64）。
 * 声明为函数出口，宿主桥 alias 面按同形状替换。
 */
export function rendererRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  return typedRpc(method as never, params as never);
}
