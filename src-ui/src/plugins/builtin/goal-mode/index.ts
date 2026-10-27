// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal 模式插件 · 真源产物（2026-10-23 DSH goal 栈移植 P3 重写）。
//
// 形态：贡献 **goal 域工具行**（goal_get / goal_create / goal_update，模型面折叠为
// `goal(action=…)`）+（有 prompts 服务时）**目标策略 prompt 段**。目标状态与状态机
// 在内核 `agent/goal/`（会话日志事件溯源 + CAS + 进程本地 activation），不归产物。
//
// 为什么 inject 只声明 tools：提示段是**可选面**——生产装载器先装全部 service
// （含 prompts），here 取到就注册；tools 通道腰（测试/契约生成）没有 prompts
// 也不该为它改装配序 ⇒ `ctx.get('prompts', false)` 取用、缺席即跳过。
//
// 分类 = feature（可禁用）：禁用/未装载 ⇒ 模型没有目标工具；人在 `/goal` 命令面
// 的读写走内核服务，不受影响（命令面在 chat-core）。

import type { PromptSection } from '../../../composition/prompt-sections';
import type { ToolContribution } from '../../../composition/services';
import type { Context } from '../../../cordis';
import { goalTools } from './goal-tools';
import { GOAL_GUIDANCE } from './prompt';

const PLUGIN_NAME = 'hologram/goal-mode';

/** 每工具一条贡献行（id = `<插件名>/<工具名>`；goal 工具无装配期依赖，纯实例）。 */
function goalToolContributions(): ToolContribution[] {
  return goalTools().map((tool) => ({
    id: `${PLUGIN_NAME}/${tool.name()}`,
    factory: () => tool,
  }));
}

export const goalModePlugin = {
  name: 'hologram/goal-mode',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = goalToolContributions().map((c) => ctx.tools.register(c));
      // 可选面：prompts 服务在册才算（生产 = 内核 service 先于产物装载）。
      const prompts = ctx.get('prompts', false) as { register(section: PromptSection): () => void } | undefined;
      if (prompts) {
        disposers.push(
          prompts.register({
            id: 'goal',
            render: () => `\n\n## 目标模式（goal）\n${GOAL_GUIDANCE}`,
          }),
        );
      }
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'goal-mode');
  },
};

export default goalModePlugin;
