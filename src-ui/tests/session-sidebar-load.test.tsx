// @vitest-environment jsdom

// SessionSidebar 载入成本守护：
//   ① 刷新分频——消息流式追加（每次 touchMessage）不得触发磁盘全量重扫
//      （listSavedSessions 读的是**全部卷体**：实测本机 32 MB 目录 → 21 MB / 240ms）；
//   ② 但行注记「N 块」仍须随消息追加实时更新（2026-09-01 面审的行为不得回退）。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { bumpSessionVolumes } from '../src/state/session-volumes-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

function fakeCore(panelId: string) {
  const listSavedSessions = vi.fn(async () => [
    { id: 2, label: '盘卷甲', msgCount: 5, savedAt: '2026-09-14T02:00:00.000Z' },
  ]);
  const core = {
    panelId,
    listSavedSessions,
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    renameSavedSession: vi.fn(),
    closeSession: vi.fn(),
    deleteSessionFile: vi.fn(),
    loadSessionFromDisk: vi.fn(async () => true),
    switchSession: vi.fn(),
  } as unknown as ChatCore;
  return { core, listSavedSessions };
}

describe('SessionSidebar 载入成本（刷新分频）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let panelId: string;
  let core: ChatCore;
  let listSavedSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    panelId = `test-ss-load-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    container = document.createElement('div');
    document.body.appendChild(container);
    ({ core, listSavedSessions } = fakeCore(panelId));
    useCoreStore.getState().setChatCore(core);
    getChatStore(panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  it('流式追加 50 次消息：磁盘重扫不发生，但「N 块」实时跟上', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {});
    expect(listSavedSessions).toHaveBeenCalledTimes(1); // 挂载首拉

    const msg = msgStoreFor(panelId, 1);
    // 模拟一个回合的流式追加（真实路径：每块 touchMessage → store 通知）
    for (let i = 0; i < 50; i++) {
      await act(async () => {
        msg.setState((s) => ({
          messages: [
            ...s.messages,
            { id: `m${i}`, role: 'assistant', parts: [{ type: 'text', text: `chunk ${i}` }] } as never,
          ],
          version: Date.now(),
        }));
      });
    }

    // ① 磁盘全量重扫不得随流式追加发生（每次都是读全部卷体）
    expect(listSavedSessions).toHaveBeenCalledTimes(1);
    // ② 行注记仍实时反映内存消息数（50 块）
    const meta = container.querySelector('.ss-row.open .ss-meta')?.textContent ?? '';
    expect(meta).toContain('50 块');
  });

  it('卷落定写入 → 清单重读（行注记「未存」转「刚刚」，不再靠流式事件碰运气）', async () => {
    // 首存之后不再有任何摊开集事件：只挂摊开集订阅会让该行恒「未存」——假信号
    // （「未存」的语义是「自动存可能失败了」）。写面落定 → bumpSessionVolumes → 重读。
    listSavedSessions.mockResolvedValueOnce([]); // 盘上还没有这一卷
    await act(async () => {
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {});
    expect(container.querySelector('.ss-row.open .ss-meta')?.textContent).toContain('未存');

    // 自动存落定（写面 bump）→ 盘上出现该卷（label/savedAt 有了）
    listSavedSessions.mockResolvedValue([{ id: 1, label: '案卷一', msgCount: 1, savedAt: new Date().toISOString() }]);
    await act(async () => {
      bumpSessionVolumes();
    });
    await act(async () => {});
    const meta = container.querySelector('.ss-row.open .ss-meta')?.textContent ?? '';
    expect(meta).not.toContain('未存');
    expect(meta).toContain('刚刚');
  });

  it('清单读取失败：保留上次结果 + 明示错误（不得显示「本工作区暂无案卷」）', async () => {
    // 旧实现：读面失败 resolve([]) → setSavedRows([]) → 已存卷整列消失，用户看到
    // 「本工作区暂无案卷」（landmine S6 的读面可见化遗留项）。
    await act(async () => {
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {});
    expect(container.querySelector('.ss-count')?.textContent).toBe('SESSIONS · 2'); // 摊开 1 + 已存 1

    // 切工作区 → 重拉 → 这次磁盘读失败
    listSavedSessions.mockRejectedValueOnce(new Error('案卷目录枚举失败（D:/x/.lantai/sessions）'));
    await act(async () => {
      useShellStore.getState().setProjectPath('D:/broken');
    });
    await act(async () => {});

    // 已存卷行仍在（保留上次结果）；错误可见
    expect([...container.querySelectorAll('.ss-label')].map((e) => e.textContent)).toContain('盘卷甲');
    expect(container.querySelector('.ss-notice')?.textContent).toContain('案卷清单读取失败');
    // 失败不缓存成空：再拉一次（成功）→ 通知消失
    await act(async () => {
      useShellStore.getState().setProjectPath('D:/good');
    });
    await act(async () => {});
    expect(container.querySelector('.ss-notice')).toBeNull();
  });
});
