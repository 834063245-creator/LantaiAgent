// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 通信域实现对象（批 7b）：总线/存储工厂 + 两个工具族折成内核契约面
// `MultiagentCommImplementation`，由 index.ts 在 apply 期登记进 `agent/multiagent-impl.ts`。

import { createCommunicationTools } from './communication-tools';
import type { MessageStore, MessageTransport, MultiagentCommImplementation } from './host';
import { MessageBus } from './message-bus';
import { JsonMessageStore } from './message-store';
import { createRequestTool } from './request-tools';

export const multiagentCommImplementation: MultiagentCommImplementation = {
  createBus: (transport?: MessageTransport, store?: MessageStore) => new MessageBus(transport, store),
  createJsonStore: (projectPath: string) => new JsonMessageStore(projectPath),
  createCommunicationTools,
  createRequestTool,
};
