# Event → Feature/Mechanism Map（D4 事件目录）

> 平台化 Phase 1 · D4（2026-08-27）落档。**代码单一真源** =
> `src-ui/src/agent/events.ts` 的 `AGENT_EVENT_MAP`（mode 声明）+
> `LoopEventPayload`（载荷形状）+ `LOOP_EVENT_NAMES`（运行时镜像）；
> 本文件是人类可读映射，漂移由 `tests/agent-loop-events.test.ts` 完整性 guard
> 钉住（P3 扩 `gen-event-catalog` 生成器后改生成物对拍）。

> **R1 声明（session-log 冻结面）**：loop/能力域事件是可观测监听面——
> **非模型可见、不进 session log**；session 溯源仍走三入口 +
> 既有 `turn/start` sessionLog append（双轨不混）。legacy tool/* 事件保持
> executor 双发（bus + legacy sink），UI 零改动。

## 事件目录（发射点 = 代码事实）

| 事件 | mode | 载荷 | 发射点 | 第一方消费机制 |
|---|---|---|---|---|
| `tool/guard` | waterfall | ToolPipelineContext | executor 派发前 | planGate（attachPlanGate 适配——现状直调） |
| `tool/preflight` | serial | ToolPipelineContext | executor 执行前 | PreflightHookRegistry（attachPreflightRegistry——现状直调） |
| `tool/around` | waterfall | ToolPipelineContext + output | executor 结果后 | HookRegistry enrich（attachHookRegistry——现状直调） |
| `tool/result` | emit | ctx + result | executor 落定 | legacy sink 双发（UI/模型可见——现状） |
| `tool/error` | emit | ctx + err | executor 错误路径 | legacy sink 双发（现状） |
| `turn/start` | emit | TurnStartPayload | Agent.runLoop 起始 | P5：轮次计数/审计监听重表达位 |
| `turn/end` | emit | TurnEndPayload | Agent.runLoop finally | P5：运行态指示收口重表达位 |
| `step/start` | emit | StepStartPayload | runLoop 每迭代头 | P5：进度条监听重表达位 |
| `step/end` | emit | StepEndPayload | runLoop 每迭代双出口（早退 + 自然尾） | P5：步统计重表达位 |
| `request/start` | emit | RequestStartPayload | runLoop stream 调用前 | P5：token 预算监听 |
| `request/end` | emit | RequestEndPayload | runLoop stream 返回后 | P5：usage 仪表（现 log.info 散点的重表达位） |
| `subagent/spawn` | emit | SubagentSpawnPayload | Agent.spawnSubAgent 漏斗 | P5：subagent-activity 重表达位 |
| `subagent/done` | emit | SubagentDonePayload | Agent.spawnSubAgent 漏斗 | P5：board/UI 卡片收口重表达位 |

## feature → mechanism（既有功能 ↔ 机制对照）

| 功能 | 现机制 | D4 后的机制位 |
|---|---|---|
| plan 模式写拦截 | planGate 直调（executor ctor 参数 / eventBus tool/guard 两路径，trace fixture 逐字节等价钉住） | tool/guard 监听面已开放；生产路径 P5 切 eventBus |
| HIGH 风险 preflight 警告 | PreflightHookRegistry 直调 | tool/preflight（同上） |
| 输出富化 hooks | HookRegistry.apply 直调 | tool/around（同上） |
| 工具结果 UI 投影 | executor legacy sink 双发 | tool/result / tool/error + sink 双发不变 |
| 轮次/步/请求可观测 | log.info 散点（agent.ts） | turn/step/request 六事件（P5 重表达） |
| 子代理活动追踪 | wrapSubAgentSink 手工 tee | subagent/spawn / subagent/done（P5 重表达位） |

## 生产接线现状（如实）

- executor 第 8 参 `eventBus = null`：工具管道走 legacy 直调路径（两路径等价由
  convergence trace fixture 钉住）；**Phase 5「第一方全量挂 seam」时统一切
  eventBus 路径 + 第一方监听器重表达**。
- loop/能力域 bus 由 Agent 内建（`Agent._loopEvents`），与 executor 无耦合；
  监听入口 = `Agent.onLoopEvent`（D4 监听面），当前零第一方消费者（零行为差）。
