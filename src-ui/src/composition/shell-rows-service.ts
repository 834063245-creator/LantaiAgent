// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition/shell-rows-service — 壳行贡献通道（§4-9，批 10 同窗，2026-09-26）。
//
// 病灶（总账 §4-9）：壳行表 `builtinShellRows()` 是**硬编码数组**（`composition/shell-rows.ts`）
// ⇒ 产物无法贡献 boot 期副作用，现存唯一实例 `shell-update-check`（27 行）只能永久留内核。
//
// 本面 = 那条缺口的落点：产物 apply 期 `ctx.shellRows.register({ id, boot })` 登记，
// `bootShell` 第 3 步按「**内置行（表序）→ 贡献行（注册序）**」逐行 await（设计件 §9.2）。
// 首消费者 `shell-update-check` 恰是今日**最后一行** ⇒ 追加语义**逐位复现**引导序（零行为漂移）。
//
// 语义（逐条可测）：
//   - **装载序前提**：`main.ts` 的 `loadBuiltinPlugins`（:49）早于 `bootShell()`（:78）
//     ⇒ 产物 apply 期登记的壳行来得及被收集；
//   - **行 id 约定**：`plugin/<贡献者命名空间>/<行 id>`（对齐工具行 `plugin/hologram/<pkg>/<name>`
//     先例）；id 由贡献者自带（boot 期日志与失败账按它具名）；
//   - **失败隔离**：单行 boot 抛错不阻断后续行（与内置行同款纪律，`bootShell` 既有 catch）；
//   - **生命周期**：登记经 `ctx.effect`（fiber dispose 即摘行）；行本身无 teardown
//     （与内置行同款：根 fiber 生命周期 = 应用生命周期）；
//   - **kill switch**：贡献者的产物可经插件禁用面整体关闭（apply 不跑 = 行不登记）；
//     **逐行 patch 寻址**（把贡献行并入组合 `shell` 域）是后续精化，本批不承诺；
//   - **缺服务**：无通道环境 = 空贡献面，引导序零行为变更。

import { type Context, Service } from '../cordis';
import type { ShellRefs } from '../shell/runtime';
import type { WorkspaceFlowDeps } from './shell-rows';

/** 一条贡献壳行（与内置 `ShellRow` 同形；id 由贡献者自带 `plugin/<ns>/<id>`）。 */
export interface ShellRowContribution {
  id: string;
  boot: (refs: ShellRefs, flowDeps?: WorkspaceFlowDeps) => void | Promise<void>;
}

/** ctx.shellRows —— 壳行贡献通道。 */
export class ShellRowsService extends Service {
  private _rows: ShellRowContribution[] = [];

  constructor(ctx: Context) {
    super(ctx, 'shellRows');
    setActiveShellRows(this);
  }

  /** 登记贡献壳行（注册序 = 引导序中的贡献段序）；返回 disposer（经 `ctx.effect` 持有）。 */
  register(row: ShellRowContribution): () => void {
    this._rows.push(row);
    return () => {
      const i = this._rows.indexOf(row);
      if (i >= 0) this._rows.splice(i, 1);
    };
  }

  /** 当前贡献行（注册序——`bootShell` 追加在内置行之后）。 */
  list(): ShellRowContribution[] {
    return [...this._rows];
  }
}

// ── 活动服务读取面（同 root-views-service：模块级单例）──

let _active: ShellRowsService | null = null;

function setActiveShellRows(svc: ShellRowsService): void {
  _active = svc;
}

/** 当前服务（无服务 = null——诊断/测试面读用）。 */
export function activeShellRowsService(): ShellRowsService | null {
  return _active;
}

/** 测试复位（生产不调用）。 */
export function resetShellRowsForTests(): void {
  _active = null;
}

/** 引导期读取面：**无服务 = 空集**（工具/单测环境零行为变更）。 */
export function activeShellRows(): ShellRowContribution[] {
  return _active?.list() ?? [];
}

// ── ctx 通道声明 ──

declare module '../cordis/context' {
  interface Context {
    /** 壳行贡献通道（§4-9）：产物 apply 期 `register({ id, boot })` 登记，
     *  `bootShell` 在内置行之后按注册序执行。 */
    shellRows: ShellRowsService;
  }
}

/** 挂载插件（`plugins/service-plugins.ts` 表序末位）。 */
export const shellRowsServicePlugin = {
  name: 'hologram/composition-shell-rows',
  apply(ctx: Context) {
    new ShellRowsService(ctx);
  },
};
