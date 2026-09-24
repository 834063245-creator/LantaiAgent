// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩域插件 · 真源产物（批 6d-2，2026-09-24）。
//
// 形态说明：本产物**不贡献任何通道行**——它把压缩实现登记进内核登记表
// （`agent/compaction-impl.ts`），内核 `Agent` 的压缩方法与 `agent-builder` 的工具
// 注册查表取用。记账面（`agent/compaction-tracker.ts`：压缩账 + 卷级持久化）与契约面
// （`agent/compaction-contract.ts`：宿主接口 + 配置形状 + 摘要账形状 + 跨层常量）留内核。
//
// 分类 = service（不可禁用）：缺实现时调用点 fail-loud。

import type { Context } from '../../../cordis';
import { registerCompactionImplementation } from './host';
import { compactionImplementation } from './implementation';

export const compactionPlugin = {
  name: 'hologram/compaction',
  inject: [],
  apply(ctx: Context) {
    ctx.effect(() => registerCompactionImplementation(compactionImplementation), 'compaction');
  },
};

export default compactionPlugin;
