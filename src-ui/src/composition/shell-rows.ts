// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行表（S2-0 占位 / S2-3 逐块填充）—— 壳装配的组合数据源。
//
// 壳行 = 启动接线单元（S2 设计件 §2.6）：main.ts init() 既有执行序切成
// 12 块，每块一行（id 惯例 hologram/shell-<block>）。与 cordis 插件通道
// 的分工：壳行是纯 boot 时序（无服务注册、无 disposer 诉求——根 fiber
// 生命周期 = 应用生命周期，dispose 无意义）；有 ctx 生命周期诉求的单元
// （四 service / S3 起的域插件）走插件通道（plugins/loader.ts）。
// DSH 同构物：browser 行是「cordis 存在前经 module table 组合」的启动期
// 单元，同样不是运行时插件。
//
// 表序 = 引导序（保序 await，逐行执行）；行 id 经 roster patch 的 shell
// 域可寻址禁用（禁用行的接线不发生，调用一致地失败——涟漪表见设计件
// §2.8）。行内代码不得假设前行必然成功（失败隔离，loader 同款纪律）。

import type { ShellRefs } from '../shell/runtime';

/** 壳行：id 寻址 + boot 接线动作。 */
export interface ShellRow {
  id: string;
  boot: (refs: ShellRefs) => void | Promise<void>;
}

/** 内置壳行表 — 表序 = 引导序。
 *  S2-0 为空占位（roster 引擎的 shell 域数据源先就位）；S2-3/S2-4 逐块
 *  迁入 12 行（platform / graph / chat / bridges / keyguard / sandbox-probe
 *  / dataflow-parser / nav / persistence / actions / workspace / cold-start）。 */
export function builtinShellRows(): ShellRow[] {
  return [];
}
