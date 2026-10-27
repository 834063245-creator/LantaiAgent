// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// `/goal` 命令语法（DSH command-goal 同规）：控制词只认整条输入，其余 = 目标原文。

import { describe, expect, it } from 'vitest';
import { parseGoalCommand } from '../src/agent/goal/command';

describe('parseGoalCommand', () => {
  it('空输入 = 查看（不执行、不猜目标）', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'show' });
    expect(parseGoalCommand('   ')).toEqual({ kind: 'show' });
  });

  it('控制词只在整条输入等于控制词时生效', () => {
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('RESUME')).toEqual({ kind: 'resume' });
    expect(parseGoalCommand(' clear ')).toEqual({ kind: 'clear' });
  });

  it('带后缀的控制词是目标原文（不是子命令）', () => {
    expect(parseGoalCommand('pause after verification')).toEqual({
      kind: 'create',
      objective: 'pause after verification',
    });
  });

  it('edit 必须带目标；单独 edit = 无效', () => {
    expect(parseGoalCommand('edit')).toEqual({ kind: 'invalid-edit' });
    expect(parseGoalCommand('edit 修完门禁')).toEqual({ kind: 'edit', objective: '修完门禁' });
    expect(parseGoalCommand('EDIT   多行\n目标 ')).toEqual({ kind: 'edit', objective: '多行\n目标' });
  });

  it('其余输入 = 新目标（保留内部空白）', () => {
    expect(parseGoalCommand('把 文档 修好')).toEqual({ kind: 'create', objective: '把 文档 修好' });
    expect(parseGoalCommand('/goal 目标')).toEqual({ kind: 'create', objective: '/goal 目标' });
  });
});
