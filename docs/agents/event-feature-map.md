# Event → Feature/Mechanism Map（D4 事件面叙事）

> 平台化 Phase 1 · D4（2026-08-27）落档；Phase 3（2026-08-27）起本文件只保留
> **叙事面**（feature → mechanism 对照与规划）。机械矩阵（事件 → mode/载荷/
> 发射点/监听点）已迁 `event-catalog.md` 生成物（`scripts/gen-event-catalog.cjs`
> 从 `AGENT_EVENT_MAP` + 全仓调用点扫描生成，doc-sync 门禁对拍）——手写表随
> 生成器退役（拆旧清单 T-P3-1/T-P3-2 清零）。

> **R1 声明（session-log 冻结面）**：loop/能力域事件是可观测监听面——
> **非模型可见、不进 session log**；session 溯源仍走三入口 +
> 既有 `turn/start` sessionLog append（双轨不混）。legacy tool/* 事件保持
> executor 双发（bus + legacy sink），UI 零改动。

## feature → mechanism（既有功能 ↔ 机制对照）

| 功能 | 现机制 | D4 后的机制位 |
|---|---|---|
| plan 模式写拦截 | planGate 直调（executor ctor 参数 / eventBus tool/guard 两路径，trace fixture 逐字节等价钉住） | tool/guard 监听面已开放；生产路径 P5 切 eventBus |
| HIGH 风险 preflight 警告 | PreflightHookRegistry 直调 | tool/preflight（同上） |
| 输出富化 hooks | HookRegistry.apply 直调 | tool/around（同上） |
| 工具结果 UI 投影 | executor legacy sink 双发 | tool/result / tool/error + sink 双发不变 |
| 轮次/步/请求可观测 | log.info 散点（agent.ts） | turn/step/request 六事件（P5 重表达） |
| 子代理活动追踪 | wrapSubAgentSink 手工 tee | subagent/spawn / subagent/done（P5 重表达位） |

## 事件面开关（Phase 3 增补）

`seam/loopEvents` 组合域（patch/preset）可按事件名禁用 emit 观测事件的广播——
仅观测面裁剪（R1 语义不变）；裁决域 tool/guard|preflight|around 是强制层
语义（planGate / HIGH gate / hooks），**不开放禁用**。机械矩阵见
`event-catalog.md`；裁剪语义见 `docs/composition/README.md` §seam 裁剪域。

## 生产接线现状（如实）

- executor 第 8 参 `eventBus = null`：工具管道走 legacy 直调路径（两路径等价由
  convergence trace fixture 钉住）；**Phase 5「第一方全量挂 seam」时统一切
  eventBus 路径 + 第一方监听器重表达**。
- loop/能力域 bus 由 Agent 内建（`Agent._loopEvents`），与 executor 无耦合；
  监听入口 = `Agent.onLoopEvent`（D4 监听面），当前零第一方消费者（零行为差）。
