// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 出厂斜杠命令清单（2026-11-12 自 app/chat/chat-core 搬出）。
//
// 这里只有**数据**：id / 展示文案 / 分组 / 斜杠词 / 动作。真执行面是
// chat-core.executeCommand（'local' 走本表 handler，'send' 走 agent 轮），
// 合流点 = app/commands/command-catalog 的 listCommands（出厂 + 插件贡献 + 技能）。
//
// 为什么把 handler 写成注入而非 this 方法：命令表是「出厂产品的清单」，
// 增删命令不该动编排类；注入面只有它真正用得上的五个能力位。

import type { CommandContribution } from '../../composition/services';

/** 出厂命令用到的主机能力位（多一个都不要）。 */
export interface BuiltinCommandHost {
  newVolume: () => void;
  compact: () => void;
  exportVolume: () => void;
  goal: (arg: string) => void;
  remember: (arg: string) => void;
}

export function builtinCommands(host: BuiltinCommandHost): CommandContribution[] {
  return [
    {
      id: 'new',
      label: '重置当前案卷',
      description: '清空对话历史，保留项目上下文',
      group: '案卷',
      slash: '/new',
      action: { type: 'local', handler: () => host.newVolume() },
    },
    {
      id: 'compact',
      label: '压缩上下文',
      description: '压缩对话历史以节省 token',
      group: '案卷',
      slash: '/compact',
      action: { type: 'local', handler: () => host.compact() },
    },
    {
      id: 'compact-stats',
      label: '压缩统计',
      description: '查看上下文压缩的运行数据',
      group: '案卷',
      slash: '/compact-stats',
      action: {
        type: 'send',
        text: '查看上下文压缩的运行状态和数据（使用 hologram_compaction_stats 工具）。',
        displayLabel: '/compact-stats',
      },
    },
    {
      id: 'export',
      label: '导出对话',
      description: '导出当前案卷为 Markdown',
      group: '案卷',
      slash: '/export',
      action: { type: 'local', handler: () => host.exportVolume() },
    },
    {
      id: 'goal',
      label: '自主目标',
      description: '自主目标 —— 发 /goal 目标描述 开始；裸 /goal 查看状态；pause · resume · clear 控制',
      group: '案卷',
      slash: '/goal',
      takesArg: true,
      action: { type: 'local', handler: (arg) => host.goal(arg) },
    },
    {
      id: 'memory',
      label: '查看记忆',
      description: '列出所有已保存的记忆',
      group: '记忆',
      slash: '/memory',
      action: {
        type: 'send',
        text: '列出所有已保存的记忆（使用 memory 工具 action="list"）。',
        displayLabel: '/memory',
      },
    },
    {
      id: 'remember',
      label: '记住一件事',
      description: '保存一条事实到记忆库',
      group: '记忆',
      slash: '/remember',
      takesArg: true,
      action: { type: 'local', handler: (arg) => host.remember(arg) },
    },
  ];
}
