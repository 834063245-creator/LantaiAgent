// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 「配置 provider 后恒提示『当前没有活跃会话』」死路的端到端形态守护
// （Phase B/C，2026-08-24 工作区归属根治）。钉住 DSH 形态的核心契约：
//   ① 无 Key 冷启动 → 历史案卷从磁盘照常恢复显示（恢复不依赖工厂/装配）
//   ② 缺 Key 的表现 = 明确的可见提示（拟文时补建失败 warn），不是会话消失
//   ③ 配置 Key 后（工厂可用）→ 不重启，同一面板直接发送成功
// workspace-session-ownership-rework（2026-08-27）：会话物理归属工作区——
// 历史卷存于 {workspace}/.lantai/sessions/（零目录路由已退役），本测试改在
// 真实工作区路径上复现同一契约。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useShellStore } from '../src/app/shell-store';
import { useToastStore } from '../src/state/toast-store';
import { logText } from './helpers/session-files';

// fs 域收口（2026-09-04）：会话恢复 I/O 经 kernelListDirectory/kernelReadFileRaw
// （rpc-contract 具名 helper，内部直呼 fs_cap）——mock 站到 helper 层（不再
// 拦 bridge + legacyDispatchShim 翻信封）。工作区会话根卷预置进共享内存 fs。

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
  restoreSecrets: vi.fn((s: unknown) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  // biome-ignore lint/suspicious/noThenProperty: GSAP tween 接口形状（thenable mock）
  const createNoopTween = () => ({ kill: () => {}, then: () => {}, play: () => {}, pause: () => {} });
  const gsap = {
    set: vi.fn(),
    to: vi.fn(createNoopTween),
    from: vi.fn(createNoopTween),
    fromTo: vi.fn(createNoopTween),
  };
  return { default: gsap, gsap };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { ChatCore } from '../src/app/chat/chat-core';
import * as Session from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

// 会话持久化 seam 装配（seam 接线 C 批 3）：卷 CRUD 已换轨 sessionExecute——
// builtin provider 需在册（走 kernel-fs mock 内存盘）。
await ensureProductionChannelsBooted();

/** 工作区 + 其会话根（workspace-session-ownership-rework 唯一存储位）。 */
const WS = 'D:/ws';
const WS_SESSIONS = 'D:/ws/.lantai/sessions';

/** 磁盘卷 7（本工作区会话根）——Phase 3b：卷本体 = 事件日志（.ndjson）。 */
function volumeLog(): string {
  return logText(
    7,
    [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前的回答' },
    ],
    '历史卷',
  );
}

/** 工作区会话根磁盘预置：{WS}/.lantai/sessions 有 7.json（恢复 = 扫描推导，
 *  不再读总目/tracker——list 层由共享 helper 的 listFlat 从文件表推导）。 */
function mockWorkspaceDisk(): void {
  const k = H.kernelFs;
  if (!k) throw new Error('kernelFs mock 未就绪（vi.mock 工厂未执行）');
  k.fs.files.clear();
  k.fs.dirs.clear();
  k.fs.writes.length = 0;
  k.fs.lists.length = 0;
  k.fs.fail = {};
  k.fs.setFile(`${WS_SESSIONS}/7.ndjson`, volumeLog());
}

async function drain(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  localStorage.clear();
  mockWorkspaceDisk();
  useShellStore.setState({ projectPath: WS });
});

describe('无 Key 冷启动 → 会话恢复 → 配 Key 不重启可发（死路形态守护）', () => {
  it('恢复不依赖工厂：工厂返 null（无 Key）时历史卷照常打开显示', async () => {
    mockWorkspaceDisk(); // 归零重建：磁盘是唯一事实源（localStorage 备份已拆）

    const panel = new ChatCore();
    // 无 Key 阶段的工厂（Phase B 契约：工厂在场但返 null——恢复不经工厂）
    panel.setAgentFactory(async () => null);

    // Q-B（2026-08-24）：不自动摊开——autoRestoreLastSession 只做发号对账
    await panel.autoRestoreLastSession(WS);
    expect(Session.getSessions(panel.panelId)).toHaveLength(0);

    // 历史卷可见 = 从案卷首页打开（内容层恢复不依赖工厂，Phase B 契约）
    await panel.loadSessionFromDisk(WS, 7);
    const sess = Session.getSessions(panel.panelId);
    expect(sess).toHaveLength(1);
    expect(sess[0].id).toBe(7);
    const msgs = msgStoreFor(panel.panelId, 7).getState().messages;
    expect(msgs.some((m) => m.role === 'user' && m.text === '之前的问题')).toBe(true);

    // ② 缺 Key 的表现 = toast 可见提示（2026-08-31 贴黄拆迁：不入消息流）
    await drain();
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.text.includes('卷的 Agent 未就绪'))).toBe(true);
  });

  it('配 Key 后不重启：同一面板直接发送成功（句柄拟文时补建）', async () => {
    mockWorkspaceDisk(); // 归零重建：磁盘是唯一事实源（localStorage 备份已拆）

    const panel = new ChatCore();
    panel.setAgentFactory(async () => null); // 无 Key 冷启动阶段
    await panel.autoRestoreLastSession(WS);
    await panel.loadSessionFromDisk(WS, 7); // Q-B：从案卷首页点开历史卷
    await drain(); // 排干补建失败 warn

    // 用户在设置中配置 Key 保存（不重启）：工厂从「返 null」变为可用
    const run = vi.fn(async () => undefined);
    panel.setAgentFactory(
      async () =>
        ({
          getSession: () => [{ role: 'system', content: 'sys' }],
          setSession: vi.fn(),
          dispose: vi.fn(),
          bindSession: vi.fn(),
          run,
          nextInsertIndex: 1,
          setUiSessionId: vi.fn(),
          insertMessage: vi.fn(),
          cascadeAbort: vi.fn(),
        }) as never,
    );

    getChatStore(panel.panelId).input.getState().setInputText('新问题');
    await panel.sendMessage();
    await drain();

    // ③ 直接发送成功：Agent.run 被驱动，无「Agent 未就绪」错误拦截
    expect(run).toHaveBeenCalledTimes(1);
    const notices = msgStoreFor(panel.panelId, 7)
      .getState()
      .messages.filter((m) => m.role === 'notice');
    expect(notices.some((n) => String((n as { text?: string }).text).startsWith('Agent 未就绪 —'))).toBe(false);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.text.startsWith('Agent 未就绪 —'))).toBe(false);
  });
});
