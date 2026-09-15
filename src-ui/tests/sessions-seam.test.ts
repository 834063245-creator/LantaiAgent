// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话持久化 seam 守护（平台化 Phase 2 · D11，2026-08-27；动作面重设计
// session-persistence-seam-wiring-plan C 定案，2026-09-05）：
//   ① 裸路径（无装配）→ SESSION_PERSISTENCE_PROVIDER 响亮报错（显式降级）
//   ② 动作面钉：四动作会话语义（read_volume/list_volumes/save_volume/
//      delete_volume——SESSION_PERSIST_ACTIONS 单一真源；旧六动作退役）
//   ③ fake provider 端到端（注册 → sessionExecute 路由过它 → dispose 回落）——
//      「插件注册 SessionPersistenceProvider 即接管产品会话持久化」的可执行证明
//   ④ default provider（builtin/rust-sessions）对 kernel-fs 内存盘 roundtrip——
//      D-3 实证：默认 provider 走 kernel* 具名 helper（测试 mock 面零迁移面）
//
// 注（2026-09-05 seam 接线 C 竣工销账）：旧头注「seam 骨架的拆除与否另行立案」
// 的立案随 C 定案闭环——承诺做实（消费面 = chat-session/chat-core 产品会话卷
// 持久化，全链经本 seam），seam 骨架保留并成为产品会话存储的可替换边界。
//
// 用例次序：① 必须先于任何 ensureProductionChannelsBooted() 调用。

import { describe, expect, it, vi } from 'vitest';
import type { SessionPersistenceProvider } from '../src/composition/session-persistence-service';
import { SESSION_PERSIST_ACTIONS, sessionExecute } from '../src/composition/session-persistence-service';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

// sessions-builtin/index.ts 经 './host'（直连 rpc-contract 真源）取 kernel* helper
// ——上面 vi.mock 已覆写 rpc-contract，provider 走的就是内存盘实现。
import { builtinSessionsProvider } from '../src/plugins/builtin/sessions-builtin';

function memDisk() {
  const k = H.kernelFs;
  if (!k) throw new Error('kernelFs mock 未就绪（vi.mock 工厂未执行）');
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.lists.length = 0;
  k.fs.fail = {};
  return k.fs;
}

/** 内存会话仓 fake provider（③ 端到端用——自管存储，不经 kernel* helper）。 */
function fakeSessionProvider(calls: string[]): SessionPersistenceProvider {
  const vols = new Map<string, { json: string; deleted?: boolean }>();
  return {
    id: 'test/memory-sessions',
    async execute(action, args) {
      calls.push(action);
      const root = String(args.root ?? '');
      const id = String(args.id ?? '');
      if (action === 'save_volume') {
        vols.set(`${root}/${id}.json`, { json: String(args.data ?? '') });
        return 'null';
      }
      if (action === 'read_volume') {
        const v = vols.get(`${root}/${id}.json`);
        if (!v || v.deleted) return 'null';
        return v.json;
      }
      if (action === 'list_volumes') {
        return JSON.stringify(
          [...vols.keys()]
            .filter((p) => p.startsWith(root + '/') && !vols.get(p)?.deleted)
            .map((p) => p.slice(root.length + 1)),
        );
      }
      if (action === 'delete_volume') {
        const v = vols.get(`${root}/${id}.json`);
        if (v) v.deleted = true;
        return 'null';
      }
      return '(memory-sessions)';
    },
  };
}

describe('sessionPersistence seam（D11 · C 动作面重设计）', () => {
  it('① 裸路径：无装配 → SESSION_PERSISTENCE_PROVIDER 响亮报错', async () => {
    await expect(sessionExecute('read_volume', { root: '/x', id: '1' })).rejects.toThrow(
      /SESSION_PERSISTENCE_PROVIDER/,
    );
  });

  it('② 动作面钉：会话语义八动作（快照四 + 事件日志四；SESSION_PERSIST_ACTIONS 单一真源）', () => {
    expect([...SESSION_PERSIST_ACTIONS]).toEqual([
      'read_volume',
      'list_volumes',
      'save_volume',
      'delete_volume',
      // 事件日志四动作（Phase 1 换轨，2026-09-15 DSH 参照移植）：读/物化/追加(durable)/截断
      'read_log',
      'write_log',
      'append_events',
      'truncate_log',
    ]);
    expect(Object.keys(builtinSessionsProvider)).toEqual(['id', 'execute']);
    expect(builtinSessionsProvider.id).toBe('builtin/rust-sessions');
  });

  it('③ fake provider 端到端：注册 → sessionExecute 路由过它 → dispose 回落', async () => {
    const root = '/ws/.lantai/sessions';
    // 直接注册到服务实例（不 boot composition——单 seam 语义，无通道依赖）
    const { SessionPersistenceService } = await import('../src/composition/session-persistence-service');
    const { Context } = await import('../src/cordis');
    const ctx = new Context();
    const svc = new SessionPersistenceService(ctx);
    const calls: string[] = [];
    const dispose = svc.register(fakeSessionProvider(calls));

    const saveOut = await sessionExecute('save_volume', { root, id: '7', data: '{"id":7,"label":"x"}' });
    expect(saveOut).toBe('null');
    const readOut = await sessionExecute('read_volume', { root, id: '7' });
    expect(readOut).toBe('{"id":7,"label":"x"}');
    const listOut = await sessionExecute('list_volumes', { root });
    expect(JSON.parse(listOut)).toEqual(['7.json']);
    const delOut = await sessionExecute('delete_volume', { root, id: '7' });
    expect(delOut).toBe('null');
    // 墓碑后 read 回落 null（消费方判空语义）
    expect(await sessionExecute('read_volume', { root, id: '7' })).toBe('null');
    expect(calls).toEqual(['save_volume', 'read_volume', 'list_volumes', 'delete_volume', 'read_volume']);

    dispose();
    // 回落：无 provider → 响亮报错（fake 消失后不再路由）
    await expect(sessionExecute('read_volume', { root, id: '7' })).rejects.toThrow(/SESSION_PERSISTENCE_PROVIDER/);
  });

  it('④ default provider 对 kernel-fs 内存盘 roundtrip（D-3 实证）', async () => {
    memDisk();
    const root = '/ws/.lantai/sessions';
    // save → 落盘（内存盘 files 表可断言——provider 走 kernelWriteFile helper）
    const saveOut = await builtinSessionsProvider.execute('save_volume', {
      root,
      id: '3',
      data: '{"id":3,"label":"案卷","messages":[]}',
    });
    expect(saveOut).toBe('null');
    expect(H.kernelFs?.fs.files.get(`${root}/3.json`)).toBe('{"id":3,"label":"案卷","messages":[]}');

    // read → 原路回读
    const readOut = await builtinSessionsProvider.execute('read_volume', { root, id: '3' });
    expect(readOut).toBe('{"id":3,"label":"案卷","messages":[]}');
    // 缺失卷 → 'null'（判空语义）
    expect(await builtinSessionsProvider.execute('read_volume', { root, id: '99' })).toBe('null');

    // list → 文件名 JSON 数组（含 _active.json 不过滤——消费方语义）
    H.kernelFs?.fs.setFile(`${root}/_active.json`, '{}');
    H.kernelFs?.fs.setFile(`${root}/not-a-session.txt`, 'x');
    const listOut = await builtinSessionsProvider.execute('list_volumes', { root });
    expect(JSON.parse(listOut)).toEqual(['_active.json', '3.json', 'not-a-session.txt']);

    // delete → 墓碑重写（deleted:true——消费方过滤契约形态）
    const delOut = await builtinSessionsProvider.execute('delete_volume', { root, id: '3' });
    expect(delOut).toBe('null');
    const tomb = JSON.parse(H.kernelFs?.fs.files.get(`${root}/3.json`) ?? 'null');
    expect(tomb).toMatchObject({ id: 3, deleted: true });
  });
});
