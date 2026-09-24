// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// office 域工具插件 · 真源产物（C 路，2026-09-13）——OfficeCLI 一等域工具。
//
// 形状与其它域产物一致（registerFamily + familyContributions，走 ctx.tools 贡献
// 通道）：装配序 = 名册 buildOrder；本族只有一条工具 `office`（动作枚举面）。
// 执行体经 process_cap 的 **office_exec** 动作受控 spawn（命令由强制层拼装 +
// OfficeTool 只审声明的目标文件 + 动词白名单；2026-09-15 R3 起不再走 shell seam），
// 详见 agent/tools/office.ts 头注 + docs/plans/office-cli-integration-plan.md §11.3。

import type { Context } from '../../../cordis';
import { familyContributions, registerFamily } from '../contribution-helpers';
import { createOfficeTools } from './office';

/** office 域插件——贡献 1 工具（`office`，12 动作）。 */
export const officeDomainPlugin = {
  name: 'hologram/office-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    registerFamily(ctx, 'office-domain-tools', familyContributions('hologram/office-domain', createOfficeTools));
  },
};

export default officeDomainPlugin;
