// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// wait — 事件驱动等待工具。**只有「等目标完成」这一种语义，没有「干等」形态。**
//
// 两种调用形状：
//   - 传 agentId  → 等那一个子 Agent 落地（完成 / 失败 / 停止），落地即返回
//   - 不传 agentId → 等**当前所有在跑的子 Agent** 落地；一个都没在跑 = 立即返回
//
// 2026-11-20 用户拍板取消 `durationMs`（固定时长 sleep）：
//   「这个干等也太傻逼了，我要取消干等传参」。
// 拆它的理由不是手感，是**语义错位**：固定 sleep 把 wait 变成「睡 N 秒」——
// 模型据此可以拿它当拖延/抢跑（用户看到的就是干等），而「等谁」一个字都没有。
// 无事件可等的正确回答是「没有可等待目标 = 立即返回」，不是睡一觉再回来说
// 「现在去检查状态吧」。
//
// 历史（勿复活）：第一版 wait 就是固定 sleep（LLM 猜秒数，猜错白等/等不够），
// 改成事件驱动后 durationMs 作为兜底留下一段时间；本批把兜底一并拆除——
// 兜底路径同时也是「有 agentId 但 pool 缺席 → 静默退化成睡 10s」的骗人返回源。

import { z } from 'zod';
import type { SubAgentPool, Tool } from './host';
import { defineTool, SubAgentStatus } from './host';

const MAX_WAIT_MS = 600_000; // 10 分钟上限，对齐 SHELL_TIMEOUT
const POLL_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function statusLabel(status: SubAgentStatus): string {
  switch (status) {
    case SubAgentStatus.Completed:
      return '✅ 已完成';
    case SubAgentStatus.Failed:
      return '❌ 失败';
    case SubAgentStatus.Stopped:
      return '⏹️ 已停止';
    default:
      return '运行中';
  }
}

/** 目标是否仍未落地（运行中 / 排队中）。句柄缺席 = 已清理或 id 错误，不算在跑。 */
function isSettled(pool: SubAgentPool, id: string): boolean {
  const handle = pool.getHandle(id);
  if (!handle) return true;
  return handle.status !== SubAgentStatus.Running;
}

export function createWaitTool(pool?: SubAgentPool): Tool {
  return defineTool({
    name: 'wait',
    description:
      'Block until sub-agents finish, then return immediately — event-driven, there is nothing to sleep on. ' +
      'Pass agentId to wait for that one sub-agent; omit it to wait for ALL sub-agents currently running (with none running it returns at once, it does not wait anyway). ' +
      'The moment the last target settles you get its final status — no polling loops, no guessing durations. ' +
      'For background shell jobs use shell(wait, jobId) instead. ' +
      'Max 10 minutes per call; a timed-out wait leaves the targets running — call wait again to keep waiting.',
    schema: z.object({
      agentId: z
        .string()
        .optional()
        .describe(
          'Sub-agent ID to wait for (from agent_spawn result or agent_status). Omit to wait for all running sub-agents.',
        ),
      // timeoutMs 缺省 = MAX_WAIT_MS（10 min）：超时只是**这次等待**到点，目标照跑
      timeoutMs: z.coerce
        .number()
        .max(MAX_WAIT_MS)
        .optional()
        .default(MAX_WAIT_MS)
        .describe(
          'Max wait in ms (default 600000 = 10 min). On expiry it reports which targets are still running — they keep running; call wait again to continue.',
        ),
    }),
    readOnly: true,
    execute: async (args) => {
      if (!pool) {
        // 缺池 = 装配缺帐。旧行为是静默退化成睡 10s 再说「已等待」——正是本批拆掉的东西。
        return '(wait: 当前会话没有子 Agent 池（装配缺 subAgentPool）——没有可等待的目标)';
      }

      const start = Date.now();
      const timeoutMs = args.timeoutMs;
      const agentId = args.agentId;
      // id 不存在 → 立即返回。等一个不存在的东西，睡多久都是错的。
      if (agentId && !pool.getHandle(agentId)) {
        return `未找到子 Agent ${agentId}（可能已清理或 id 错误）。可用 agent_status 查看当前子 Agent。`;
      }
      const ids = agentId ? [agentId] : pool.listRunning().map((h) => h.id);
      if (ids.length === 0) return '当前没有运行中的子 Agent——无可等待目标。';

      for (;;) {
        const pending = ids.filter((id) => !isSettled(pool, id));
        if (pending.length === 0) {
          const waited = ((Date.now() - start) / 1000).toFixed(1);
          const lines = ids.map((id) => {
            const handle = pool.getHandle(id);
            if (!handle) return `- ${id} 已清理`;
            const result = handle.result ? ` — ${handle.result.replace(/\s+/g, ' ').slice(0, 500)}` : '';
            return `- ${id} ${statusLabel(handle.status)}${result}`;
          });
          const head = agentId
            ? `子 Agent ${agentId} ${statusLabel(pool.getHandle(agentId)?.status ?? SubAgentStatus.Completed)}`
            : `${ids.length} 个子 Agent 全部落地`;
          return `${head}（等待 ${waited}s）。\n${lines.join('\n')}`;
        }
        if (Date.now() - start >= timeoutMs) {
          const waited = (timeoutMs / 1000).toFixed(0);
          return agentId
            ? `⏱ 等待子 Agent ${agentId} 超时（${waited}s），仍在运行。可用 agent_status 查看进度，或再 wait 一次继续等、agent_kill 终止。`
            : `⏱ 等待超时（${waited}s），仍有 ${pending.length} 个子 Agent 在运行：${pending.join('、')}。可再 wait 一次继续等。`;
        }
        await sleep(POLL_INTERVAL_MS);
      }
    },
  });
}
