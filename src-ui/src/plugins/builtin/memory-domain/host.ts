// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// memory-domain 产物 · 宿主依赖面 · 开发/测试/编译域（批 9h-4，2026-09-26）。
//
// 记忆域实现（管理器 + 记忆工具四件 + 记忆束 HTTP 客户端）随包后仍要用内核的：
//   - `rpc-contract` 五值：`kernelCreateDirectory` / `kernelDeleteFile` / `kernelReadFile` /
//     `kernelReadMemoryBatch`（批量读记忆区）/ `kernelWriteFile`——记忆文件的全部 IO 走内核 RPC；
//   - `defineTool`（工具定义单一真源）+ `Tool` 类型；
//   - `consumeFactAuthorization`：**跨模块一次性授权旗标**（内核 `/remember` 授予、本包保存工具消费）
//     ——有状态的东西留内核，产物只取用（副本状态分裂是划词白屏那一族事故的根）；
//   - 形状面（`MemoryManagerFace` / `MemoryImplementation` / `MemorySavedInfo`）留内核契约
//     `agent/memory-contract.ts`。

export type { MemoryManagerFace, MemorySavedInfo } from '../../../agent/memory-contract';
export { consumeFactAuthorization } from '../../../agent/memory-impl';
export type { Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
export {
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelReadFile,
  kernelReadMemoryBatch,
  kernelWriteFile,
} from '../../../rpc-contract';
