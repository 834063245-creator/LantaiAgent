// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LLM adapter · 宿主依赖面 · 开发/测试域。
//
// 2026-09-24 批 2a 归家（账本 §1.2 / §6 批 2）：三方言实现（anthropic/openai/responses）
// 与两个私有 helper（shared/retry）已搬进本包 ⇒ 本文件从「桥三个工厂」翻面成
// **桥它们仍住内核的依赖面**：seam 契约（types）· 目录与模型元数据（catalog/model-meta）·
// 错误分类（error-catalog）· 思考档（thinking）· 传输（transport）· 协议默认端点表（settings）。
// 产物域经宿主桥 mods.faceDeps 取用（host.aliased.ts 同形状镜像）。

export { clampMaxTokens, getModel } from '../../../provider/catalog';
export { type ClassifiedProviderError, classifyProviderError } from '../../../provider/error-catalog';
export type { ModelMeta } from '../../../provider/model-meta';
export { modelEntries, parseModelEntry } from '../../../provider/model-meta';
export type { StoredThinking, ThinkingEffort } from '../../../provider/thinking';
export {
  assertEffortDeclared,
  isThinkingMode,
  THINKING_EFFORT_BUDGETS,
  thinkingCapability,
} from '../../../provider/thinking';
export { proxyFetch } from '../../../provider/transport';
export type {
  ChatImageRef,
  Chunk,
  Message,
  ModelDescriptor,
  Provider,
  Request,
  ResponsesOutputItem,
  Role,
} from '../../../provider/types';
// seam 契约（类型面；runtime 值为 ApiError 类 / ChunkType 常量 / 错误分类与消息规整工具）
export {
  ApiError,
  ChunkType,
  classifyError,
  classifyStreamError,
  errorCodeFromBody,
  retryAfterSeconds,
  sanitizeToolPairing,
} from '../../../provider/types';
// 协议默认端点表（`PROVIDER_PROTOCOL_DEFAULTS.anthropic` —— 批 2a 把字面量上收至此，
// 端点真源单点：适配器与设置面板读同一张表）
export { PROVIDER_PROTOCOL_DEFAULTS } from '../../../settings';
