// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// bundled-engine — 随包图谱引擎接线产物（批 10 部件三，2026-09-26）。
//
// 归属：本包 = 引擎接线的**产品面**（声明构造 + MCP 受治进程挂载 + 三态回执）；探测与开关
// 留内核 `plugins/bundled-engine-prefs.ts`（设置面板要用，且是平台只读面/偏好）。
//
// 装配点（批 10 部件一）：本包在 apply 期经 `ctx.workspaces.onActivate` 登记——
// 工作区激活点按注册序串行回调，位置在**组合快照 / 注册表构建之前**（工具行必须先于装配
// 进注册表；这是 2026-09-24 实机缺陷①的教训）。离开/切换工作区 = 旧 fiber dispose ⇒
// `registerBundledEngineTools` 里挂 `scope.ctx.effect` 的子 fiber 随之摘行 + 治理器杀进程树
// （一进程一根、离开即停），**本包不需要写 teardown**。
//
// 回执：三态写 `useBundledEngineStore`（设置面板「随包图谱引擎」区块读）+ 状态栏一行
// ——判别口径 = **工具面真的在册**（wired ⟺ toolCount > 0），不是「行注册成功」。
//
// 类别 `feature`（可禁用）：禁用本产物 = 不登记接线贡献 = 引擎天然 kill switch
// （开关之外的又一层；用户在插件列表可关）。

import type { Context } from '../../../cordis';
import { useBundledEngineStore, useShellStore } from './host';
import { registerBundledEngineTools } from './wiring';

/** 随包图谱引擎接线插件（可禁用产物）。 */
export const bundledEnginePlugin = {
  name: 'hologram/bundled-engine',
  inject: ['workspaces'],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.workspaces.onActivate(async (scope) => {
          // 引擎接线：有界等待就绪（`wiring.ts` 内 PREHEAT_BUDGET_MS）——工具面在装配时点冻结，
          // 必须等它物化完再让调用方建注册表（2026-09-24 实机缺陷②）。
          const wiring = await registerBundledEngineTools(scope.ctx, scope.root);
          const report = useBundledEngineStore.getState().report;
          if (wiring.wired) {
            report({ status: 'wired', workspacePath: scope.root, toolCount: wiring.toolCount });
            console.log(`[Workspace] 随包图谱引擎已接线：${scope.root}（${wiring.toolCount ?? 0} 个工具在册）`);
            useShellStore.getState().pushStatus(`随包图谱引擎已接线（${wiring.toolCount ?? 0} 个工具）`);
          } else if (wiring.reason) {
            // 启用了但接不上 = 可见降级（不静默——错误不静默纪律）
            report({ status: 'failed', workspacePath: scope.root, reason: wiring.reason });
            console.warn('[Workspace] 随包图谱引擎未接线:', wiring.reason);
            useShellStore.getState().pushStatus(`⚠️ 随包图谱引擎未接线：${wiring.reason}`);
          } else {
            // 开关未启用 = 用户意图（不打扰；回执留给设置面板显示）
            report({ status: 'off', workspacePath: scope.root });
          }
        }),
      'bundled-engine-workspace-hook',
    );
  },
};

export default bundledEnginePlugin;
