// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// first-party-manifest 守护：44 个第一方插件必须有清单条目、无孤儿条目、
// name 与 key 一致、元数据合法。任何新增第一方插件（BUILTIN_PLUGINS 加行）
// 必须同步本清单——缺条目会让 loader 跳过装载 + error 记录（运行时断层），
// 本测试在测试期就拦死（错误不静默，先把断层炸在 CI）。

import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_MANIFEST, FIRST_PARTY_VERSION } from '../src/plugins/first-party-manifest';
import { allBuiltinPlugins } from '../src/plugins/loader';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

describe('first-party-manifest（清单完备性守护）', () => {
  it('全部第一方插件在清单中（无遗漏——缺一条 loader 就断层）', () => {
    const names = allBuiltinPlugins().map((p) => p.name);
    const missing = names.filter((n) => !(n in FIRST_PARTY_MANIFEST));
    expect(missing).toEqual([]);
  });

  it('清单无孤儿条目（清单内的 name 都在第一方插件里）', () => {
    const names = new Set(allBuiltinPlugins().map((p) => p.name));
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

  it('计数快照（46 = 13 内核 service + 33 出厂 feature）', () => {
    // graph-service / graph-builtin / engine-domain 随图谱功能全量退役（2026-09-09）：45 → 42
    // office-domain 新增（2026-09-13，C 路：OfficeCLI 一等域工具，取代 MCP 挂接）：42 → 43
    // plan-mode 新增（2026-09-24 批 6a：规划模式实现归产物，内核 capability 查登记表）：43 → 44
    // goal-mode 新增（2026-09-24 批 6b：goal 循环实现归产物）：44 → 45
    // state-hooks 新增（2026-09-24 批 6c：出厂 hook 四工厂归产物）：45 → 46
    expect(Object.keys(FIRST_PARTY_MANIFEST)).toHaveLength(46);
  });

  it('两类都有存量：service 平台服务（常驻）与 feature 功能插件（可禁用）', () => {
    const kinds = new Set(Object.values(FIRST_PARTY_MANIFEST).map((m) => m.kind));
    expect(kinds).toEqual(new Set(['service', 'feature']));
  });
});
