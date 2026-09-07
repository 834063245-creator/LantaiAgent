// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// JsonMessageStore — MessageStore 的 JSON 文件实现
//
// 将每个 agent 的 inbox 持久化到 .lantai/agents/{agentId}/inbox.json
// 模式参照 agent-store.ts：rpc 文件 I/O、ensureDir。
// 所有操作 best-effort — 永不抛异常阻塞主流程。

import {
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelListDirectory,
  kernelReadFile,
  kernelWriteFile,
} from '../rpc-contract';
import type { AgentMessage, MessageStore } from './message-types';

/** 判断读错误是否为「文件不存在」——此时该 agent 本来就无 inbox（空 inbox 从不落盘），
 *  属正常状态，静默跳过即可。覆盖 POSIX ENOENT / os error 2 与中英文文案。 */
function isFileNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes('os error 2') ||
    msg.includes('ENOENT') ||
    msg.includes('系统找不到指定的文件') ||
    msg.includes('路径不存在') ||
    msg.includes('not found') ||
    msg.includes('NotFound')
  );
}

// ── JsonMessageStore ──

export class JsonMessageStore implements MessageStore {
  private dirReady = false;

  constructor(private projectPath: string) {}

  private get baseDir(): string {
    return this.projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.lantai/agents';
  }

  private inboxPath(agentId: string): string {
    return `${this.baseDir}/${agentId}/inbox.json`;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    try {
      await kernelCreateDirectory(this.baseDir);
    } catch {
      /* already exists */
    }
    this.dirReady = true;
  }

  /** 遍历所有 inbox，每个写一个 JSON 文件。空 inbox 跳过。 */
  async flush(inboxes: Map<string, AgentMessage[]>): Promise<void> {
    await this.ensureDir();
    for (const [agentId, msgs] of inboxes) {
      try {
        // 空 inbox 不写文件
        if (msgs.length === 0) continue;
        await kernelCreateDirectory(`${this.baseDir}/${agentId}`);
        await kernelWriteFile(this.inboxPath(agentId), JSON.stringify(msgs, null, 2));
      } catch {
        /* best-effort — 单个 inbox 写失败不影响其他 */
      }
    }
  }

  /** 读取所有 agent 目录下的 inbox.json，组装成 Map 返回。
   *  restore 只读不删：`.lantai/agents/{id}/` 目录与 AgentStore 共享（后者写
   *  state.json/session.ndjson），一个有效 agent 可以只有 state.json 而没有
   *  inbox.json（空 inbox 从不落盘）。所以「缺失 inbox.json」是完全正常的状态，
   *  静默跳过；只有真正的意外读错误（IPC 抖动、权限、解析失败）才 warn 保留
   *  （P0-6 防线：瞬时读错误删 inbox = 静默丢未投递消息）。目录生命周期归
   *  AgentStore/会话删除管，本 store 不越权清理。 */
  async restore(): Promise<Map<string, AgentMessage[]>> {
    const result = new Map<string, AgentMessage[]>();
    try {
      const entries = await kernelListDirectory(this.baseDir, false);

      for (const entry of entries) {
        if (!entry.is_dir) continue;
        const agentId = entry.name;
        try {
          const rawInbox = await kernelReadFile(this.inboxPath(agentId));
          const msgs = JSON.parse(rawInbox) as AgentMessage[];
          if (Array.isArray(msgs) && msgs.length > 0) {
            result.set(agentId, msgs);
          }
          // 空 inbox.json（文件存在但内容空）不恢复也不删——它属于 AgentStore 目录。
        } catch (e) {
          // 缺失 inbox.json 是常态（空 inbox 从不落盘），静默跳过；
          // 其余读错误才 warn 保留待下次恢复。
          if (isFileNotFound(e)) continue;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[message-store] ${agentId} 的 inbox.json 读取失败，保留待下次恢复:`, msg);
        }
      }
    } catch {
      /* baseDir 不存在 — 无可恢复数据 */
    }
    return result;
  }

  /** 删除指定 agent 的 inbox 持久化文件和目录。
   *  在 bus.unregister() 时调用，清理磁盘残留。best-effort。 */
  async delete(agentId: string): Promise<void> {
    try {
      const dirPath = `${this.baseDir}/${agentId}`;
      // 删 inbox.json
      await kernelDeleteFile(this.inboxPath(agentId));
      // 尝试删 agent 目录（如果为空）
      try {
        const entries = await kernelListDirectory(dirPath, false);
        if (entries.length === 0) {
          await kernelDeleteFile(dirPath);
        }
      } catch {
        // 目录已不存在或不可访问 — 无需处理
      }
    } catch {
      /* best-effort — 文件可能已不存在 */
    }
  }
}
