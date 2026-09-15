// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// S6 P5a：卷首**组合芯片**（纸壳卷首右上角）——空白可拨 / 跑过一轮只读 + 来源与原因可见。
//
// 用户序列（与设计件 §2 序列 B + 施工单 WO-S6P5 §5 对拍）：
//   1. 空白卷 → 芯片**可拨**：点开菜单 → 选组合 → 写路径 = `core.selectSessionPreset`；
//   2. 该卷**跑过一轮** → **只读标签**（`span[data-locked]`，无按钮/无菜单）；
//   3. **作用对象 = 本 region 的卷**（宿主传入的 `sessionId`），不是「当前活跃卷」；
//   4. 组合不可用 / 写入被拒 → 原因**就地可见**（title / toast），不静默；
//   5. 来源词表（裁定 5）：本卷记录 / 全局默认——记录本身不区分谁写的，故不假装能分辨。
//
// 桩 core 只实现三个能力位（isSessionBlank / sessionComposition / selectSessionPreset）——
// 「能力位缺席 = 无读数不炸纸面」这条也在用例 7 里钉住。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutMock, richStatsMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));
// 纸壳依赖面（host.ts 的 re-export 会把 paper/** 拉进来）——照 tests/paper-new-volume.test.tsx 的纸壳 harness。
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
  walkLineRanges: vi.fn((_prepared: unknown, _width: number, cb: (l: unknown) => void) => {
    cb({ start: 0, end: 1, width: 100 });
  }),
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'mock' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: richStatsMock,
}));
const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

import { builtinPresets } from '../src/composition/presets';
import {
  type FolioChipCore,
  FolioCompositionChip,
  type FolioCompositionInfo,
} from '../src/plugins/builtin/paper-shell/FolioCompositionChip';
import { usePresetStore } from '../src/state/preset-store';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

const PANEL = 'p5-folio-chip';
/** 面板的活跃卷（与芯片作用对象刻意不同：芯片认的是**本 region** 的卷）。 */
const ACTIVE_SID = 1;
/** 芯片所在 region 的卷。 */
const REGION_SID = 7;

const INFO_GLOBAL: FolioCompositionInfo = { presetId: 'standard', source: 'global', error: null };
const INFO_SESSION: FolioCompositionInfo = { presetId: 'minimal', source: 'session', error: null };

/** 桩 core：三个能力位（`noWriter` = 写面能力位缺席，验「不炸纸面」）。 */
function fakeCore(
  opts: {
    blank?: boolean;
    info?: FolioCompositionInfo;
    change?: { ok: true } | { ok: false; reason: string };
    noWriter?: boolean;
  } = {},
): { core: FolioChipCore; selectCalls: Array<{ sid: number; id: string }> } {
  const selectCalls: Array<{ sid: number; id: string }> = [];
  const core: FolioChipCore = {
    panelId: PANEL,
    isSessionBlank: vi.fn(() => opts.blank ?? true),
    sessionComposition: vi.fn(async () => opts.info ?? INFO_GLOBAL),
  };
  if (!opts.noWriter) {
    core.selectSessionPreset = vi.fn(async (sid: number, id: string) => {
      selectCalls.push({ sid, id });
      return opts.change ?? { ok: true };
    });
  }
  return { core, selectCalls };
}

/** 挂载并**冲净异步读面**（`sessionComposition` 是 Promise——不 await act 会读到
 *  初值「全局默认」，测出的就是假症状）。 */
async function mount(
  container: HTMLDivElement,
  core: FolioChipCore | null,
  sessionId = String(REGION_SID),
): Promise<Root> {
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<FolioCompositionChip core={core} sessionId={sessionId} />);
  });
  return root;
}

/** 面板态：活跃卷 = ACTIVE_SID（芯片的 region 卷是 REGION_SID ⇒ 断言"不是活跃卷"有牙）。 */
function setupPanel(): void {
  getChatStore(PANEL).sess.setState({
    sessions: [
      { id: ACTIVE_SID, label: '活跃卷' },
      { id: REGION_SID, label: '本区卷' },
    ],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 99,
  });
  msgStoreFor(PANEL, REGION_SID).getState().setMessages([]);
}

const pill = (c: HTMLElement): Element | null => c.querySelector('.pp-folio-comp-pill');
const menu = (c: HTMLElement): Element | null => c.querySelector('.pp-folio-comp-menu');

describe('S6 P5a 卷首组合芯片', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    usePresetStore.setState({ roster: builtinPresets(), selected: 'standard', error: null });
    setupPanel();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it('① 空白卷可拨：点开菜单 → 选组合 → 走卷级写路径（携带本 region 的卷号）', async () => {
    const f = fakeCore({ blank: true });
    root = await mount(container, f.core);

    const chip = container.querySelector('[data-folio-comp-chip]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-session-id')).toBe(String(REGION_SID));
    expect(pill(container)?.tagName).toBe('BUTTON');
    expect(menu(container)).toBeNull();

    await act(async () => {
      (pill(container) as HTMLButtonElement).click();
    });
    expect(menu(container)).not.toBeNull();
    const opts = container.querySelectorAll('.pp-folio-comp-opt');
    expect(opts.length).toBe(builtinPresets().length);

    const minimal = [...opts].find((o) => o.textContent?.includes('minimal')) as HTMLButtonElement;
    await act(async () => {
      minimal.click();
    });

    // 作用对象 = 本 region 的卷（ACTIVE_SID=1 不是它）——写路径收到的必须是 7
    expect(f.selectCalls).toEqual([{ sid: REGION_SID, id: 'minimal' }]);
    expect(menu(container)).toBeNull(); // 选完即收
  });

  it('② 跑过一轮 = 只读标签：无按钮、无菜单，hover 说明锁定原因与来源', async () => {
    const f = fakeCore({ blank: false, info: INFO_SESSION });
    root = await mount(container, f.core);

    const p = pill(container) as HTMLElement;
    expect(p.tagName).toBe('SPAN');
    expect(p.getAttribute('data-locked')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(p.getAttribute('title')).toContain('跑过一轮');
    expect(p.getAttribute('title')).toContain('本卷记录');
  });

  it('③ hover 来源词表：本卷记录 / 全局默认（记录不区分谁写的，不假装能分辨）', async () => {
    const fg = fakeCore({ blank: true, info: INFO_GLOBAL });
    root = await mount(container, fg.core);
    expect(pill(container)?.getAttribute('title')).toContain('全局默认');
    act(() => root?.unmount());

    const fs = fakeCore({ blank: true, info: INFO_SESSION });
    root = await mount(container, fs.core);
    expect(pill(container)?.getAttribute('title')).toContain('本卷记录');
  });

  it('④ 组合不可用原因就地可见（title 带原因，不静默）', async () => {
    const f = fakeCore({
      blank: false,
      info: { presetId: 'ghost', source: 'session', error: '组合「ghost」不在册（已被删除或改名）' },
    });
    root = await mount(container, f.core);
    const title = pill(container)?.getAttribute('title') ?? '';
    expect(title).toContain('不在册');
    expect(title).toContain('已回退用户层组合');
  });

  it('⑤ 写路径拒绝 → 就地可见（空白闸二道闸/不可解析都不静默）', async () => {
    const f = fakeCore({ blank: true, change: { ok: false, reason: '本卷已跑过一轮——组合不能中途换' } });
    root = await mount(container, f.core);
    await act(async () => {
      (pill(container) as HTMLButtonElement).click();
    });
    const opt = container.querySelector('.pp-folio-comp-opt') as HTMLButtonElement;
    await act(async () => {
      opt.click();
    });
    expect(container.textContent).toContain('组合未切换');
    expect(container.textContent).toContain('不能中途换');
  });

  it('⑥ 写面能力位缺席（旧句柄/桩 core）→ 渲染不炸、点选无副作用', async () => {
    const f = fakeCore({ blank: true, noWriter: true });
    root = await mount(container, f.core);
    expect(pill(container)?.tagName).toBe('BUTTON');
    await act(async () => {
      (pill(container) as HTMLButtonElement).click();
    });
    const opt = container.querySelector('.pp-folio-comp-opt') as HTMLButtonElement;
    await act(async () => {
      opt.click();
    });
    expect(container.querySelector('[data-folio-comp-chip]')).not.toBeNull();
    expect(container.textContent).not.toContain('组合未切换');
  });

  it('⑦ 卷号形状非法（空串）→ 不炸、也不误写别人的卷', async () => {
    const f = fakeCore({ blank: true });
    root = await mount(container, f.core, '');
    expect(container.querySelector('[data-folio-comp-chip]')).not.toBeNull();
    await act(async () => {
      (pill(container) as HTMLButtonElement).click();
    });
    const opt = container.querySelector('.pp-folio-comp-opt') as HTMLButtonElement;
    await act(async () => {
      opt.click();
    });
    expect(f.selectCalls).toEqual([]);
  });
});
