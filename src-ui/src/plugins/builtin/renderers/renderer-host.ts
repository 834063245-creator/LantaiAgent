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

import type { ComponentType } from 'react';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AssetStateKey,
  type AssetStatePatchResult,
  getAssetState,
  patchAssetState,
} from '../../../agent/asset-state';
import { Overlay } from '../../../app/overlay';
import { loadHeavyViewer } from '../../../app/paper/viewers';
import { createBlock, type SourcedBlock } from '../../../paper/block-model';
import { activeMarkdownBody, type MarkdownBodyComponent } from '../../../paper/markdown-body-seam';
import { typedRpc } from '../../../rpc-contract';
import type { ViewerProps } from './viewer-registry';

export const rendererReact: typeof React = React;
export const rendererHooks = { useEffect, useMemo, useRef, useState };
export const rendererOverlay = Overlay;
export type { OverlayProps } from '../../../app/overlay';

/**
 * 查看器建 markdown 块出口（A4 销账 W1，2026-09-28）：`paper/block-model.ts` 带**模块级
 * 发号器**（`let blockSeq`——块 id `pb{n}` 的唯一来源），故不得随包内联：副本会与内核
 * 各发各的号，而画布以块 id 为键（撞号 = 两块抢一格）。经本桥取内核同一实例的发号器。
 * 形状刻意收成「双走查实际要的那一种」（markdown 块 + viewer 自造源），不是通用建块面。
 */
export function rendererCreateBlock(text: string): SourcedBlock<'markdown'> {
  return createBlock('markdown', { text }, { messageId: 'viewer', part: null });
}

/**
 * 纸面 markdown 体渲染取用（批 8c）：实现由产物 `paper-renderers` 在 apply 期登记进**内核**
 * 登记表 `paper/markdown-body-seam.ts`——产物域不得相对 import 该模块（会被 esbuild 内联成
 * 另一份实例，读不到内核的登记），故经本宿主桥取值（同 rendererLoadViewer 纪律）。
 */
export function rendererActiveMarkdownBody(): MarkdownBodyComponent | null {
  return activeMarkdownBody();
}

/** 渲染器侧的状态桥面（asset-state 的读/写两函数；HtmlBody 消费）。 */
export interface RendererAssetStateFace {
  get(key: AssetStateKey, assetId: string): Record<string, unknown> | null;
  patch(key: AssetStateKey, assetId: string, patch: Record<string, unknown>): AssetStatePatchResult;
}

/**
 * html 卡状态桥（2026-10-07 asset-state）：读写面真源 = 内核模块 `agent/asset-state.ts`
 * ——产物域不得相对 import 该模块（会被 esbuild 内联成另一份实例，模块级状态分家：
 * 卡片写进副本、Agent 读内核那份，永不互通），故经本宿主桥取值。
 * 产物域（`renderer-host.aliased.ts`）面缺（宿主/产物版本偏斜）= null，
 * 消费方（HtmlBody）如实拒绝而不是假装成功。
 */
export function rendererAssetState(): RendererAssetStateFace | null {
  return { get: getAssetState, patch: patchAssetState };
}

/**
 * 媒体渲染器的 RPC 取用（内置渲染器唯一需要 RPC 的地方——read_file_base64）。
 * 声明为函数出口，宿主桥 alias 面按同形状替换。
 */
export function rendererRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  return typedRpc(method as never, params as never);
}

/** 重依赖查看器取件（P2）：本体在应用 bundle（vite 真分片），产物域这侧经宿主桥同形取用。 */
export function rendererLoadViewer(id: string): Promise<ComponentType<ViewerProps>> {
  return loadHeavyViewer(id);
}
