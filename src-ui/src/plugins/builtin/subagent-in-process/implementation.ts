// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子代理运行时实现对象（批 7c-1）：merge 与 discovery 两个工具族折成内核契约面，
// 由 index.ts 在 apply 期登记进 `agent/subagent-runtime-impl.ts`。

import { createDiscoveryTools } from './discovery-tools';
import type { DiscoveryToolsImplementation, MergeToolsImplementation } from './host';
import { runCompileTest } from './merge-gate';
import { createMergeTool } from './merge-tools';

export const mergeToolsImplementation: MergeToolsImplementation = { createMergeTool, runCompileTest };
export const discoveryToolsImplementation: DiscoveryToolsImplementation = { createDiscoveryTools };
