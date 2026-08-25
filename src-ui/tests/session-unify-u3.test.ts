// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License: MIT.

// 会话统一 U3 验收钉（session-unify-plan §4 U3；Q2-A+B / Q3 最小方案拍板）：
//   ① 从全局目录摊开一卷 → 进视图 → 内容显示且既有卷不破（多卷并存）
//   ② 零目录卷原地摊开（无工作区上下文，纯内容层）
//   ③ 关闭卷 → 落盘写全局位（workspace 字段正确）→ 卷文件可读回（回目录可见）
// 视图边界（Q3 最小方案）：SpineRack = 当前工作区视图内开卷列表；全局目录
// （SessionsHome 单列表）= 唯一总入口；卡片排布/画布空间模型挂起不做。
// mock 模式沿用 chat-session.test.ts（mockRpc 归一化 + 路径键实现式 mock）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';

const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
      normalized[snakeKey] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

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
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
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

const GLOBAL = '/.lantai/sessions'; // _userSessionsDir 未解析时的兜底路径（测试态）

/** 实现式磁盘 mock：read/write/list 三路由 + 内存文件表。 */
function memDisk() {
  const files: Record<string, string> = {};
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((_cmd: string, payload: any) => {
    const { method, params } = payload;
    if (method === 'read_file_content') {
      const fp = params.file_path as string;
      if (fp in files) return Promise.resolve(files[fp]);
      return Promise.reject(new Error('文件不存在'));
    }
    if (method === 'write_file_content') {
      files[params.file_path as string] = params.content as string;
      return Promise.resolve('ok');
    }
    if (method === 'list_directory') return Promise.resolve(JSON.stringify([]));
    return Promise.resolve(null);
  });
  return files;
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
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
  useShellStore.setState({ projectPath: '' });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('会话统一 U3 — 全局目录摊开/关卷回目录（视图内开卷语义）', () => {
  it('① 从全局目录摊开跨工作区卷：内容显示且既有卷不破（多卷并存）', async () => {
    const files = memDisk();
    files[`${GLOBAL}/7.json`] = JSON.stringify({
      id: 7,
      label: '跨区卷',
      savedAt: '2026-08-24T00:00:00Z',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '跨区卷内容' },
      ],
      workspace: 'D:/ws-b',
    });

    const panel = new ChatCore();
    panel.setProjectPath('D:/ws-b'); // 续开路由已切到卷的工作区（SessionsHome onResume）
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
    expect(msgs7.some((m: any) => m.text === '跨区卷内容')).toBe(true);
  });

  it('② 零目录卷原地摊开（纯内容层，无工作区上下文）', async () => {
    memDisk()[`${GLOBAL}/5.json`] = JSON.stringify({
      id: 5,
      label: '零目录卷',
      savedAt: '2026-08-24T00:00:00Z',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '零目录卷内容' },
      ],
    });

    const panel = new ChatCore();
    panel.setProjectPath('');
    panel.setAgentFactory(storingFactory());

    await panel.loadSessionFromDisk('', 5);

    const msgs = msgStoreFor(panel.panelId, 5).getState().messages;
    expect(msgs.some((m: any) => m.text === '零目录卷内容')).toBe(true);
  });

  it('③ 关闭卷 → 落盘写全局位（workspace 字段正确）→ 卷文件可读回（回目录可见）', async () => {
    const files = memDisk();
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

    // 写目标 = 全局位（非项目旧目录）+ workspace 字段
    await new Promise((r) => setTimeout(r, 0)); // 写目标异步消解——排干微任务
    const write = Object.entries(files).find(([p]) => p.endsWith('/1.json'));
    expect(write?.[0]).toBe(`${GLOBAL}/1.json`);
    const parsed = JSON.parse(write![1]);
    expect(parsed.workspace).toBe('D:/ws-b');
    expect(parsed.messages.some((m: any) => m.content === '待合卷的内容')).toBe(true);

    // 回目录可见：全局位卷文件成立（list 层由 Rust user_sessions_list 测试钉住）
    expect(files[`${GLOBAL}/1.json`]).toBeTruthy();
  });
});
