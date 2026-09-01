// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent Store — 内存中的 agent 身份注册表（2026-09-01 积尘根治）。
//
// 迁变史：multiagent 时期曾把 agent 状态 + 会话全文落盘到 .lantai/agents/{id}/
// （state.json / session.ndjson / index.json）。但读面（load/list/delete）从未接上
// 任何消费者，磁盘目录只进不出（实测 328 个目录、326 份 state.json、247 份
// session.ndjson 积尘），还跟 message-store 的 inbox.json 共享同一目录引发误判
// 与告警刷屏（见 message-store.ts 头注）。根因 = 单写无读无删的死面。
// 2026-09-01 拍板：持久化写面拆除，agent 状态回归纯内存 registry（重启即空），
// 历史目录整体归档。身份/血缘运行时在内存即足够（Agent 构造 ctx、子代理池、
// TaskBoard 的 parentAgentId 各自持有一份）。
//
// 保留类与 API 形状（save/load/list/delete）以稳定引用面（workspace/ctx/agent
// 接线不动）；实现不再触碰磁盘、不再经 sessionPersistence seam、不再写
// session.ndjson（会话全文由父会话消息 SubAgentPart 持久化，见 message-model.ts）。

import type { Message } from '../provider/types';

// ── 类型 ──

export interface AgentRecord {
  id: string;
  parentId: string | null;
  description: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  createdAt: number;
  updatedAt: number;
  subagentDepth: number;
  /** Plan 模式快照 — { active, id } 用于会话恢复。null/undefined = 非 plan 模式。 */
  planSnapshot?: { active: boolean; id: string | null } | null;
}

export interface AgentLoadResult {
  record: AgentRecord;
  messages: Message[];
}

// ── AgentStore ──

export class AgentStore {
  /** 内存身份注册表：agentId → 最近一次 saveState 的身份记录（重启即空）。 */
  private records = new Map<string, AgentRecord>();

  /** 保存/更新 agent 身份记录（纯内存）。合并旧记录保持 createdAt 连续。 */
  save(id: string, partial: Partial<AgentRecord>): Promise<void> {
    const prev = this.records.get(id);
    const now = Date.now();
    const record: AgentRecord = {
      id,
      parentId: partial.parentId ?? prev?.parentId ?? null,
      description: partial.description ?? prev?.description ?? '',
      status: partial.status ?? prev?.status ?? 'idle',
      createdAt: partial.createdAt ?? prev?.createdAt ?? now,
      updatedAt: now,
      subagentDepth: partial.subagentDepth ?? prev?.subagentDepth ?? 0,
      planSnapshot: partial.planSnapshot,
    };
    this.records.set(id, record);
    return Promise.resolve();
  }

  /** 加载身份记录。会话消息不再落盘——messages 恒空数组（无历史全文可读）。 */
  async load(id: string): Promise<AgentLoadResult | null> {
    const record = this.records.get(id);
    if (!record) return null;
    return { record, messages: [] };
  }

  /** 列出全部内存中的身份记录。 */
  async list(): Promise<AgentRecord[]> {
    return [...this.records.values()];
  }

  /** 从内存注册表移除（不触磁盘）。 */
  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}
