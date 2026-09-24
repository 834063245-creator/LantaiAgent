// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 测试腰：把压缩实现按**生产生命周期**登记（批 6d-2）。
//
// 为什么要它：生产里实现由 `hologram/compaction` 插件在**装载期**登记，该 fiber 随根
// Context 常驻（main.ts → loadBuiltinPlugins）。而测试常用的通道腰是**瞬时**的（run 结束
// 即拆卸、登记随之回退）；一旦 Agent 装配发生在腰外（组合值带出腰使用），blueprint 的
// compaction 工具 capability（agent-builder 的 `registerCompactionTools`）与 Agent 的压缩
// 方法查不到实现 ⇒ 按 service 语义 fail-loud。本腰复现「装载器已跑过」的常驻态。
//
// 幂等：重复调用无害（登记表栈语义——后登记胜、回退到上一版）。

import { registerCompactionImplementation } from '../../src/agent/compaction-impl';
import { compactionImplementation } from '../../src/plugins/builtin/compaction/implementation';

let installed = false;

/** 常驻登记压缩实现（= 生产装载器已装载 hologram/compaction）。 */
export function installCompactionForTest(): void {
  if (installed) return;
  installed = true;
  registerCompactionImplementation(compactionImplementation);
}
