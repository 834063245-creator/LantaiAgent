// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// `/goal` 命令语法（2026-10-23，DSH `command-goal` 的解析器移植）。
//
// 纪律（与 DSH 逐条同规）：
//   - 控制词只在**整条输入**等于控制词时生效（`clear` / `pause` / `resume`）；
//   - `edit <objective>` 内联替换；单独的 `edit` = 无效（不猜）；
//   - 其余任何非空输入都是**目标原文**——`/goal pause after x` 创建该字面目标；
//   - 空输入 = 查看（show），由命令面渲染状态或用法。
//
// 纯函数（零依赖）：命令面只做执行，解析规则单点可测。

export type GoalCommand =
  | { kind: 'show' }
  | { kind: 'create'; objective: string }
  | { kind: 'edit'; objective: string }
  | { kind: 'invalid-edit' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' };

/** 解析 `/goal` 之后的原始参数文本（未 trim 由本函数负责）。 */
export function parseGoalCommand(rawInput: string): GoalCommand {
  const input = rawInput.trim();
  if (input.length === 0) return { kind: 'show' };
  switch (input.toLowerCase()) {
    case 'clear':
      return { kind: 'clear' };
    case 'pause':
      return { kind: 'pause' };
    case 'resume':
      return { kind: 'resume' };
    case 'edit':
      return { kind: 'invalid-edit' };
    default:
      break;
  }
  const edit = /^edit\s+([\s\S]+)$/i.exec(input);
  if (edit) return { kind: 'edit', objective: edit[1].trim() };
  return { kind: 'create', objective: input };
}
