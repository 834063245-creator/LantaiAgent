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

  it('内核三家模板的 kind 落在 CORE_PROTOCOLS（anthropic/openai）', () => {
    expect(findVendorTemplate('anthropic')?.kind).toBe('anthropic');
    expect(findVendorTemplate('openai')?.kind).toBe('openai');
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

  it('未知厂商 findVendorTemplate 返回 undefined', () => {
    expect(findVendorTemplate('nonexistent')).toBeUndefined();
  });
});
