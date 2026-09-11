// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方 loop 可观测监听器（平台化 Phase 5 · 施工②）——「全第一方事件
// 监听器经通道/注册表贡献」的落地件。
//
// 重表达原则（R6 风险表：每迁移一件 = 快照/测试钉住）：只在事件载荷
// **数据可及**时把散点重表达为监听器（建新必拆旧——loop 体内对应散点
// 同步删除，不搞双线）；载荷收窄到 R1 观测面的（usage 明细等）保留原位，
// 显式记入 event-feature-map 的「部分重表达」清单（P6 观察项），不扩载荷。
//
// 当前重表达清单：
//   - turn/start → log.info('turn started', { provider, model })（载荷含两者 ✓）
// 其余散点（llm response / collect streaming results / stream error /
// empty assistant turn / pre-flight 族）保留在 loop 体/宿主原位——它们要么
// 依赖 loop 内部上下文（压缩埋点、pendingInserts），要么载荷在 R1 面不可
// 及（usage 明细——扩载荷 = 契约变更，留 P6 评估）。

import type { AgentEventBus } from '../events';
import { log } from '../logger';

/** 把第一方 loop 可观测监听器挂到 Agent 的 bus 上（Agent 构造期调用；
 *  返回 disposer——随 bus 生命周期，Agent 不存在时泄漏）。 */
export function attachFirstPartyLoopObservability(bus: AgentEventBus): () => void {
  return bus.onLoopEvent('turn/start', (payload) => {
    // 重表达自 default-loop 的 'turn started' 散点（载荷 provider/model 均可及）
    log.info('agent', 'turn started', { provider: payload.provider, model: payload.model });
  });
}
