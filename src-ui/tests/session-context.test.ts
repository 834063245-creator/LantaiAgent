// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话上下文注册表 + 域参数预处理腰（tool-ergonomics design-1 rev2）钉面。
// 承重断言：
//   - per-owner 注册表生命周期（register/dispose/双 owner 隔离）；
//   - 纯路径解析只 join 不规范化（`..` 原样保留——穿越由 Rust 沙箱拒绝，腰不得洗白）；
//   - 域腰三规则：同义键归一 / 省缺填充 / 相对解析，仅 fs/git/search 着腰；
//   - Rust 契约零变化的前提：无 owner 上下文时参数原样透传（loudly 失败，不静默兜底）。

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearOwnerContextsForTest,
  isAbsolutePath,
  ownerContext,
  registerOwnerContext,
  resolveAgainstRoot,
} from '../src/agent/session-context';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';
import { createDomainTools, PATH_PARAM_DESC } from '../src/agent/tools/domains';

afterEach(() => {
  clearOwnerContextsForTest();
});

describe('session-context 注册表', () => {
  it('register → 可读；disposer → 删除；重复 dispose 幂等', () => {
    const dispose = registerOwnerContext('owner-a', 'D:\\proj-a');
    expect(ownerContext('owner-a')?.workspaceRoot).toBe('D:\\proj-a');
    dispose();
    dispose();
    expect(ownerContext('owner-a')).toBeUndefined();
  });

  it('双 owner 并行互不串场（双工作区隔离）', () => {
    registerOwnerContext('owner-a', 'D:\\proj-a');
    registerOwnerContext('owner-b', 'D:\\proj-b');
    expect(ownerContext('owner-a')?.workspaceRoot).toBe('D:\\proj-a');
    expect(ownerContext('owner-b')?.workspaceRoot).toBe('D:\\proj-b');
  });

  it('undefined/null owner → undefined（UI 直调路径结构性不消费）', () => {
    registerOwnerContext('owner-a', 'D:\\proj-a');
    expect(ownerContext(undefined)).toBeUndefined();
    expect(ownerContext(null)).toBeUndefined();
  });
});

describe('纯路径解析（只 join 不规范化）', () => {
  it('isAbsolutePath：盘符/UNC/根相对/相对', () => {
    expect(isAbsolutePath('D:\\proj\\x.ts')).toBe(true);
    expect(isAbsolutePath('D:/proj/x.ts')).toBe(true);
    expect(isAbsolutePath('\\\\srv\\share\\x')).toBe(true);
    expect(isAbsolutePath('/src/x.ts')).toBe(true);
    expect(isAbsolutePath('src/x.ts')).toBe(false);
    expect(isAbsolutePath('./src/x.ts')).toBe(false);
    expect(isAbsolutePath('../x.ts')).toBe(false);
  });

  it('resolveAgainstRoot：相对 join、分隔符跟随根、绝对透传、.. 原样保留', () => {
    expect(resolveAgainstRoot('D:\\proj', 'src/x.ts')).toBe('D:\\proj\\src\\x.ts');
    expect(resolveAgainstRoot('D:\\proj\\', 'src\\x.ts')).toBe('D:\\proj\\src\\x.ts');
    expect(resolveAgainstRoot('/home/u/proj', 'src\\x.ts')).toBe('/home/u/proj/src/x.ts');
    expect(resolveAgainstRoot('D:\\proj', 'D:\\other\\x.ts')).toBe('D:\\other\\x.ts');
    // `..` 原样保留——腰不洗白穿越序列
    expect(resolveAgainstRoot('D:\\proj', '../outside.txt')).toBe('D:\\proj\\..\\outside.txt');
  });
});

// ── 域参数预处理腰（仅 fs/git/search 着腰；graph 域已随图谱退役）──

interface CapturingStub extends Tool {
  lastArgs: Record<string, unknown> | undefined;
}

function stubTool(name: string, schema: Record<string, unknown>): CapturingStub {
  const t: CapturingStub = {
    name: () => name,
    description: () => name,
    parameters: () => schema,
    readOnly: () => false,
    lastArgs: undefined,
    execute: async (args) => {
      // 忠实模拟 defineTool 的 zod required 校验（缺必填 loudly 抛错）
      const required = (schema.required as string[] | undefined) ?? [];
      for (const req of required) {
        if (args[req] === undefined) throw new Error(`参数校验失败: ${req}: Required`);
      }
      t.lastArgs = { ...args };
      return 'ok';
    },
  };
  return t;
}

async function dispatch(domain: Tool, args: Record<string, unknown>): Promise<void> {
  await domain.execute(args);
}

describe('域参数预处理腰（fs/git/search 着腰）', () => {
  it('fs(read)：相对 path 归一为绝对 filePath（同义键 + 解析）', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    const read = stubTool('read_file_content', {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    });
    reg.register(read);
    const [fs] = createDomainTools(reg);
    await dispatch(fs, { action: 'read', path: 'src/x.ts', _owner_id: 'owner-1' });
    expect(read.lastArgs?.filePath).toBe('D:\\proj\\src\\x.ts');
    expect(read.lastArgs?.path).toBeUndefined();
  });

  it('fs(read)：旧键 filePath 照常命中（向后兼容）', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    const read = stubTool('read_file_content', {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    });
    reg.register(read);
    const [fs] = createDomainTools(reg);
    await dispatch(fs, { action: 'read', filePath: 'D:\\proj\\a.txt', _owner_id: 'owner-1' });
    expect(read.lastArgs?.filePath).toBe('D:\\proj\\a.txt');
  });

  it('git(status)：省缺 path 填充 workspace root（绝对路径直送 Rust）', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    const status = stubTool('git_status', {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    reg.register(status);
    const [git] = createDomainTools(reg);
    await dispatch(git, { action: 'status', _owner_id: 'owner-1' });
    expect(status.lastArgs?.path).toBe('D:\\proj');
  });

  it('search(content)：省缺 directory 填充 root；显式相对 directory 解析', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    const search = stubTool('search_content', {
      type: 'object',
      properties: { directory: { type: 'string' }, pattern: { type: 'string' } },
      required: ['directory', 'pattern'],
    });
    reg.register(search);
    const [searchTool] = createDomainTools(reg);
    await dispatch(searchTool, { action: 'content', pattern: 'x', _owner_id: 'owner-1' });
    expect(search.lastArgs?.directory).toBe('D:\\proj');
    await dispatch(searchTool, { action: 'content', pattern: 'x', directory: 'src', _owner_id: 'owner-1' });
    expect(search.lastArgs?.directory).toBe('D:\\proj\\src');
  });

  it('fs(move)：from/to 相对解析（宽族）', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    const move = stubTool('move_file', {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    });
    reg.register(move);
    const [fs] = createDomainTools(reg);
    await dispatch(fs, { action: 'move', from: 'a.txt', to: 'b.txt', _owner_id: 'owner-1' });
    expect(move.lastArgs?.from).toBe('D:\\proj\\a.txt');
    expect(move.lastArgs?.to).toBe('D:\\proj\\b.txt');
  });

  it('无 owner 上下文：原样透传（loudly 失败，不静默兜底）', async () => {
    const reg = new ToolRegistry();
    const read = stubTool('read_file_content', {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    });
    const status = stubTool('git_status', {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    reg.register(read);
    reg.register(status);
    const tools = createDomainTools(reg);
    const fs = tools.find((t) => t.name() === 'fs');
    const git = tools.find((t) => t.name() === 'git');
    await dispatch(fs, { action: 'read', path: 'src/x.ts' });
    expect(read.lastArgs?.filePath).toBe('src/x.ts');
    await expect(dispatch(git, { action: 'status' })).rejects.toThrow('参数校验失败');
    expect(status.lastArgs).toBeUndefined();
  });

  it('可见 schema：path 单键 + 共享描述；filePath/projectPath/directory 消失', () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    reg.register(
      stubTool('read_file_content', {
        type: 'object',
        properties: { filePath: { type: 'string', description: 'Absolute path to the file to read' } },
        required: ['filePath'],
      }),
    );
    reg.register(
      stubTool('git_status', {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the git repository root' } },
        required: ['path'],
      }),
    );
    const tools = createDomainTools(reg);
    const fs = tools.find((t) => t.name() === 'fs');
    const git = tools.find((t) => t.name() === 'git');
    const fsParams = fs?.parameters() as { properties: Record<string, { description?: string }> };
    expect(fsParams.properties.path?.description).toBe(PATH_PARAM_DESC);
    expect(fsParams.properties.filePath).toBeUndefined();
    expect(fsParams.properties.projectPath).toBeUndefined();
    const gitParams = git?.parameters() as { properties: Record<string, { description?: string }> };
    expect(gitParams.properties.path?.description).toBe(PATH_PARAM_DESC);
  });
});

describe('焦点态（design-2：fs 焦点文件 + desktop 粘性窗口）', () => {
  it('fs(read) 成功 → 设焦 + [file:] 回显；fs(edit) 省缺 → 焦点命中且焦点转移', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    const read = stubTool('read_file_content', {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    });
    const edit = stubTool('edit_file', {
      type: 'object',
      properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } },
      required: ['filePath', 'oldString', 'newString'],
    });
    reg.register(read);
    reg.register(edit);
    const fs = (createDomainTools(reg) as Tool[]).find((t) => t.name() === 'fs');
    const r1 = await fs?.execute({ action: 'read', path: 'src/a.ts', _owner_id: 'owner-1' });
    expect(r1).toBe('ok\n[file: D:\\proj\\src\\a.ts]');
    expect(ownerContext('owner-1')?.focusPath).toBe('D:\\proj\\src\\a.ts');
    const r2 = await fs?.execute({ action: 'edit', oldString: 'a', newString: 'b', _owner_id: 'owner-1' });
    expect(edit.lastArgs?.filePath).toBe('D:\\proj\\src\\a.ts');
    expect(r2).toBe('ok\n[file: D:\\proj\\src\\a.ts]');
  });

  it('fs(write) 省缺不被焦点填充（覆盖风险），但成功设焦', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    const write = stubTool('write_file', {
      type: 'object',
      properties: { filePath: { type: 'string' }, content: { type: 'string' } },
      required: ['filePath', 'content'],
    });
    reg.register(write);
    const fs = (createDomainTools(reg) as Tool[]).find((t) => t.name() === 'fs');
    await expect(fs?.execute({ action: 'write', content: 'x', _owner_id: 'owner-1' })).rejects.toThrow();
    expect(write.lastArgs).toBeUndefined();
    await fs?.execute({ action: 'write', path: 'src/new.ts', content: 'x', _owner_id: 'owner-1' });
    expect(ownerContext('owner-1')?.focusPath).toBe('D:\\proj\\src\\new.ts');
  });

  it('fs 焦点 fill 后派发失败 → 自愈清焦', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const reg = new ToolRegistry();
    const read = stubTool('read_file_content', {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    });
    const bad = stubTool('edit_file', {
      type: 'object',
      properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } },
      required: ['filePath', 'oldString', 'newString'],
    });
    bad.execute = async () => {
      throw new Error('文件不存在');
    };
    reg.register(read);
    reg.register(bad);
    const fs = (createDomainTools(reg) as Tool[]).find((t) => t.name() === 'fs');
    await fs?.execute({ action: 'read', path: 'src/a.ts', _owner_id: 'owner-1' });
    await expect(fs?.execute({ action: 'edit', oldString: 'a', newString: 'b', _owner_id: 'owner-1' })).rejects.toThrow(
      '文件不存在',
    );
    expect(ownerContext('owner-1')?.focusPath).toBeUndefined();
  });

  it('desktop：显式 hwnd 设焦；后续 uia_* 全省缺命中；显式定位刷新焦点', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const winSchema = {
      type: 'object',
      properties: { hwnd: { type: 'number' }, pid: { type: 'number' }, title: { type: 'string' } },
    };
    const reg = new ToolRegistry();
    const tree = stubTool('desktop_uia_tree', winSchema);
    const click = stubTool('desktop_uia_click', winSchema);
    reg.register(tree);
    reg.register(click);
    const desktop = (createDomainTools(reg) as Tool[]).find((t) => t.name() === 'desktop');
    await desktop?.execute({ action: 'uia_tree', hwnd: 123, _owner_id: 'owner-1' });
    expect(ownerContext('owner-1')?.focusWindow?.hwnd).toBe(123);
    await desktop?.execute({ action: 'uia_click', ref: 3, _owner_id: 'owner-1' });
    expect(click.lastArgs?.hwnd).toBe(123);
    // 显式换窗 → 焦点刷新（all-or-nothing：给了定位字段不补）
    await desktop?.execute({ action: 'uia_click', ref: 4, title: '别的窗', _owner_id: 'owner-1' });
    expect(click.lastArgs?.hwnd).toBeUndefined();
    expect(click.lastArgs?.title).toBe('别的窗');
    expect(ownerContext('owner-1')?.focusWindow?.title).toBe('别的窗');
  });

  it('desktop 粘性 fill 后派发失败 → 自愈清焦', async () => {
    registerOwnerContext('owner-1', 'D:\\proj');
    const winSchema = {
      type: 'object',
      properties: { hwnd: { type: 'number' }, pid: { type: 'number' }, title: { type: 'string' } },
    };
    const reg = new ToolRegistry();
    const tree = stubTool('desktop_uia_tree', winSchema);
    const click = stubTool('desktop_uia_click', winSchema);
    click.execute = async () => {
      throw new Error('无法定位窗口');
    };
    reg.register(tree);
    reg.register(click);
    const desktop = (createDomainTools(reg) as Tool[]).find((t) => t.name() === 'desktop');
    await desktop?.execute({ action: 'uia_tree', hwnd: 123, _owner_id: 'owner-1' });
    await expect(desktop?.execute({ action: 'uia_click', ref: 3, _owner_id: 'owner-1' })).rejects.toThrow(
      '无法定位窗口',
    );
    expect(ownerContext('owner-1')?.focusWindow).toBeUndefined();
  });
});
