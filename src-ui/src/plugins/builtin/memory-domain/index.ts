// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// memory 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { createMemoryTools } from './host';

const MEMORY_TOOL_NAMES = [
  'hologram_memory_list',
  'hologram_memory_read',
  'hologram_memory_save',
  'hologram_memory_delete',
];

/** memory 域插件——memoryManager 缺帐时空集（原 if 分支语义）。 */
export const memoryDomainPlugin = {
  name: 'hologram/memory-domain',
  inject: ['tools'],
  apply(ctx: Context) {
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
