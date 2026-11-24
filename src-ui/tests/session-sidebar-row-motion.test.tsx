// @vitest-environment happy-dom

// 案卷侧栏行位置变化（FLIP）行为面：
//   用户报「卷的位置发生变化时只跳变」——savedAt 重排 / 摊开⇄合卷跨节时，
//   行不许瞬移；旧位置→新位置由 transform 让位承载，时长走 --m-sheet。
//   动效敏感用户必须零位移；流式块数更新不改行 y，不得量 DOM、不得起动画。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { getChatStore } from '../src/ui/chat-store';

const SIDEBAR_CSS = readFileSync(
  join(__dirname, '..', 'src', 'plugins', 'builtin', 'canvas-nav', 'session-sidebar.css'),
  'utf8',
);
const offsetTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
let rowTops = new Map<string, number>();
let rafQueue: FrameRequestCallback[] = [];

function fakeCore(panelId: string): ChatCore {
  const now = new Date().toISOString();
  return {
    panelId,
    listSavedSessions: vi.fn(async () => [
      { id: 1, label: '卷甲', msgCount: 1, savedAt: now },
      { id: 2, label: '卷乙', msgCount: 1, savedAt: now },
      { id: 3, label: '卷丙', msgCount: 1, savedAt: now },
    ]),
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    renameSavedSession: vi.fn(async () => {}),
    closeSession: vi.fn(),
    deleteSessionFile: vi.fn(),
    loadSessionFromDisk: vi.fn(async () => true),
    switchSession: vi.fn(),
  } as unknown as ChatCore;
}

function stubMatchMedia(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

describe('案卷侧栏行位置变化：FLIP 让位', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let panelId: string;

  beforeEach(() => {
    panelId = `test-ss-motion-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    localStorage.removeItem('lantai.sidebar.folds');
    localStorage.removeItem('lantai.sidebar.width');
    localStorage.removeItem('lantai.sidebar.view');
    rowTops = new Map();
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        return rowTops.get(this.dataset?.id ?? '') ?? 0;
      },
    });
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (offsetTopDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetTop', offsetTopDescriptor);
    else delete (HTMLElement.prototype as unknown as { offsetTop?: number }).offsetTop;
  });

  async function mount(): Promise<void> {
    getChatStore(panelId).sess.setState({ sessions: [], activeIdx: 0, sessionTokens: {}, nextSessionId: 4 });
    useCoreStore.getState().setChatCore(fakeCore(panelId));
    await act(async () => {
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {});
  }

  const rowOf = (id: number) => container.querySelector(`.ss-row[data-id="${id}"]`) as HTMLElement;

  async function openVolumeOne(): Promise<void> {
    await act(async () => {
      getChatStore(panelId).sess.setState({
        sessions: [{ id: 1, label: '卷甲' }],
        activeIdx: 0,
        sessionTokens: {},
        nextSessionId: 4,
      });
    });
    await act(async () => {});
  }

  it('跨节 / 改序：旧 y − 新 y 写成起手 transform，下一帧交给 --m-sheet 归零', async () => {
    stubMatchMedia(false);
    // 初始 = 三卷都在已合卷节；只给行布局 y（其余盒为 0，offsetTop 链求和等价）。
    rowTops = new Map([
      ['3', 100],
      ['2', 200],
      ['1', 300],
    ]);
    await mount();
    expect(container.querySelectorAll('.ss-row[data-id]')).toHaveLength(3);

    // 卷 1 摊开：进入上节；卷 2/3 上移。新布局 y 由测试桩给出。
    rowTops = new Map([
      ['1', 40],
      ['3', 80],
      ['2', 180],
    ]);
    await openVolumeOne();

    const row1 = rowOf(1);
    const row2 = rowOf(2);
    const row3 = rowOf(3);
    for (const row of [row1, row2, row3]) {
      expect(row.classList.contains('ss-row--moving')).toBe(true);
      expect(row.style.transition).toBe('none'); // 起手态先禁过渡，防「从 0 滑到旧位」的反向动画
    }
    expect(row1.style.transform).toBe('translateY(260px)');
    expect(row2.style.transform).toBe('translateY(20px)');
    expect(row3.style.transform).toBe('translateY(20px)');

    // 下一帧撤起手值：CSS 的 --m-sheet 过渡接管；类留到 transitionend 再摘。
    const queued = rafQueue.splice(0);
    await act(async () => {
      for (const cb of queued) cb(0);
    });
    for (const row of [row1, row2, row3]) {
      expect(row.style.transform).toBe('');
      expect(row.style.transition).toBe('');
      expect(row.classList.contains('ss-row--moving')).toBe(true);
    }

    // 过渡收尾只摘命中行自身的类；背景/影随后的短过渡不许被长档绑架。
    const end = new Event('transitionend', { bubbles: true });
    Object.defineProperty(end, 'propertyName', { value: 'transform' });
    await act(async () => {
      row1.dispatchEvent(end);
    });
    expect(row1.classList.contains('ss-row--moving')).toBe(false);
    expect(row2.classList.contains('ss-row--moving')).toBe(true);
  });

  it('展开侧栏：磁盘清单迟到不得让摊开行重排（「每次展开都播位移动画」的根因）', async () => {
    stubMatchMedia(false);
    // 只给摊开行的布局 y（其余盒 offsetTop 为 0，链求和等价）
    rowTops = new Map([
      ['3', 100],
      ['2', 200],
    ]);
    let releaseSaved = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseSaved = resolve;
    });
    const core = fakeCore(panelId);
    core.listSavedSessions = vi.fn(async () => {
      await gate; // 磁盘清单故意迟到（真机 = 读全部卷体，数百毫秒）
      return [
        { id: 2, label: '卷甲', msgCount: 1, savedAt: '2026-08-29T00:00:00Z' }, // 旧 id 却最近落盘
        { id: 3, label: '卷乙', msgCount: 1, savedAt: '2026-08-21T00:00:00Z' },
      ];
    });
    useCoreStore.getState().setChatCore(core);
    getChatStore(panelId).sess.setState({
      sessions: [
        { id: 2, label: '卷甲', createdAt: '2026-08-20T00:00:00Z' },
        { id: 3, label: '卷乙', createdAt: '2026-08-25T00:00:00Z' },
      ],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 4,
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {});

    const order = () =>
      Array.from(container.querySelectorAll<HTMLElement>('.ss-row[data-id]')).map((el) => el.dataset.id);
    const before = order();
    expect(before).toEqual(['3', '2']); // 立卷时刻倒序：新卷在上

    await act(async () => {
      releaseSaved();
      await Promise.resolve();
    });
    await act(async () => {});

    expect(order()).toEqual(before); // 磁盘清单落地不改序
    expect(container.querySelectorAll('.ss-row--moving')).toHaveLength(0); // 也就没有让位动画
  });
  it('展开侧栏：首个活跃卷落定不自己滚（滚动只属于用户切卷）', async () => {
    stubMatchMedia(false);
    const proto = Element.prototype as unknown as { scrollIntoView?: (arg?: unknown) => void };
    const original = proto.scrollIntoView;
    const scrollSpy = vi.fn();
    proto.scrollIntoView = scrollSpy;
    try {
      rowTops = new Map([
        ['3', 100],
        ['2', 200],
      ]);
      useCoreStore.getState().setChatCore(fakeCore(panelId));
      getChatStore(panelId).sess.setState({
        sessions: [
          { id: 2, label: '卷甲', createdAt: '2026-08-20T00:00:00Z' },
          { id: 3, label: '卷乙', createdAt: '2026-08-25T00:00:00Z' },
        ],
        activeIdx: 0,
        sessionTokens: {},
        nextSessionId: 4,
      });
      await act(async () => {
        root = createRoot(container);
        root.render(<SessionSidebar />);
      });
      await act(async () => {});
      // 挂载：活跃卷由「无」变存量 id——面刚摊开就自己滚一大截是「展开即动」同族病灶。
      expect(scrollSpy).not.toHaveBeenCalled();

      await act(async () => {
        getChatStore(panelId).sess.setState({ activeIdx: 1 });
      });
      await act(async () => {});
      expect(scrollSpy).toHaveBeenCalledTimes(1); // 用户切卷照滚
    } finally {
      if (original) proto.scrollIntoView = original;
      else delete proto.scrollIntoView;
    }
  });
  it('CSS 合同：行让位只动 transform，时长走 --m-sheet；背景/影仍走 --snap', () => {
    const css = SIDEBAR_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf('.ss-row.ss-row--moving {');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf('}', at));
    expect(body).toContain('transform var(--m-sheet)');
    expect(body).toContain('background var(--snap)');
    expect(body).toContain('box-shadow var(--snap)');
    expect(body).toContain('will-change: transform');
    expect(body).not.toMatch(/\b(top|left|height|width)\s*:/);
  });

  it('减少动效：位置变化零位移，也不排 rAF', async () => {
    stubMatchMedia(true);
    rowTops = new Map([
      ['3', 100],
      ['2', 200],
      ['1', 300],
    ]);
    await mount();

    rowTops = new Map([
      ['1', 40],
      ['3', 80],
      ['2', 180],
    ]);
    await openVolumeOne();

    expect(container.querySelectorAll('.ss-row--moving')).toHaveLength(0);
    expect(rowOf(1).style.transform).toBe('');
    expect(rafQueue).toHaveLength(0);
  });
});
