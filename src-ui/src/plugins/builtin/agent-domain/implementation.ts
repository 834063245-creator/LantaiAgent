// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-domain 实现对象（批 7a）：三个工具工厂折成内核契约面 `SubAgentToolsImplementation`，
// 由 index.ts 在 apply 期登记进 `agent/subagent-tools-impl.ts`。

import type { SubAgentToolsImplementation } from './host';
import { createAgentKillTool, createAgentStatusTool, createSubAgentTool } from './subagent-tools';

export const subAgentToolsImplementation: SubAgentToolsImplementation = {
  createSubAgentTool,
  createAgentKillTool,
  createAgentStatusTool,
};
