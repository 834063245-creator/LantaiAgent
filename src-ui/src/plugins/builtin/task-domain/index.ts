// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// task 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { createTaskTools } from './host';

const TASK_TOOL_NAMES = ['task_create', 'task_update', 'task_list', 'task_get', 'task_stop'];

/** task 域插件——TaskManager 必填依赖（原装配无条件注册）。 */
export const taskDomainPlugin = {
  name: 'hologram/task-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(
      ctx,
      'task-domain-tools',
      noCacheContributions('hologram/task-domain', (rowCtx) => createTaskTools(rowCtx.taskManager), TASK_TOOL_NAMES),
    );
  },
};

export default taskDomainPlugin;
