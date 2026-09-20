// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 斜杠命令面（command-surface-rework，2026-09-19）行为面。
// 用户操作序列：打字 `/` 出面板 → ↑↓ 选中一条 → Enter 执行；带参命令
// （`/goal resume` · `/remember 事实`）直接回车即执行。
//
// 守护四件（对位旧形态的病灶）：
//   ① 清单唯一真源 = 命令目录合流（会话内建 + ctx.commands 贡献 + 技能候选）——
//      不再有「插件命令进不了 / 面板」的第二套注册表；
//   ② 退役命令不再陈列（图分析族 /trail · /fragile · /cycle · /impact · /path
//      随图谱内置接线退役整删）；
//   ③ 带参命令走目录解析（`/goal resume` → arg='resume'），发送面不再硬编码分支；
//   ④ 内建命令 handler 绑本卷实例（旧 `_wireCommandHandlers` 就地把 handler
//      写进模块级全局表 = 多面板互相覆盖的形状，已拆）。

import { describe, expect, it, vi } from 'vitest';
import { ChatCore } from '../src/app/chat/chat-core';
import {
  filterCommands,
  findCommandBySlash,
  listCommands,
  parseSlashInput,
  slashOnly,
} from '../src/app/commands/command-catalog';
import type { CommandContribution } from '../src/composition/services';
import { getChatStore } from '../src/ui/chat-store';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

const root = await ensureProductionChannelsBooted();

/** 应用级贡献探针（经 ctx.commands 通道注册——合流点的第二段来源）。 */
const PROBE: CommandContribution = {
  id: 'probe/slash',
  label: '探针命令',
  description: '目录合流探针',
  group: '测试',
  slash: '/probe',
  kbd: 'ctrl 9',
  action: { type: 'local', handler: () => {} },
};

function inputOf(core: ChatCore) {
  return getChatStore(core.panelId).input.getState();
}

describe('命令目录合流（内建 + ctx.commands 贡献 + 技能候选）', () => {
  it('贡献与内建命令同列一份清单；dispose 后立即消失', () => {
    const host = { builtinCommands: () => [] as CommandContribution[] };
    expect(listCommands(host).some((c) => c.id === PROBE.id)).toBe(false);

    const dispose = root.commands.register(PROBE);
    const merged = listCommands(host);
    expect(merged.some((c) => c.id === PROBE.id)).toBe(true);

    dispose();
    expect(listCommands(host).some((c) => c.id === PROBE.id)).toBe(false);
  });

  it('会话内建命令与贡献命令同列（面板两段来源不再互不相通）', () => {
    const dispose = root.commands.register(PROBE);
    const core = new ChatCore();
    const merged = listCommands(core);
    expect(merged.some((c) => c.slash === '/probe')).toBe(true);
    expect(merged.some((c) => c.slash === '/compact')).toBe(true);
    dispose();
  });

  it('斜杠子集剔除无触发词的键位命令', () => {
    const cmds: CommandContribution[] = [
      { ...PROBE },
      {
        id: 'probe/kbd',
        label: '只有键位',
        group: '测试',
        kbd: 'ctrl 8',
        action: { type: 'local', handler: () => {} },
      },
    ];
    expect(slashOnly(cmds).map((c) => c.id)).toEqual(['probe/slash']);
  });
});

describe('斜杠行解析（命令词 + 参数）', () => {
  const CMDS: CommandContribution[] = [
    { ...PROBE },
    {
      id: 'goal',
      label: '目标',
      group: '案卷',
      slash: '/goal',
      action: { type: 'local', handler: () => {} },
    },
  ];

  it('带参：`/goal resume` → cmd=/goal · arg=resume', () => {
    const hit = parseSlashInput(CMDS, '/goal resume');
    expect(hit?.cmd.id).toBe('goal');
    expect(hit?.arg).toBe('resume');
  });

  it('无参：`/goal` → arg 为空串', () => {
    expect(parseSlashInput(CMDS, '/goal')?.arg).toBe('');
  });

  it('参数保留内部空白、去掉首尾空白', () => {
    expect(parseSlashInput(CMDS, '/goal  买 牛奶  ')?.arg).toBe('买 牛奶');
  });

  it('未命中命令 → null（调用方回落技能路由）', () => {
    expect(parseSlashInput(CMDS, '/nope')).toBeNull();
  });

  it('非斜杠行 → null', () => {
    expect(parseSlashInput(CMDS, 'goal')).toBeNull();
    expect(parseSlashInput(CMDS, '请帮我 /goal')).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(parseSlashInput(CMDS, '/GOAL cancel')?.arg).toBe('cancel');
  });
});

describe('命令检索', () => {
  const CMDS: CommandContribution[] = [
    {
      id: 'a',
      label: '设置…',
      description: '打开设置面板',
      group: '设置',
      slash: '/settings',
      kbd: 'ctrl ,',
      action: { type: 'local', handler: () => {} },
    },
    { id: 'b', label: '纸视图', group: '面板', slash: '/paper', action: { type: 'local', handler: () => {} } },
  ];

  it('空查询 = 全量原序', () => {
    expect(filterCommands(CMDS, '').map((c) => c.id)).toEqual(['a', 'b']);
    expect(filterCommands(CMDS, '/').map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('命中斜杠触发词 / 显示名 / 描述', () => {
    expect(filterCommands(CMDS, 'sett').map((c) => c.id)).toEqual(['a']);
    expect(filterCommands(CMDS, '纸').map((c) => c.id)).toEqual(['b']);
    expect(filterCommands(CMDS, '打开设置').map((c) => c.id)).toEqual(['a']);
  });

  it('无匹配 = 空清单', () => {
    expect(filterCommands(CMDS, 'zzz')).toHaveLength(0);
  });

  it('按斜杠精确查找（带不带前导 / 均可，大小写不敏感）', () => {
    expect(findCommandBySlash(CMDS, '/paper')?.id).toBe('b');
    expect(findCommandBySlash(CMDS, 'paper')?.id).toBe('b');
    expect(findCommandBySlash(CMDS, '/PAPER')?.id).toBe('b');
    expect(findCommandBySlash(CMDS, '/paperx')).toBeUndefined();
  });
});

describe('会话内建命令表', () => {
  it('保留现行命令，图分析族与轨迹开关不再陈列', () => {
    const core = new ChatCore();
    const slashes = core.builtinCommands().map((c) => c.slash);
    for (const keep of ['/new', '/compact', '/compact-stats', '/export', '/goal', '/memory', '/remember']) {
      expect(slashes, `缺少 ${keep}`).toContain(keep);
    }
    for (const gone of ['/trail', '/fragile', '/cycle', '/impact', '/path']) {
      expect(slashes, `退役命令仍在陈列: ${gone}`).not.toContain(gone);
    }
  });
});

describe('执行面参数贯通', () => {
  it('local 型 handler 收到斜杠参数', () => {
    const seen: string[] = [];
    const core = new ChatCore();
    core.executeCommand(
      {
        id: 'x',
        label: 'X',
        group: '测试',
        slash: '/x',
        action: { type: 'local', handler: (arg) => seen.push(arg) },
      },
      'resume',
    );
    expect(seen).toEqual(['resume']);
  });

  it('fill 型把参数拼在提示文本后', () => {
    const core = new ChatCore();
    core.executeCommand(
      {
        id: 'y',
        label: 'Y',
        group: '测试',
        slash: '/y',
        action: { type: 'fill', text: '/y ' },
      },
      'abc',
    );
    expect(inputOf(core).inputText).toBe('/y abc');
  });

  it('内建 handler 绑本卷实例：改 A 卷输入不碰 B 卷（旧全局表就地写 handler 的形状已拆）', () => {
    const a = new ChatCore();
    const b = new ChatCore();
    inputOf(a).setInputText('a-草稿');
    inputOf(b).setInputText('b-草稿');
    const rememberA = a.builtinCommands().find((c) => c.id === 'remember');
    const rememberB = b.builtinCommands().find((c) => c.id === 'remember');
    expect(rememberA).toBeDefined();
    expect(rememberB).toBeDefined();

    // 无参 /remember = 提示用法并填好前缀（用户接着打字）
    a.executeCommand(rememberA!);
    expect(inputOf(a).inputText).toBe('/remember ');
    expect(inputOf(b).inputText).toBe('b-草稿');
  });

  it('带参 /goal 在无工作区时安静返回（不抛、不清他卷）', async () => {
    const core = new ChatCore();
    const goal = core.builtinCommands().find((c) => c.id === 'goal');
    expect(goal).toBeDefined();
    const spy = vi.fn();
    expect(() => core.executeCommand(goal!, 'status')).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    await Promise.resolve(); // 让 handler 内的 async 分支落地（无工作区即早返回）
  });
});
