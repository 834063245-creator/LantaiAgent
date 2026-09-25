// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// memory 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。
//
// 批 9h-4（2026-09-26）：**实现整件随包**（`./memory` 管理器 + 四件工具 + `./memory-bundle-client`
// 记忆束客户端，原 `agent/memory.ts` / `agent/memory-bundle-client.ts`）——apply 期把实现登记进
// 内核登记表（`agent/memory-impl.ts`，service 语义：缺实现 fail-loud），内核 `workspace.ts` 不再
// `new MemoryManager`，改走门面 `createMemoryManager` / `memoryBundleIngest`。

import { clearMemoryImplementation, registerMemoryImplementation } from '../../../agent/memory-impl';
import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { createMemoryTools, MemoryManager } from './memory';
import { memoryBundleIngest } from './memory-bundle-client';

const MEMORY_TOOL_NAMES = [
  'hologram_memory_list',
  'hologram_memory_read',
  'hologram_memory_save',
  'hologram_memory_delete',
];

/** 记忆域实现面（登记项；与包内实现同源——`tests/setup.ts` 复现装载态用同一对象）。 */
export const memoryImplementation = {
  createManager: (projectPath: string, globalDir?: string) => new MemoryManager(projectPath, globalDir),
  bundleIngest: memoryBundleIngest,
};

/** memory 域插件——memoryManager 缺帐时空集（原 if 分支语义）。 */
export const memoryDomainPlugin = {
  name: 'hologram/memory-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    // 实现登记（service 语义）：随 fiber 生命周期对称撤销
    ctx.effect(() => {
      registerMemoryImplementation(memoryImplementation);
      return () => clearMemoryImplementation();
    }, 'memory-domain-implementation');
    registerFamily(
      ctx,
      'memory-domain-tools',
      noCacheContributions(
        'hologram/memory-domain',
        (rowCtx) => (rowCtx.memoryManager ? createMemoryTools(rowCtx.memoryManager) : []),
        MEMORY_TOOL_NAMES,
      ),
    );
  },
};

export default memoryDomainPlugin;
