// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多 Agent 通信域插件 · 真源产物（批 7b，2026-09-24）。
//
// 形态说明：本产物**不贡献任何通道行**——它把通信域实现（总线 / JSON 存储 / 三种拓扑 /
// 通信与请求工具族）登记进内核登记表（`agent/multiagent-impl.ts`）：内核 `runtime.ts`
// 查表造会话级 bus/store，blueprint 的两条 capability（communication-tools / request-tool）
// 查表造工具面。契约面（消息类型 + 四个错误类 + `MessageBus` 接口）留内核。
//
// 分类 = service（不可禁用）：bus 是会话级基础设施，缺实现 = 装歪了。

import type { Context } from '../../../cordis';
import { registerMultiagentComm } from './host';
import { multiagentCommImplementation } from './implementation';

export const multiagentCommPlugin = {
  name: 'hologram/multiagent-comm',
  inject: [],
  apply(ctx: Context) {
    ctx.effect(() => registerMultiagentComm(multiagentCommImplementation), 'multiagent-comm');
  },
};

export default multiagentCommPlugin;
