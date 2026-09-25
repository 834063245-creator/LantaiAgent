// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// task-domain · 宿主依赖面（开发/测试域）——本包需要的**全部内核面**（逐符号 re-export）。
// 产物域由构建期重定向到 './host.aliased.ts'（宿主桥 mods.faceDeps 取真实例）。
//
// 两域形状必须一致（host.aliased.ts 以 `typeof import('./host')` 对拍）；
// host-modules 的 FaceBridgeSeal 要求本文件每个**值**导出都是 faceDeps 键
// （类型导出不计——它们编译期擦除）。
//
// 批 9h-5（2026-09-26）：本包整件归家后，桥面从「一个工具工厂」翻面为
// 「登记口 + 内核依赖面」——`registerTaskImplementation` 是**登记口**，
// 必须经本桥取用（直连内核模块路径会被 esbuild 内联成副本 ⇒ 登记落副本、实机炸，
// 见账本 §0.6 的 memory-domain 先例）。

// 内核共享面：面板持久化基础件（`discovery-board.ts` 与 `task-board.ts` 共用）——
// 有状态类，必须取内核真实例，不随包内联。
export { BoardPersistence } from '../../../agent/board-persistence';
export { parseIsolationDiff, spillToFile } from '../../../agent/spill';
export {
  clearTaskImplementation,
  createBoardStatusTool,
  createTaskTools,
  registerTaskImplementation,
} from '../../../agent/task-impl';
// 内核平台面：工具定义 + 溢写两函数（`parseIsolationDiff` 早在册；`spillToFile` 本批补键）
export { defineTool } from '../../../agent/tools/define-tool';
