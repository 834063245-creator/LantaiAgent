// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/builtin/ask-cards — ask / 权限提示卡第一方插件（批 9e-3，2026-09-26）。
//
// 原则二/三（插件化分层）：卡架是**产品形态**，经 `ctx.rootViews` 的 `'overlay'` 槽贡献
// （App 外壳渲染，槽空 = 零渲染）；**形状**（`PromptData` 三型 + `PromptShelfHandle` 五动词）
// 留内核契约 `app/chat/ask-card-contract.ts`——消费侧 `chat-core` 在内核，铁律禁内核 import 产物源码。
//
// 名册标 `required`（不可禁用）：卡架是权限/ask 的**唯一承接面**，缺席 = `showPermissionCard`
// 兜底拒绝（`chat-core.ts:438`）⇒ Agent 的所有写操作被静默否决（用户看不见原因）——
// 不是「少个 UI」，是链路断。同 paper-renderers / sessions-home 之理。

import type { Context } from '../../../cordis';
import { injectFaceArtifactCss } from '../face-css';
import { AskCardsHost } from './AskCardsHost';

/** ask / 权限提示卡插件——`rootViews` 的 'overlay' 槽贡献行。 */
export const askCardsPlugin = {
  name: 'hologram/ask-cards',
  inject: ['rootViews'],
  apply(ctx: Context) {
    injectFaceArtifactCss();
    ctx.effect(
      () =>
        ctx.rootViews.register({
          id: 'ask-cards',
          slot: 'overlay',
          component: AskCardsHost,
        }),
      'ask-cards',
    );
  },
};

/** 产物域 default 导出（WO-S0B 契约：pickPluginObject 取 default；缺此导出时位移装载会形状失败）。 */
export default askCardsPlugin;
