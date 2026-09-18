// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Vendor 连接模板表（provider-refactor 方案乙 Phase 1B，2026-09）——
// 取代 catalog/*.json 的 AddProviderSheet chips 预填职责，**不携带模型元数据**。
//
// 动机（方案乙）：预设厂商目录维护负担（新模型 = 发版）退役。静态 JSON 只留
// 内核 seed（anthropic/openai/deepseek 的官方常用款，带 contextWindow/maxTokens/
// thinkingEfforts——模型元数据真源仍在 catalog seed 里）；其余厂商连接参数收敛
// 到这张轻量模板表（vendor/kind/baseUrl/defaultModel），可用模型一律运行时从
// provider /models 拉取（AddProviderSheet 两步式已有拉取面）。
//
// 表项语义：
//   - vendor      厂商标识 = AddProviderSheet chips 主键 + 建议 provider 名；
//   - kind        连接协议（CONTEXT.md「Protocol」——内核 openai/anthropic 或
//                 注册表贡献的开放协议，如 Phase 2 的 responses）；
//   - baseUrl     厂商默认端点（defaultBaseUrl 回落的第二真源）；
//   - defaultModel 出厂/模板建议默认模型 id——纯提示不承诺存在（运行时 /models
//                 拉取后才可对话），内核三家指向 catalog seed 型号（带元数据）；
//   - label       厂商展示名（缺省 = vendor 本身）；
//   - authMode    登录方式（Phase 3 OAuth 订阅平面：缺省 'api-key'；
//                 'oauth' 走系统 OAuth grant 登录，见 provider/oauth.ts）；
//   - oauthProvider  authMode='oauth' 时的 provider 注册表 id（src-tauri oauth
//                 模块，如 codex）。
//
// ⚠️ 本表只放「连接参数」，不放模型清单/窗口/档位——放模型 = 回到发版负担。
//    新增厂商 = 本表加一行（改代码一次），新模型 = 零改动（运行时拉取）。

import type { Protocol } from './types';

export interface VendorTemplate {
  /** 厂商标识（chips 主键 + 建议 provider 名）。 */
  vendor: string;
  /** 连接协议（内核白名单或注册表贡献的开放协议）。 */
  kind: Protocol;
  /** 厂商默认端点。 */
  baseUrl: string;
  /** 模板建议默认模型 id（纯提示，不承诺存在；内核三家 = catalog seed 型号）。 */
  defaultModel?: string;
  /** 厂商展示名（缺省 = vendor）。 */
  label?: string;
  /** 登录方式（Phase 3：缺省 'api-key' 零迁移）。 */
  authMode?: 'api-key' | 'oauth';
  /** authMode='oauth' 时的 src-tauri oauth provider 注册表 id。 */
  oauthProvider?: string;
}

/** 厂商连接模板表（单一真源——AddProviderSheet chips / defaultBaseUrl 回落链消费）。
 *  顺序即 chips 展示顺序：内核三家在前，其余按字母序。 */
export const VENDOR_TEMPLATES: readonly VendorTemplate[] = [
  {
    vendor: 'anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
  },
  {
    vendor: 'openai',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
  },
  {
    vendor: 'deepseek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-flash',
  },
  {
    vendor: 'glm',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3-flash',
    label: '智谱 GLM',
  },
  {
    vendor: 'minimax',
    kind: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    defaultModel: 'MiniMax-M3',
    label: 'MiniMax',
  },
  {
    vendor: 'moonshotai',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    label: 'Moonshot Kimi',
  },
  {
    vendor: 'ollama',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    label: 'Ollama（本地）',
  },
  {
    vendor: 'opencode',
    kind: 'openai',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'deepseek-v4-flash',
    label: 'OpenCode GO',
  },
  {
    vendor: 'codex',
    kind: 'responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    defaultModel: 'gpt-5.6-sol',
    label: 'ChatGPT Codex（订阅）',
    authMode: 'oauth',
    oauthProvider: 'codex',
  },
  {
    vendor: 'qwen',
    kind: 'openai',
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.7-plus',
    label: '阿里 Qwen（Token Plan）',
  },
];

/** 按 vendor 查连接模板。 */
export function findVendorTemplate(vendor: string): VendorTemplate | undefined {
  return VENDOR_TEMPLATES.find((t) => t.vendor === vendor);
}

/** 全部模板 vendor 清单（chips 展示序）。 */
export function getVendorTemplateVendors(): string[] {
  return VENDOR_TEMPLATES.map((t) => t.vendor);
}
