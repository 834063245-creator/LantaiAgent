// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话持久化 provider · 宿主依赖面 · 构建产物域。
// 运行时依赖 kernel* 具名 helper 经宿主桥 mods.faceDeps 取用。

/* eslint-disable */
interface PluginHostBridge {
  mods: { faceDeps: Record<string, unknown> };
}

function requireHost(): PluginHostBridge {
  const host = (globalThis as { __lantai_plugin_host__?: PluginHostBridge }).__lantai_plugin_host__;
  if (!host) {
    throw new Error('[sessions-builtin/host.aliased] 宿主桥不可用——内置插件必须在兰台宿主内装载');
  }
  return host;
}

const impl = requireHost().mods.faceDeps as unknown as typeof import('./host');

export const kernelDeleteFile = impl.kernelDeleteFile;
export const kernelAppendFileDurable = impl.kernelAppendFileDurable;
export const kernelReadFileRaw = impl.kernelReadFileRaw;
export const kernelTruncateFile = impl.kernelTruncateFile;
export const kernelListDirectory = impl.kernelListDirectory;
export const kernelWriteFile = impl.kernelWriteFile;
