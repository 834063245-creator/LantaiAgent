// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话文件引用的**宿主动作面**（2026-11-23 文件引用可点 · 相对路径批）：
// 渲染器只负责「这段文本是不是文件引用」（判据在 paper/file-ref），点开之后怎么开归这里。
//
// 为什么经 globalThis 而不是 import window-facility：直接 import 会把 mcp-bridge /
// 生命周期一族牵进渲染面，形成循环依赖（构建门禁直接红）。宿主桥 windows.openWith
// 就是这条缝的正式出口（产物域与测试域同一形状）。

import { useShellStore } from './host';

type FileOpenBridge = { windows?: { openWith?: (path: string) => boolean } };

/** 引用路径的解析基准 = 工作区根（与工具面「相对路径按工作区根解析」同一条约定）。
 *  渲染期取值而不快照：切工作区后旧消息里的相对引用跟着新根走——会话本就属于当前工作区。 */
export function workspaceRoot(): string {
  return useShellStore.getState().projectPath;
}

/** 把一份文件交给宿主窗口设施打开（没有宿主桥/没有文档能力插件时由宿主自己报可见错误）。 */
export function openReferencedFile(path: string): void {
  const host = (globalThis as { __lantai_plugin_host__?: FileOpenBridge }).__lantai_plugin_host__;
  const openWith = host?.windows?.openWith;
  if (typeof openWith === 'function') openWith(path);
}
