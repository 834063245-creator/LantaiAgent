// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// plugins/space-demo-plugin — 画布空间 API 的第一方 demo 插件（Stage-2）。
//
// 用途：验证 `ctx.space` 打孔真的能用（stage-2 验收：「demo 插件经 ctx.space
// 读到画布状态」）。本插件不承担任何产品功能，只做三件事：
//   1. 命令「空间：画布状态」——读取 ctx.space.getState() 并通知状态栏；
//   2. 订阅空间状态变化——每次流区/活跃会话变化打一条 console 日志；
//   3. 不做任何 UI 面板（消费面留给阶段 3 书脊 / 阶段 4 目次带）。
//
// 这也是外部插件消费 ctx.space 的写法范本：inject 声明 'space'，apply 内
// 直读/直订阅，disposer 经 ctx.effect 登记（订阅退订随插件 fiber 清理）。

import type { Context } from '../cordis';

/** 格式化空间读面（命令反馈用——纯函数便于测试）。 */
export function formatSpaceState(state: {
  regions: Array<{ sessionId: string; label: string; anchorX: number; anchorY: number }>;
  activeSessionId: string | null;
}): string {
  if (state.regions.length === 0) return '画布空 · 无流区';
  const active = state.activeSessionId ?? '—';
  const lines = state.regions.map(
    (r) => `#${r.sessionId} ${r.label || '案卷'} @(${Math.round(r.anchorX)}, ${Math.round(r.anchorY)})`,
  );
  return `画布 ${state.regions.length} 个流区 · 活跃 ${active}\n${lines.join('\n')}`;
}

export const spaceDemoPlugin = {
  name: 'hologram/space-demo',
  inject: ['space', 'commands'],
  apply(ctx: Context) {
    // 订阅流区/活跃变化——console 打点即可（产品级消费面留后续阶段）
    ctx.effect(
      () =>
        ctx.space.subscribe(() => {
          console.info('[space-demo] 画布空间状态变化:', ctx.space.getState());
        }),
      'space-demo-subscribe',
    );

    // 命令：Ctrl+K 搜「空间」即可看到画布当前状态（插件消费 ctx.space 的证据）
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'space/demo-status',
          label: '空间：画布状态',
          group: '画布',
          shortcut: '/space',
          action: {
            type: 'local',
            handler: () => {
              const host = (globalThis as { __lantai_plugin_host__?: { notify?: (text: string) => void } })
                .__lantai_plugin_host__;
              const msg = formatSpaceState(ctx.space.getState());
              if (host?.notify) host.notify(msg);
              else console.info('[space-demo] 画布状态:', msg);
            },
          },
        }),
      'space-demo-command',
    );
  },
};
