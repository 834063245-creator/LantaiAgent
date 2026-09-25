// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// task 域工具插件 · 真源产物（S3，plugin-bundle-retirement；批 9h-5 整件归家）。
//
// 批 9h-5（2026-09-26）：`task.ts`（178）· `task-board.ts`（319）· `board-status.ts`（78）
// 三件实现随包 ⇒ 本包从「转发空壳」变实心。装载期做两件事：
//   ① **登记实现**（`registerTaskImplementation`，经包内宿主桥取内核登记口——
//      直连内核路径会被 esbuild 内联成副本，实机登记不生效，见账本 §0.6）；
//      disposer 经 `ctx.effect` 对称释放（`clearTaskImplementation`）。
//   ② 注册 task 域五件工具（`rowCtx.taskManager` = 内核装配层按卷造的实例，
//      由 `capability-segments` 的 task-tools capability 塞进 rowCtx）。

import type { Context } from '../../../cordis';
import { noCacheContributions, registerFamily } from '../contribution-helpers';
import { clearTaskImplementation, registerTaskImplementation } from './host';
import { taskImplementation } from './implementation';
import { createTaskTools } from './task';

const TASK_TOOL_NAMES = ['task_create', 'task_update', 'task_list', 'task_get', 'task_stop'];

/** task 域插件——TaskManager 必填依赖（原装配无条件注册）。 */
export const taskDomainPlugin = {
  name: 'hologram/task-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    // 登记口经宿主桥取（产物域 = faceDeps 真实例）；对称释放：fiber dispose ⇒ 撤销登记。
    ctx.effect(() => {
      registerTaskImplementation(taskImplementation);
      return () => clearTaskImplementation();
    }, 'task-domain-impl');
    registerFamily(
      ctx,
      'task-domain-tools',
      noCacheContributions('hologram/task-domain', (rowCtx) => createTaskTools(rowCtx.taskManager), TASK_TOOL_NAMES),
    );
  },
};

export { taskImplementation } from './implementation';
export default taskDomainPlugin;
