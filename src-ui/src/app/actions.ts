// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：应用级动作注册表 — 命令面板 / CommandBar / 全局快捷键的统一入口。
// 处理函数由壳行 actions（S2-4 自 main.ts 迁移）注入，React 侧只认 action id。
//
// S3（2026-08-22）：runAction 增加贡献翻译层 —— 静态注册 miss 后查
// ACTION_CONTRIBUTION_ALIASES，把既有动作 id 翻译为 ctx.commands 贡献 id，
// 经 activeCommandContributions() 折算执行（local 型 handler）。域插件行化后
// 动作从壳行迁入贡献（toggle-settings → settings/toggle 等），快捷键链路的
// 字面量（useGlobalKeys）保持字节级不变——桥接在分发面内部完成（设计件 §2.3）。

import { activeCommandContributions } from '../composition/services';

export interface AppAction {
  id: string;
  /** 命令面板分组标签（操作 / 面板 / 设置…） */
  group: string;
  label: string;
  /** ui/icons.ts 的图标名 */
  icon?: string;
  /** 快捷键展示文本（如 'ctrl D'） */
  kbd?: string;
  run: (arg?: string) => void;
}

const registry = new Map<string, AppAction>();

/** 既有动作 id → ctx.commands 贡献 id 的翻译表（S3 裁决 §2.3）。
 *  冻结常量表（CONVENTIONS §1.10 第 4 类）——条目随域行化增长，
 *  治理备忘见 S3 设计件 §7（别名表规模化后再系统化）。 */
export const ACTION_CONTRIBUTION_ALIASES: Record<string, string> = {
  'toggle-settings': 'settings/toggle',
  'toggle-paper': 'paper/toggle',
};

/** 注册一组动作；重复 id 后者覆盖前者（main.ts 重注入场景安全） */
export function registerActions(list: AppAction[]): void {
  for (const a of list) registry.set(a.id, a);
}

export function listActions(): AppAction[] {
  return [...registry.values()];
}

export function getAction(id: string): AppAction | undefined {
  return registry.get(id);
}

/** 执行动作；未注册（init 尚未注入）时静默忽略 — 启动早期的按钮点击安全。
 *  S3：静态注册 miss 后走贡献翻译层（别名 → ctx.commands 贡献 → local
 *  handler）。贡献缺席（装载期前/已卸载）同样静默——同一安全垫语义。 */
export function runAction(id: string, arg?: string): void {
  const action = registry.get(id);
  if (action) {
    action.run(arg);
    return;
  }
  const contributionId = ACTION_CONTRIBUTION_ALIASES[id];
  if (contributionId == null) return; // 无别名 = 真未注册，静默（启动早期安全）
  const contribution = activeCommandContributions().find((c) => c.id === contributionId);
  if (contribution == null) return; // 贡献缺席（服务未装载/已 dispose），同上静默
  if (contribution.action.type === 'local') {
    contribution.action.handler(arg ?? '');
    return;
  }
  // 非local 型贡献（send/fill/skill）需聊天面板承接——快捷键分发面只桥接
  // local 型（S3 两别名均为 local）；其他型显式可见，不静默吞。
  console.warn(`[actions] 别名 "${id}" 指向非 local 型贡献 "${contributionId}"，快捷键分发面不承接`);
}
