// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// tool-receipts — 产出型工具的**成功回执**读数（2026-09-16 反馈回路审计）。
//
// 缘起：`show_asset(kind=table)` 真机事故（同一张表连发 4 次、4 次全成功、聊天里
// 4 张重复卡）的根因不是生成代码，而是回执给不出"存进去的是什么"。同批审计把
// 这条纪律（§2.7「报错即导航」的**成功面对偶**）补到其余轻症族：
//   · task_create  —— 补 count（重发在计数上显形，create 无幂等）
//   · fs(write)    —— 补入参行数/字符数 + 点名回读入口（此前只回 {path}）
//   · git(stage/discard) —— 成功无 stdout：不再回空串，给可导航回执
// 判据统一：回执里必须有**模型没说过的量**或**明确的回读入口**，且不许把"未知"
// 说成成功（也不许说成失败）。

import { describe, expect, it } from 'vitest';
import { createTaskTools, TaskManager } from '../src/agent/task';
import type { ToolExecutor } from '../src/agent/tool';
import { createFsTools } from '../src/agent/tools/coding';
import { createGitTools } from '../src/plugins/builtin/git-domain/git-tools';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

function toolOf<T extends { name(): string }>(tools: T[], name: string): T {
  const t = tools.find((x) => x.name() === name);
  if (!t) throw new Error(`工具缺失: ${name}`);
  return t;
}

describe('成功回执读数（产出型工具）', () => {
  it('task_create：回执带 count（库里总数）——重发会在计数上显形', async () => {
    const mgr = new TaskManager();
    const create = toolOf(createTaskTools(mgr), 'task_create');
    const first = JSON.parse(await create.execute({ title: '写计划', detail: '一句话' })) as {
      id: number;
      status: string;
      count: number;
    };
    expect(first.id).toBe(1);
    expect(first.status).toBe('pending');
    expect(first.count).toBe(1);
    // 同参数重发（"怀疑就重发"的形态）：新 id + count 变化 = 重复件立刻可见
    const second = JSON.parse(await create.execute({ title: '写计划', detail: '一句话' })) as {
      id: number;
      count: number;
    };
    expect(second.id).not.toBe(first.id);
    expect(second.count).toBe(2);
  });

  it('fs(write)：回执带入参读数（行数/字符数）并点名回读入口', async () => {
    await ensureProductionChannelsBooted();
    const spyExec: ToolExecutor = async (name, args) => {
      if (name === 'fs_cap' && (args as { action?: string }).action === 'write') return '{"path":"/x/a.ts"}';
      return 'ok';
    };
    const write = toolOf(createFsTools(spyExec), 'write_file');
    const out = await write.execute({ filePath: '/x/a.ts', content: 'hello\nworld' });
    expect(out).toContain('{"path":"/x/a.ts"}'); // 能力口原文照旧保留
    expect(out).toContain('本次入参 2 行 / 11 字符');
    expect(out).toContain('/x/a.ts');
    expect(out).toContain('fs(read)'); // 回读入口点名（入参读数 ≠ 盘上真相）
  });

  it('git(stage)：成功无 stdout 时给可导航回执，不再是空串', async () => {
    const empty: ToolExecutor = async () => '';
    const stage = toolOf(createGitTools(empty), 'git_stage');
    const out = await stage.execute({ files: 'a.ts,b.ts' });
    expect(out.trim()).not.toBe('');
    expect(out).toContain('暂存区已按 files 更新');
    expect(out).toContain('git(status)');
  });

  it('git(stage 全量)："." 走 git_stage_all 且同享可导航回执', async () => {
    const seen: string[] = [];
    const exec: ToolExecutor = async (_name, args) => {
      seen.push(String((args as { action?: string }).action));
      return '';
    };
    const stage = toolOf(createGitTools(exec), 'git_stage');
    const out = await stage.execute({ files: '.' });
    expect(seen).toEqual(['git_stage_all']);
    expect(out).toContain('git(status)');
  });

  it('git：有 stdout 时原样直通（不包话术）', async () => {
    const exec: ToolExecutor = async () => 'Switched to branch main';
    const discard = toolOf(createGitTools(exec), 'git_discard');
    expect(await discard.execute({ file: 'a.ts' })).toBe('Switched to branch main');
    const stage = toolOf(createGitTools(exec), 'git_stage');
    expect(await stage.execute({ files: 'a.ts' })).toBe('Switched to branch main');
  });
});
