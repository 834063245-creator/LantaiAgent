// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// multiagent-comm · 宿主依赖面 · 开发/测试域。
//
// 本包**不自持内核实现**：契约面（`agent/message-contract.ts`：消息类型 + 四个错误类 +
// `MessageBus` 接口）与登记表留内核；总线 / 存储 / 拓扑 / 两个工具族归本包。
// 内核依赖逐符号桥（读写文件腰、日志、平台 defineTool）。

export { log } from '../../../agent/logger';
export { errText } from '../../../agent/loop-helpers';
export type {
  AgentAddress,
  AgentMessage,
  BackpressureStrategy,
  MessageBus,
  MessageFilter,
  MessageStore,
  MessageTransport,
  MultiagentCommImplementation,
  TopologyPolicy,
} from '../../../agent/message-contract';
export {
  AgentNotFoundError,
  InboxFullError,
  MessageNotFoundError,
  TopologyDeniedError,
} from '../../../agent/message-contract';
export { registerMultiagentComm } from '../../../agent/multiagent-impl';
export type { Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
export {
  kernelCreateDirectory,
  kernelDeleteFile,
  kernelListDirectory,
  kernelReadFile,
  kernelWriteFile,
} from '../../../rpc-contract';
