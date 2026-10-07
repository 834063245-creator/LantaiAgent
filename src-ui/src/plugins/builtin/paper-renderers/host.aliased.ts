// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸面块渲染器产物 · 宿主依赖面 · 构建产物域（批 8b）。
// 与 host.ts 同形状的镜像实现：全部能力从宿主桥 `mods.faceDeps` 取真实例；
// jsx / jsxs / Fragment 供 esbuild automatic JSX 注入（`--jsx-import-source=./host`）。
// 本文件不参与 tsc 测试域（onResolve 只在构建期把 './host' 指到这里）。

/* eslint-disable */
import type { ReactNode } from 'react';

interface PluginHostBridge {
  react: {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ReactNode;
    Fragment: unknown;
  };
  mods: { faceDeps: Record<string, unknown> };
}

function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) {
    throw new Error('[paper-renderers/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  }
  return host;
}

const host = requireHost();
const impl = host.mods.faceDeps as unknown as typeof import('./host');

export const MermaidBlock = impl.MermaidBlock;
export const Overlay = impl.Overlay;
export const previewUrlFor = impl.previewUrlFor;
export const readAttachmentBase64 = impl.readAttachmentBase64;
export const useShellStore = impl.useShellStore;
/** RPC 直呼（MdLocalImage 的 fs_cap read_base64）：既有宿主面键（faceDeps），沿用关门。 */
export const typedRpc = impl.typedRpc;
/** 差分语言判据（A4 销账 W1，2026-09-28）：实现住内核 `paper/translate.ts`，而该模块带
 *  状态（块 id 发号器经 `createBlock` 落 `paper/block-model.ts` 的 `let blockSeq`）——
 *  随包内联 = 第二套发号器与内核撞号，故经宿主桥取内核同一实例。 */
export const isDiffLang = impl.isDiffLang;

// ── esbuild automatic JSX 注入面（--jsx=automatic --jsx-import-source=./host）──

/** createElement 等价（自动 JSX 注入）。props 含 children（jsx-runtime 形状）⇒ 摊成实参
 *  （同 renderers/renderer-host.aliased 的修法：裸数组子元素会触发 key 告警刷屏）。 */
export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  const { children, ...rest } = props ?? {};
  const withKey = key != null ? { ...rest, key } : rest;
  if (!Array.isArray(children)) {
    return host.react.createElement(type, withKey, children) as ReactNode;
  }
  // biome-ignore lint/suspicious/noExplicitAny: createElement 形参为可变实参，React 类型面收窄此处无收益
  return host.react.createElement(type, withKey, ...(children as any[])) as ReactNode;
}

export function jsxs(type: unknown, props: Record<string, unknown> | null, key?: unknown): ReactNode {
  return jsx(type, props, key);
}

export const Fragment = host.react.Fragment;
