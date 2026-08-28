// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 平台契约文档守卫（平台化 Phase 6 · P6-C1/C4）——「平台契约文档与代码现状
// 对齐」的轻量钉：
//   - cookbook 每个 seam 指南存在（与 service-catalog 的 seam 域对拍）；
//   - plugins README §0 平台契约总览含全部 seam 名 + 信任模型二分标记 +
//     契约版本指针；
//   - 信任模型 v1 已知债明示（P6-C4：静态完全信任 + 动态 approval+沙箱）。
// 完整「逐字对齐」由 doc-sync 门禁（生成物对拍）+ 各生成物守护测试承担；
// 本测试钉人类契约的形状（缺 seam = 文档撒谎，验收失败）。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const PLUGINS_README = path.join(ROOT, 'docs', 'plugins', 'README.md');
const COOKBOOK_DIR = path.join(ROOT, 'docs', 'cookbook');
const CONTRACT_DOC = path.join(ROOT, 'docs', 'agents', 'open-surface-contract.md');

describe('P6-C1 平台契约文档形状守卫', () => {
  it('cookbook 每 seam 指南存在（llm/subagents/fs/shell/session/graph/dynamic/mcp）', () => {
    const files = [
      'adding-an-llm-adapter.md',
      'adding-a-subagent-provider.md',
      'adding-a-fs-backend.md',
      'adding-a-shell-backend.md',
      'adding-a-session-backend.md',
      'adding-a-graph-backend.md',
      'adding-a-dynamic-plugin.md',
      'adding-an-mcp-server.md',
    ];
    for (const f of files) {
      expect(existsSync(path.join(COOKBOOK_DIR, f)), `缺 cookbook：${f}`).toBe(true);
    }
  });

  it('plugins README §0 平台契约总览含全部 seam + 信任模型二分 + 契约版本指针', () => {
    const readme = readFileSync(PLUGINS_README, 'utf8');
    expect(readme).toContain('# 0. 平台契约总览');
    for (const seam of [
      'ctx.llm',
      'ctx.subagents',
      'ctx.fs',
      'ctx.shell',
      'ctx.sessionPersistence',
      'ctx.graph',
      'ctx.agentLoop',
    ]) {
      expect(readme, `§0 缺 seam ${seam}`).toContain(seam);
    }
    expect(readme).toContain('swappable seam（能力契约层——可换实现）');
    expect(readme).toContain('open-surface-contract.md');
    // P6-C4：信任模型二分明示
    expect(readme).toContain('静态插件 = **完全信任（v1 已知债）**');
    expect(readme).toContain('动态插件 = **approval + 沙箱**');
  });

  it('发布路径文档存在（docs/user/develop/publishing-plugins.md）', () => {
    expect(existsSync(path.join(ROOT, 'docs', 'user', 'develop', 'publishing-plugins.md'))).toBe(true);
  });

  it('开放面契约文档含当前版本与变更记录', () => {
    const doc = readFileSync(CONTRACT_DOC, 'utf8');
    expect(/当前版本：\d+/.test(doc)).toBe(true);
    expect(doc).toContain('## 变更记录');
    expect(doc).toContain('contract-fingerprint');
  });
});
