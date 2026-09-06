// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License: MIT.

// 会话统一 U3 验收钉 → workspace-session-ownership-rework（2026-08-27）重写：
//   · ① 同工作区多卷并存（既有卷 + 续开卷，同一工作区会话根）
//   · ③ 关闭卷 → 落盘写工作区会话根（无 workspace 字段）→ 卷文件可读回
//   · ② 零目录卷/跨工作区开卷已退役（D2/D5：会话只在所属工作区内打开）
// mock 模式沿用 chat-session.test.ts（mockRpc 归一化 + 路径键实现式 mock）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';

// fs 域收口（2026-09-04）：会话卷 I/O 经 kernelReadFileRaw/kernelWriteFile/
// kernelListDirectory（rpc-contract 具名 helper，内部直呼 fs_cap）——mock 站
// 到 helper 层（不再拦 bridge + legacyDispatchShim 翻信封）。内存盘 = 共享
// kernel-fs mock 的 MockFs 实例。

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  const createNoopTween = () => ({
    kill: () => {},
    play: () => {},
    pause: () => {},
    resume: () => {},
    restart: () => {},
    seek: () => {},
    // biome-ignore lint/suspicious/noThenProperty: GSAP tween 接口形状（thenable mock）
    then: () => {},
    eventCallback: () => {},
    timeScale: () => {},
    progress: () => {},
    totalProgress: () => {},
  });
  const gsap = {
    set: vi.fn(),
    to: vi.fn(createNoopTween),
    from: vi.fn(createNoopTween),
    fromTo: vi.fn(createNoopTween),
    killTweensOf: vi.fn(),
    isTweening: vi.fn(() => false),
    utils: { toArray: vi.fn(() => []) },
  };
  return { default: gsap, gsap };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { ChatCore } from '../src/app/chat/chat-core';
import * as Session from '../src/ui/chat-session';
import { msgStoreFor } from '../src/ui/chat-store';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

// 会话持久化 seam 装配（seam 接线 C 批 3）：卷 CRUD 已换轨 sessionExecute——
// builtin provider 需在册（走 kernel-fs mock 内存盘）。
await ensureProductionChannelsBooted();

/** 内存盘 = 共享 kernel-fs mock 的 MockFs（read/write/list 由 helper 覆写
 *  承载；文件表经 setFile 预置 / files.entries 读回）。 */
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

function storingFactory() {
  let agentSession: any[] = [{ role: 'system', content: 'sys' }];
  return async () => ({
    getSession: () => agentSession,
    setSession: (msgs: any[]) => {
      agentSession = msgs;
    },
    dispose: vi.fn(),
    bindSession: vi.fn(),
  });
}

beforeEach(() => {
  localStorage.clear();
  memDisk();
  useShellStore.setState({ projectPath: '' });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('同工作区多卷语义（workspace-session-ownership-rework 重写）', () => {
  it('① 同工作区多卷并存：既有卷 1 + 续开卷 7（同一工作区会话根）', async () => {
    const fs = memDisk();
    fs.setFile(
      'D:/ws-b/.lantai/sessions/7.json',
      JSON.stringify({
        id: 7,
        label: '本区卷',
        savedAt: '2026-08-24T00:00:00Z',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '本区卷内容' },
        ],
      }),
    );

    const panel = new ChatCore();
    panel.setProjectPath('D:/ws-b');
    // DSH 形态：既有卷经工厂现造（带内容——多卷并存场景的卷 1）；
    // loadSessionFromDisk 再造的句柄用 storingFactory 语义（setSession 真存——
    // 渲染重建依赖 agent.getSession() 读回 conv）。
    let firstCall = true;
    panel.setAgentFactory(async () => {
      if (firstCall) {
        firstCall = false;
        return {
          getSession: () => [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '本区既有卷' },
          ],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
          cascadeAbort: vi.fn(),
        } as any;
      }
      return storingFactory()();
    });
    await panel.createNewSession(); // 卷 1（既有卷语义）

    await panel.loadSessionFromDisk('D:/ws-b', 7);

    // 多卷并存：卷 1 仍在，卷 7 摊开为活跃且内容显示
    const sess = Session.getSessions(panel.panelId);
    expect(sess.map((s) => s.id)).toEqual([1, 7]);
    const st = (await import('../src/ui/chat-store')).getChatStore(panel.panelId).sess.getState();
    expect(st.sessions[st.activeIdx]?.id).toBe(7);
    const msgs7 = msgStoreFor(panel.panelId, 7).getState().messages;
    expect(msgs7.some((m: any) => m.text === '本区卷内容')).toBe(true);
  });

  it('③ 关闭卷 → 落盘写工作区会话根（无 workspace 字段）→ 卷文件可读回', async () => {
    const fs = memDisk();
    const panel = new ChatCore();
    panel.setProjectPath('D:/ws-b');
    // DSH 形态：工厂现造带内容的句柄（合卷自动存的快照源）
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [
            { role: 'system', content: 'sys' },
            { role: 'user', content: '待合卷的内容' },
          ],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
          cascadeAbort: vi.fn(),
        }) as any,
    );
    await panel.createNewSession(); // 卷 1（工厂现造，带内容）
    await panel.createNewSession(); // 两卷现场，卷 1 可合

    panel.closeSession(0); // 合卷 1（C8 自动存）

    // 写目标 = 工作区会话根（归属 = 存储位置，无 workspace 字段）
    await new Promise((r) => setTimeout(r, 0)); // 写目标异步消解——排干微任务
    const write = [...fs.files.entries()].find(([p]) => p.endsWith('/1.json'));
    expect(write?.[0]).toBe('D:/ws-b/.lantai/sessions/1.json');
    const parsed = JSON.parse(write![1]);
    expect(parsed).not.toHaveProperty('workspace'); // 归属 = 存储位置，无字段标签
    expect(parsed.messages.some((m: any) => m.content === '待合卷的内容')).toBe(true);

    // 回目录可见：工作区会话根卷文件成立（list 层由本工作区扫描承担）
    expect(fs.files.get('D:/ws-b/.lantai/sessions/1.json')).toBeTruthy();
  });
});
