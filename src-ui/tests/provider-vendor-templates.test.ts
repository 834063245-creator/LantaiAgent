// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Vendor 连接模板表守护（provider-refactor 方案乙 Phase 1B）：
//   - 模板表不携带模型元数据（连接参数真源，模型运行时拉取）
//   - 每条模板唯一 vendor / 有 kind + baseUrl
//   - defaultBaseUrl 回落链：模板 → 目录 seed → 协议默认 → undefined（未知 kind 不静默给错端点）

import { describe, expect, it } from 'vitest';

import { findVendorTemplate, getVendorTemplateVendors, VENDOR_TEMPLATES } from '../src/provider/vendor-templates';

describe('vendor-templates', () => {
  it('模板表包含全部出厂厂商（chips 枚举面）', () => {
    expect(getVendorTemplateVendors()).toEqual(
      expect.arrayContaining([
        'anthropic',
        'openai',
        'deepseek',
        'glm',
        'minimax',
        'moonshotai',
        'ollama',
        'opencode',
        'qwen',
      ]),
    );
  });

  it('模板 vendor 唯一（chips 主键不可重复）', () => {
    const vendors = VENDOR_TEMPLATES.map((t) => t.vendor);
    expect(new Set(vendors).size).toBe(vendors.length);
  });

  it('每条模板都有 kind 与 baseUrl（连接参数完整性）', () => {
    for (const t of VENDOR_TEMPLATES) {
      expect(t.kind, `${t.vendor} 缺 kind`).toBeTruthy();
      expect(t.baseUrl, `${t.vendor} 缺 baseUrl`).toMatch(/^https?:\/\//);
    }
  });

  it('内核三家模板的 kind：anthropic/deepseek 走内核协议，openai 走 responses', () => {
    expect(findVendorTemplate('anthropic')?.kind).toBe('anthropic');
    // 2026-09-23 起官方 openai 行走 Responses（GPT-6 在 chat completions 上带工具需
    // reasoning_effort=none，见 vendor-templates.ts 该行注释）；deepseek 等第三方
    // 兼容端点没有 Responses 面，仍走 chat。
    expect(findVendorTemplate('openai')?.kind).toBe('responses');
    expect(findVendorTemplate('deepseek')?.kind).toBe('openai');
  });

  it('minimax 走 Anthropic 兼容端点（kind=anthropic + /anthropic 路径）', () => {
    const t = findVendorTemplate('minimax');
    expect(t?.kind).toBe('anthropic');
    expect(t?.baseUrl).toBe('https://api.minimax.io/anthropic');
  });

  it('ollama 本地端点无 defaultModel（连接后拉模型）', () => {
    const t = findVendorTemplate('ollama');
    expect(t?.baseUrl).toBe('http://localhost:11434/v1');
    expect(t?.defaultModel).toBeUndefined();
  });

  it('opencode 与 deepseek 模板 defaultModel 同源（复用上游 id 空间，不得一边刷新一边留 legacy）', () => {
    // 2026-09-23 真机事故：deepseek 行随官方改名（`8b6356bb`）刷成 deepseek-flash，
    // opencode 行漏刷、留着 legacy `deepseek-v4-flash` ⇒ 新建 opencode 连接拿到
    // 被网关拒的模型 id（HTTP 400，body 无原因），整轮重试全败。
    expect(findVendorTemplate('opencode')?.defaultModel).toBe('deepseek-flash');
    expect(findVendorTemplate('opencode')?.defaultModel).toBe(findVendorTemplate('deepseek')?.defaultModel);
  });

  it('未知厂商 findVendorTemplate 返回 undefined', () => {
    expect(findVendorTemplate('nonexistent')).toBeUndefined();
  });
});
