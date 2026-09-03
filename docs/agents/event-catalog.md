# 事件目录（生成物）

> 由 `scripts/gen-event-catalog.cjs`（经 tsx 运行 `src-ui/scripts/gen-event-catalog.ts`）
> 从 `src/agent/events.ts`（AGENT_EVENT_MAP / LOOP_EVENT_NAMES 运行时真源）+ 全仓调用点扫描生成 — 勿手改。
> 事件面变更后重新生成并同 commit；不含时间戳——字节稳定是 `--check`（doc-sync 门禁）的前提。

共 13 个事件（loop/能力域 8 + 工具管道域 5）。

> R1 声明：loop/能力域事件是可观测监听面——非模型可见、不进 session log；
> legacy tool/* 事件保持 executor 双发（bus + legacy sink），UI 零改动。
> 事件面开关：`seam/loopEvents` 组合域可禁用 emit 观测事件的广播
> （裁决域 tool/guard|preflight|around 不开放——见 docs/composition/README.md §seam 裁剪域）。

| 事件 | mode | 载荷 | 声明处 | 发射点 | 监听点 |
|---|---|---|---|---|---|
| `request/end` | emit | RequestEndPayload | `src/agent/events.ts:54` | `src/agent/agent-loop/default-loop.ts:183` | — |
| `request/start` | emit | RequestStartPayload | `src/agent/events.ts:53` | `src/agent/agent-loop/default-loop.ts:177` | — |
| `step/end` | emit | StepEndPayload | `src/agent/events.ts:52` | `src/agent/agent-loop/default-loop.ts:290` · `src/agent/agent-loop/default-loop.ts:371` | — |
| `step/start` | emit | StepStartPayload | `src/agent/events.ts:51` | `src/agent/agent-loop/default-loop.ts:54` | — |
| `subagent/done` | emit | SubagentDonePayload | `src/agent/events.ts:56` | `src/agent/agent.ts:1684` · `src/agent/agent.ts:1692` | — |
| `subagent/spawn` | emit | SubagentSpawnPayload | `src/agent/events.ts:55` | `src/agent/agent.ts:1666` | — |
| `tool/around` | waterfall | ToolPipelineContext + string | `src/agent/events.ts:45` | `src/agent/streaming-executor.ts:444` | `src/agent/agent.ts:503` · `src/agent/events.ts:302` |
| `tool/error` | emit | ToolPipelineContext + string | `src/agent/events.ts:47` | `src/agent/streaming-executor.ts:504` | — |
| `tool/guard` | waterfall | ToolPipelineContext | `src/agent/events.ts:43` | `src/agent/streaming-executor.ts:161` | `src/agent/agent.ts:434` · `src/agent/events.ts:273` |
| `tool/preflight` | serial | ToolPipelineContext | `src/agent/events.ts:44` | `src/agent/streaming-executor.ts:354` | `src/agent/agent.ts:512` · `src/agent/events.ts:286` |
| `tool/result` | emit | ToolPipelineContext + object | `src/agent/events.ts:46` | `src/agent/streaming-executor.ts:506` · `src/agent/streaming-executor.ts:509` | — |
| `turn/end` | emit | TurnEndPayload | `src/agent/events.ts:50` | `src/agent/agent-loop/default-loop.ts:379` | — |
| `turn/start` | emit | TurnStartPayload | `src/agent/events.ts:49` | `src/agent/agent-loop/default-loop.ts:51` | `src/agent/agent-loop/observability.ts:25` |

## feature → mechanism 叙事

功能与机制的对照叙事见 `event-feature-map.md`（本文件是机械矩阵——两者分工：
矩阵 = 代码事实对拍面，叙事 = 设计意图与重表达规划）。
