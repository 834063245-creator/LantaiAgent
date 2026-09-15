// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// confirm-registry — 确认卡待决议表（confirm kind 的阻塞等待面）。
//
// 语义：show_asset(kind=confirm) 阻塞等待用户在卡上表决（plan 审批模式的
// 资产化泛化，协议 docs/archive/agent-asset-blocks.md §2.10 confirm kind）。
// 跨层协议：
//   - executor（streaming-executor）在调用 execute **之前**预发 Asset 事件
//     （卡必须先于决议存在——常规通道的终值事件从工具输出解析，等不到决议），
//     发卡同时 markConfirmEmitted(assetId) 并把 resolveConfirm 挂进事件的
//     onResponse 回调；
//   - 工具（show-asset.ts）execute 内 waitForConfirm(assetId) 挂起，
//     用户点击（FormBody → block.asset._confirm → resolveConfirm）后决议
//     作为工具结果回传给模型；
//   - 无界面通道（dispatchNestedTool 嵌套/headless）不预发卡——emit 标记
//     缺席，waitForConfirm 立即以 no_ui 放行，不空等超时。
//
// 纯 agent 层模块（零 UI 依赖）；决议不持久化（回调经事件管道瞬态传递，
// 重载后的历史确认卡只读态——PlanPart._callback 先例）。

import type { ConfirmCardResponse } from './agent-types';

/** 等待上限——对齐 plan 审批的 5 分钟（防 UI 丢失时永久挂起）。 */
export const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingConfirm {
  resolve: (response: ConfirmCardResponse) => void;
}

const pending = new Map<string, PendingConfirm>();
const emitted = new Set<string>();

/** executor 预发卡时标记（表示该 assetId 有真实 UI 通道承载表决）。 */
export function markConfirmEmitted(assetId: string): void {
  emitted.add(assetId);
}

/** 用户表决入口（FormBody 点击按钮 → resolveConfirm）。
 *  幂等：无待决议（已决议/超时后补点）= 无操作，绝不重复 resolve。 */
export function resolveConfirm(assetId: string, response: ConfirmCardResponse): boolean {
  const p = pending.get(assetId);
  if (!p) return false;
  pending.delete(assetId);
  p.resolve(response);
  return true;
}

/**
 * 挂起等待用户决议。
 *  - 有 UI 通道（emitted 已标记）：等到 resolveConfirm 或 5 分钟超时；
 *  - 无 UI 通道（嵌套/headless 未预发卡）：立即以 no_ui 放行，不空等。
 */
export function waitForConfirm(assetId: string): Promise<ConfirmCardResponse> {
  if (!emitted.has(assetId)) {
    return Promise.resolve<ConfirmCardResponse>({ decision: 'no_ui' });
  }
  return new Promise<ConfirmCardResponse>((resolve) => {
    let settled = false;
    pending.set(assetId, {
      resolve: (r) => {
        if (settled) return;
        settled = true;
        resolve(r);
      },
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      pending.delete(assetId);
      resolve({ decision: 'timeout' });
    }, CONFIRM_TIMEOUT_MS);
  });
}

/** 测试复位（生产不调用）。 */
export function clearConfirmRegistryForTests(): void {
  pending.clear();
  emitted.clear();
}
