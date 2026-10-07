// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset 域产物 · 宿主依赖面 · 开发/测试/编译域（批 9g-2，2026-09-26）。
//
// 三工具（show_asset / update_asset / list_block_kinds）随包后仍要用**内核的**资产表、
// 确认注册表与 kind 注册表——它们都是**有状态单例**（内核 agent/executor/UI 同读同写）：
//   - `agent/asset-store`：资产表（agent.ts 重建 / ui/chat-session 清理 / 本包增删查）；
//   - `agent/confirm-registry`：确认桥（streaming-executor 发确认、本包 await 结果）；
//   - `agent/asset-kinds`：kind 注册表与校验面（composition/renderer-service 与 paper/measure 同用）。
// 内联这三者到产物 = 副本状态分裂（工具写副本、UI/executor 读内核那份）⇒ 一律经宿主桥取真实例。

export {
  assetDigest,
  assetKinds,
  generateAssetId,
  parseAssetEventOutput,
  requireKind,
  requirePresentation,
  validatePayload,
} from '../../../agent/asset-kinds';
// 资产状态摘要（2026-10-07 asset-state）：list_block_kinds 的「用户在这张卡上做过什么」
// 读面——按 owner（_owner_id）解析所属会话后取派生读数（键数 / 字节数）。
export { listAssetStateSummaryForOwner } from '../../../agent/asset-state';
export type { AssetRecord } from '../../../agent/asset-store';
export { findAssetByContent, getAsset, listAssets, upsertAsset } from '../../../agent/asset-store';
export { waitForConfirm } from '../../../agent/confirm-registry';
export type { Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
