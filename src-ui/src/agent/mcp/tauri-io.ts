// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! MCP / ACP 的 Tauri stdio 桥适配 — 把 Rust 侧 protocol_bridge 命令/事件包装成
//! ProcIO / 行 I/O，让 webview 里的 MCP client / ACP server 能驱动真实子进程。
//! 与 base transport / acp 解耦（它们保持纯逻辑、可测），本文件只在 Tauri 宿主组装。

import { typedListen, typedRpc } from '../../rpc-contract';
import type { ProcIO } from './transport';

/** 用 Rust protocol_bridge 起子进程并返回 ProcIO（webview 用）。spawn 完成后 resolve。
 *  env：追加注入的子进程环境变量（app shell S2——受治进程的宿主寻址面，
 *  如 LANTAI_PLUGIN_DATA_DIR；缺省 undefined = 不注入，行为与 S2 前一致）。 */
export async function createTauriProcIO(
  bridgeId: string,
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<ProcIO> {
  await typedRpc('protocol_bridge_spawn', { id: bridgeId, command, args, env });
  const lineCbs: Set<(line: string) => void> = new Set();
  const exitCbs: Set<(code: number | null) => void> = new Set();
  let closed = false;
  const unsubs: Array<() => void> = [];
  // 2026-09-01 审计：unlisten 原本只在 kill() 里执行——子进程自然退出时两个
  // 全局监听永不解除，事件对失效实例持续扇出。退出事件到达即自清（幂等）。
  const close = () => {
    if (closed) return;
    closed = true;
    for (const un of unsubs.splice(0)) {
      try {
        un();
      } catch {
        // ignore
      }
    }
  };
  const unsubOut = await typedListen('protocol-bridge:output', (payload) => {
    if (payload.id !== bridgeId) return;
    for (const cb of lineCbs) cb(payload.line);
  });
  unsubs.push(unsubOut);
  const unsubExit = await typedListen('protocol-bridge:exit', (payload) => {
    if (payload.id !== bridgeId) return;
    close(); // 自然退出也解除监听（泄漏修复：见 close 上方注释）
    for (const cb of exitCbs) cb(payload.code);
  });
  unsubs.push(unsubExit);
  return {
    writeLine: (line) => {
      void typedRpc('protocol_bridge_write', { id: bridgeId, line });
    },
    onStdoutLine: (cb) => {
      lineCbs.add(cb);
      return () => {
        lineCbs.delete(cb);
      };
    },
    onExit: (cb) => {
      exitCbs.add(cb);
      return () => {
        exitCbs.delete(cb);
      };
    },
    kill: (reason) => {
      close();
      void typedRpc('protocol_bridge_kill', { id: bridgeId, reason });
    },
  };
}
