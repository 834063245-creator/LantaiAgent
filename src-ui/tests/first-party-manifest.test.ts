// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// first-party-manifest 守护：43 个第一方插件必须有清单条目、无孤儿条目、
// name 与 key 一致、元数据合法。任何新增第一方插件（BUILTIN_PLUGINS 加行）
// 必须同步本清单——缺条目会让 loader 跳过装载 + error 记录（运行时断层），
// 本测试在测试期就拦死（错误不静默，先把断层炸在 CI）。

import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_MANIFEST, FIRST_PARTY_VERSION } from '../src/plugins/first-party-manifest';
import { BUILTIN_PLUGINS } from '../src/plugins/loader';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

describe('first-party-manifest（清单完备性守护）', () => {
  it('BUILTIN_PLUGINS 全部条目在清单中（无遗漏——缺一条 loader 就断层）', () => {
    const names = BUILTIN_PLUGINS.map((p) => p.name);
    const missing = names.filter((n) => !(n in FIRST_PARTY_MANIFEST));
    expect(missing).toEqual([]);
  });

  it('清单无孤儿条目（清单内的 name 都在 BUILTIN_PLUGINS 里）', () => {
    const names = new Set(BUILTIN_PLUGINS.map((p) => p.name));
    const orphans = Object.keys(FIRST_PARTY_MANIFEST).filter((n) => !names.has(n));
    expect(orphans).toEqual([]);
  });

  it('条目 name 与 key 一致；version/description/kind 合法', () => {
    for (const [key, m] of Object.entries(FIRST_PARTY_MANIFEST)) {
      expect(m.name).toBe(key);
      expect(m.version).toMatch(SEMVER_RE);
      expect(m.version).toBe(FIRST_PARTY_VERSION);
      expect(m.description.length).toBeGreaterThan(0);
      expect(['service', 'feature']).toContain(m.kind);
    }
  });

  it('计数快照（43 = 26 直列 + 15 工具域 + 1 prompt 段 + 1 capability 段）', () => {
    expect(Object.keys(FIRST_PARTY_MANIFEST)).toHaveLength(43);
  });

  it('两类都有存量：service 平台服务（常驻）与 feature 功能插件（可禁用）', () => {
    const kinds = new Set(Object.values(FIRST_PARTY_MANIFEST).map((m) => m.kind));
    expect(kinds).toEqual(new Set(['service', 'feature']));
  });
});
