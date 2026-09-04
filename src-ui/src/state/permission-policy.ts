// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// permission-policy —— TS 权限策略层数据面真源（R1，kernel-plugin-architecture-decision
// v3：TS = 策略建议层 / Rust 能力口 = 强制层）。
//
// R1 收拢对象（docs/plans/kernel-permission-strategy-layer-r1.md §1.4 分身清单）：
//   1. auto 白名单——原散两端镜像（bridges.ts AUTO_WHITELIST ×
//      src-tauri permissions::auto_mode_allows），本模块为 TS 单真源。
//   2. 出厂系统规则表 + danger 标签 + suggestion 数据面——原只在 Rust
//      rule.rs load_system_rules 编译期内置（TS 无消费方 = 死数据镜像，R1 只
//      立真源不建消费）；六步裁决迁移随 R3（TS 策略闸接管）落地。
//
// 使用纪律：auto 旁路判定一律走 autoAllows()；禁止在消费方（bridges/ComposerDock/
// Rust 镜像）重建名单字面量。Rust 侧 auto_mode_allows 在 R3 随六步裁决退役前，
// 以守卫测试（tests/permission-policy.test.ts）盯两侧名单一致。

/** auto 模式自动放行的工具白名单——按工具家族名（与 Rust Tool.name() 同语义）：
 *  "Edit" = edit_file/write_file/delete_file/move_file/create_directory/log_append。
 *  真源锚：Rust 侧 auto_mode_allows 的镜像（src-tauri/src/permissions/mod.rs）；
 *  两侧名单变更必须同步 + 过守卫测试。 */
export const AUTO_WHITELIST: ReadonlySet<string> = new Set(['Edit']);

/** Rust 侧 permissions::auto_mode_allows 的名单镜像（守卫测试对拍用）。
 *  R3 随六步裁决迁移退役后，本镜像删、真源只剩本模块。 */
export const RUST_AUTO_WHITELIST: readonly string[] = ['Edit'];

/** auto 模式判定：白名单内工具自动放行（Rust auto_mode_allows 同语义）。
 *  yolo 全放不在此判定（调用方按 mode 先短路）；本函数只管 auto 一档。 */
export function autoAllows(toolName: string): boolean {
  return AUTO_WHITELIST.has(toolName);
}

/** 权限请求的自动旁路总判定（bridges.ts 事件桥短路用）：mode 三档语义——
 *  yolo → 全放；auto → 白名单放行；ask → 不放行（弹卡）。 */
export function shouldAutoApprove(permMode: 'ask' | 'auto' | 'yolo', toolName: string): boolean {
  return permMode === 'yolo' || (permMode === 'auto' && autoAllows(toolName));
}
