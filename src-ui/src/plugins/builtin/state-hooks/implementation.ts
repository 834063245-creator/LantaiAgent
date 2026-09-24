// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state-hooks 实现对象（批 6c）：四个出厂 hook 工厂折成内核契约面
// `StateHooksImplementation`，由 index.ts 在 apply 期登记进 `agent/state-hooks-impl.ts`。

import { createBoardTrackingHook } from './board-tracking-hook';
import { createBuildResultHook, createStatePreflightHook, createStateReadHook } from './hook-factories';
import type { StateHooksImplementation } from './host';

export const stateHooksImplementation: StateHooksImplementation = {
  createStateReadHook,
  createStatePreflightHook,
  createBuildResultHook,
  createBoardTrackingHook,
};
