// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 架阁 · 卡片页（2026-11-24 全量迭代）：目录按入阁时分桶、右栏选中即见内容。
//
// 判据（用户视角）：
// ① 选中一张卡，右栏立刻读得到它是什么（kind 分派：html 真跑 / table 真排 / 其余一句实话）；
// ② 元数据不再藏着：入阁时间、字节、来源卷（有就写，没有不编）；
// ③ 动作常显、破坏性动作两击；没有画布时不摆无效的「摊 / 引」；
// ④ 坏卡不静默（skipped 明示），读失败可重试，空架给出口。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCards: vi.fn(),
  readCard: vi.fn(),
  writeCardState: vi.fn(),
  renameCard: vi.fn(),
  deleteCard: vi.fn(),
}));

vi.mock('../src/agent/card-library', () => ({
  listCards: mocks.listCards,
  readCard: mocks.readCard,
  writeCardState: mocks.writeCardState,
  renameCard: mocks.renameCard,
  deleteCard: mocks.deleteCard,
}));

const { activeRootViews, rootViewsServicePlugin } = await import('../src/composition/root-views-service');
const { compositionServicesPlugin } = await import('../src/composition/services');
const { Context } = await import('../src/cordis');
const { shelfDomainPlugin } = await import('../src/plugins/builtin/shelf-domain');
const { useDockStore } = await import('../src/state/dock-store');
const { useShelfStore } = await import('../src/state/shelf-store');

const NOW = new Date();
const TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 9, 41).toISOString();
const EARLIER = '2026-01-02T08:00:00.000Z';

const CARDS = [
  { cardId: 'card-1', kind: 'html', title: '本周待办', shelvedAt: TODAY, dirBytes: 1200, stateBytes: 0 },
  { cardId: 'card-2', kind: 'table', title: '读书清单', shelvedAt: TODAY, dirBytes: 800, stateBytes: 0 },
  { cardId: 'card-3', kind: 'chem', title: '分子式', shelvedAt: EARLIER, dirBytes: 300, stateBytes: 0 },
];

const CARD_DOCS: Record<string, unknown> = {
  'card-1': {
    kind: 'html',
    title: '本周待办',
    payload: { code: '<div id="todo">本周</div>' },
    source: { sessionId: '12', shelvedAt: TODAY },
  },
  'card-2': {
    kind: 'table',
    title: '读书清单',
    payload: { columns: ['书名', '状态'], rows: [['兰台', '在读']] },
    source: { sessionId: '7', shelvedAt: TODAY },
  },
  'card-3': { kind: 'chem', title: '分子式', payload: { smiles: 'C' }, source: {} },
};

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const openShelf = async (): Promise<void> => {
  await act(async () => useShelfStore.getState().openShelf('card'));
  await flush();
};

describe('架阁 · 卡片页（v67）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useShelfStore.getState().closeShelf();
    useDockStore.getState().closePanel('paper');
    useDockStore.getState().closePanel('settings');

    mocks.listCards.mockResolvedValue({
      cards: CARDS,
      skipped: [{ cardId: 'card-bad', error: 'card.json 损坏' }],
    });
    mocks.readCard.mockImplementation((id: string) =>
      Promise.resolve({ card: CARD_DOCS[id] ?? { kind: 'text', payload: {} }, state: {} }),
    );
    mocks.renameCard.mockResolvedValue({ cardId: 'card-1', title: '' });
    mocks.deleteCard.mockResolvedValue({ cardId: 'card-1', trashed: null });
    mocks.writeCardState.mockResolvedValue({ bytes: 0 });

    const ctx = new Context();
    await ctx.plugin(compositionServicesPlugin);
    await ctx.plugin(rootViewsServicePlugin);
    await ctx.plugin(shelfDomainPlugin);
    await act(async () => {
      root?.render(activeRootViews('overlay').map((v) => <v.component key={v.id} />));
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    useShelfStore.getState().closeShelf();
    useDockStore.getState().closePanel('paper');
    useDockStore.getState().closePanel('settings');
    vi.clearAllMocks();
  });

  it('左目录分桶，右栏选中即见内容（html 真跑）', async () => {
    await openShelf();
    const text = container!.textContent ?? '';
    expect(text, '缺「今天」分桶').toContain('今天');
    expect(text, '缺「更早」分桶').toContain('更早');
    expect(text, '目录缺少卡片').toContain('本周待办');

    // 默认选中第一张：右栏标题 + 元数据（入阁 / 字节 / 来源卷）。
    expect(container!.querySelector('.shf-pane-title')?.textContent).toBe('本周待办');
    expect(text, '元数据缺入阁时间').toContain('入阁');
    expect(text, '元数据缺字节').toContain('1.2 KB');
    expect(text, '元数据缺来源卷').toContain('来自 案卷 Nº 12');
    expect(text, '坏卡被静默吞了').toContain('1 张卡片读不出');

    const frame = container!.querySelector('.shf-frame') as HTMLIFrameElement | null;
    expect(frame, 'html 卡没有真实预览').not.toBeNull();
    expect(frame?.getAttribute('srcdoc') ?? '', '预览没带卡片代码').toContain('id="todo"');
  });

  it('换一张 = 右栏换成它的内容（table 真排）', async () => {
    await openShelf();
    const row = [...container!.querySelectorAll<HTMLButtonElement>('.shf-crow')].find((b) =>
      (b.textContent ?? '').includes('读书清单'),
    );
    expect(row, '目录里找不到第二张').toBeDefined();
    await act(async () => row?.click());
    await flush();

    expect(container!.querySelector('.shf-pane-title')?.textContent).toBe('读书清单');
    expect(container!.textContent ?? '', '表格没排出来').toContain('兰台');
    expect(container!.querySelector('.shf-table'), '没有表格形态').not.toBeNull();
  });

  it('无画布时不摆「摊 / 引」；纸开着时回来', async () => {
    await openShelf();
    const labels = (): string[] => [...container!.querySelectorAll('.shf-k')].map((b) => (b.textContent ?? '').trim());
    expect(labels()).not.toContain('摊到画布');
    expect(labels()).not.toContain('引用到本卷');
    expect(labels()).toContain('改名');
    expect(labels()).toContain('删除');

    await act(async () => useDockStore.getState().openPanel('paper'));
    const withCanvas = (): string[] =>
      [...container!.querySelectorAll('.shf-k')].map((b) => (b.textContent ?? '').trim());
    expect(withCanvas()).toContain('摊到画布');
    expect(withCanvas()).toContain('引用到本卷');
  });

  it('改名：行内输入 → 提交 RPC，目录标题同拍更新', async () => {
    await openShelf();
    const rename = [...container!.querySelectorAll<HTMLButtonElement>('.shf-k')].find(
      (b) => (b.textContent ?? '').trim() === '改名',
    );
    expect(rename).toBeDefined();
    await act(async () => rename?.click());

    const input = container!.querySelector('.shf-rename') as HTMLInputElement | null;
    expect(input, '改名没进入输入态').not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '本周待办（改）');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();

    expect(mocks.renameCard).toHaveBeenCalledWith('card-1', '本周待办（改）');
    expect(container!.textContent ?? '', '目录标题没更新').toContain('本周待办（改）');
  });

  it('删除两击：第一击只换文案，第二击才落', async () => {
    await openShelf();
    const danger = container!.querySelector<HTMLButtonElement>('.shf-k.is-danger');
    expect(danger).not.toBeNull();

    await act(async () => danger?.click());
    expect(danger?.textContent ?? '', '第一击没进确认态').toContain('再按一次');
    expect(mocks.deleteCard, '第一击就删了').not.toHaveBeenCalled();

    await act(async () => danger?.click());
    await flush();
    expect(mocks.deleteCard).toHaveBeenCalledWith('card-1');
    expect(container!.textContent ?? '', '删掉的卡还挂在目录里').not.toContain('本周待办');
  });

  it('读失败可见并且能重试', async () => {
    mocks.readCard.mockRejectedValueOnce(new Error('磁盘读失败'));
    await openShelf();
    expect(container!.textContent ?? '', '读失败没说出来').toContain('读不出');
    const retry = [...container!.querySelectorAll<HTMLButtonElement>('.shf-k')].find(
      (b) => (b.textContent ?? '').trim() === '重试',
    );
    expect(retry, '读失败没给重试').toBeDefined();
    await act(async () => retry?.click());
    await flush();
    expect(container!.querySelector('.shf-frame'), '重试后没读回来').not.toBeNull();
  });

  it('空架：一句实话 + 入阁指引，不装假数据', async () => {
    mocks.listCards.mockResolvedValueOnce({ cards: [], skipped: [] });
    await openShelf();
    const text = container!.textContent ?? '';
    expect(text).toContain('架还是空的');
    expect(text, '空态没指路').toContain('入阁');
  });
});
