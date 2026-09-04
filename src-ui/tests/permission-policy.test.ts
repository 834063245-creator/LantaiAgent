// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// permission-policy 守卫测试（R1，kernel-permission-strategy-layer-r1.md §7）：
//   1. shouldAutoApprove / autoAllows 语义单测（yolo 全放 / auto 白名单 / ask 不放行）
//   2. 静态守卫：bridges.ts 不再自建 AUTO_WHITELIST 字面量（真源收拢后禁止分身）
//   3. 静态守卫：TS 真源名单 ↔ Rust permissions::auto_mode_allows 名单一致
//      （R3 随六步裁决迁移退役 Rust 名单后，改守卫为「Rust 名单不存在」）
//   4. Rust 系统规则表（deny/ask/danger）R1 仍在编译期内置——记录 R3 迁移哨兵
//      （TS 出厂规则真源文件落位时本守卫反转）

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_WHITELIST, autoAllows, RUST_AUTO_WHITELIST, shouldAutoApprove } from '../src/state/permission-policy';

describe('permission-policy 语义', () => {
  it('auto 白名单 = {Edit}（与现状一致，防误扩）', () => {
    expect([...AUTO_WHITELIST]).toEqual(['Edit']);
  });

  it('autoAllows: 白名单命中放行，其余不放行', () => {
    expect(autoAllows('Edit')).toBe(true);
    expect(autoAllows('Bash')).toBe(false);
    expect(autoAllows('Read')).toBe(false);
    expect(autoAllows('Git')).toBe(false);
  });

  it('shouldAutoApprove: yolo 全放（无视工具）', () => {
    expect(shouldAutoApprove('yolo', 'Bash')).toBe(true);
    expect(shouldAutoApprove('yolo', 'anything')).toBe(true);
  });

  it('shouldAutoApprove: auto 只放行白名单', () => {
    expect(shouldAutoApprove('auto', 'Edit')).toBe(true);
    expect(shouldAutoApprove('auto', 'Bash')).toBe(false);
    expect(shouldAutoApprove('auto', 'Git')).toBe(false);
  });

  it('shouldAutoApprove: ask 一律不放行（弹卡）', () => {
    expect(shouldAutoApprove('ask', 'Edit')).toBe(false);
    expect(shouldAutoApprove('ask', 'Bash')).toBe(false);
  });
});

describe('permission-policy 单真源守卫', () => {
  it('bridges.ts 不再自建 AUTO_WHITELIST 字面量（真源收拢）', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/shell/rows/bridges.ts'), 'utf8');
    // 消费方只能 import 真源；不得出现名单字面量重建
    expect(src).not.toMatch(/AUTO_WHITELIST\s*=\s*new Set/);
    expect(src).not.toMatch(/new Set\(\[['"]Edit['"]\]\)/);
    // 必须消费真源判定
    expect(src).toContain('shouldAutoApprove');
  });

  it('TS 真源 ↔ Rust auto_mode_allows 名单一致（R3 退役前双份过渡）', () => {
    const rust = readFileSync(resolve(process.cwd(), '../src-tauri/src/permissions/mod.rs'), 'utf8');
    // Rust 侧名单：matches!(tool_name, "Edit") —— 提取字面量工具名
    const m = rust.match(/matches!\(tool_name,\s*"([^"]+)"\)/);
    expect(m, 'Rust auto_mode_allows 应存在 matches!(tool_name, "...")').not.toBeNull();
    const rustNames = [m![1]];
    expect([...RUST_AUTO_WHITELIST].sort()).toEqual([...rustNames].sort());
    expect([...AUTO_WHITELIST].sort()).toEqual([...rustNames].sort());
  });
});

describe('R3 迁移哨兵（文档化现状，不设门禁）', () => {
  it('出厂系统规则表 R1 仍在 Rust 编译期内置（load_system_rules）', () => {
    const rust = readFileSync(resolve(process.cwd(), '../src-tauri/src/permissions/rule.rs'), 'utf8');
    // 现状记录：R1 只立 TS 数据面真源（白名单），出厂表随 R3 裁决迁移。
    // 迁移完成时此处守卫应反转：Rust load_system_rules 不再存在。
    expect(rust).toContain('pub fn load_system_rules');
  });
});
