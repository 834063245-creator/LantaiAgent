// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-fold.test.ts — 流内图版卡**默认张开**、仍可手动收起（2026-10-08 用户拍板）。
//
// 这是对 2026-09-23 图版架批规则（「资产块默认收成一行签条：`defaultFolded` 对
// `asset != null` ⇒ `state !== 'pinned'`，钉住 / 活确认两条豁免」）的**显式规格变更**
// （用户原话「默认折叠很奇怪」）。现行规则：
//   ① 资产块（带 `asset` 元数据）**仍在折叠族内**——判据认**资产身份**，不认 kind 名
//      （kind 是开放面；`show_asset` 可以拿任意注册 kind 建块）⇒ 用户可点折叠行收起；
//   ② **默认张开**（`defaultFolded` 对 `asset != null` 恒 `false`）——旧的两条豁免
//      （钉住态张着 / 活确认卡不可藏）随默认态翻转**一并作废**：张开的卡无所谓
//      「豁免折叠」，留着只会多两条读不出来的分支；
//   ③ 折叠行（用户收起后）= 「物类签 + 题名」（`plateSignOf` + `asset.title`，与架上
//      签条同一枚签）——这条能力位随②保留，只是不再是默认可见面；
//   ④ 测高：资产折叠态 = `FOLD_ROW_H`（折叠行即本体，块体不渲染）；
//   ⑤ 折叠位入 measureSignature（否则折叠/展开互相吃到对方的缓存高）；
//   ⑥ **接线在册**：三处生产调用点都传块（判据要看块身份，漏传 = 资产不受折叠控制）。
//
// 旧行为的证伪力：把 `block?.asset != null` 那几条判据去掉，①③④⑤ 全红；
// 把 `defaultFolded` 的资产分支改回 `state !== 'pinned'`，② 红；
// 把调用点的末参去掉，⑥ 红（而 ①-⑤ 仍绿——所以⑥必须单独钉）。
//
// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/* 文本测量桩（同 paper-* 族既有范式）：node 环境无 canvas，pretext 的
 * prepare/layout 起不来；本文件只考**分派与常数**，不考字形度量。 */
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
  walkLineRanges: vi.fn((_p: unknown, _w: number, cb: (l: unknown) => void) => cb({ start: 0, end: 1, width: 100 })),
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'x' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));

import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { defaultFolded, foldLabel, isFoldable } from '../src/paper/fold';
import { FOLD_ROW_H, measureBlockHeight, measureSignature } from '../src/plugins/builtin/paper-shell/measure';

const SRC = join(__dirname, '..', 'src');
const PANEL_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx'), 'utf8');
const FOLD_STATE_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'use-fold-state.ts'), 'utf8');
const FOLD_TS = readFileSync(join(SRC, 'paper', 'fold.ts'), 'utf8');

/** 一张图版卡块（资产元数据形状照 translate 的 BlockPart 投影）。 */
function assetBlock(kind = 'table', opts?: { pinned?: boolean; title?: string }): SourcedBlock {
  return createBlock(
    kind,
    { columns: ['a'], rows: [['x']] },
    { messageId: 'm1', part: null },
    {
      asset: {
        assetId: 'as-1',
        presentation: 'grid',
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
        finalised: true,
      },
      ...(opts?.pinned ? { state: 'pinned' as const, x: 10, y: 20 } : {}),
    },
  );
}

describe('资产块在折叠族内但默认张开（显式规格变更）', () => {
  it('①判据认资产身份：带 asset 的块可折叠（**不看 kind 名**——kind 是开放面）', () => {
    expect(isFoldable('table', assetBlock())).toBe(true);
    // 连「正文/来文」这类原本不可折叠的 kind，做成资产块后也进族（资产身份优先）
    expect(isFoldable('markdown', assetBlock('markdown'))).toBe(true);
    // 无块面（旧调用面：只看 kind）照旧——非资产 kind 不可折叠
    expect(isFoldable('markdown')).toBe(false);
    expect(isFoldable('table')).toBe(false);
  });

  it('②默认张开；旧的钉住/活确认两条豁免随默认态翻转一并作废', () => {
    const b = assetBlock('table', { title: '图版 1' });
    expect(defaultFolded('table', b.payload, b)).toBe(false);
    // 钉住态同样张开——豁免是「收起的例外」，收起本身没了 ⇒ 例外无处可挂
    const pinned = assetBlock('table', { title: '图版 1', pinned: true });
    expect(pinned.state).toBe('pinned');
    expect(defaultFolded('table', pinned.payload, pinned)).toBe(false);
    // 活确认卡（executor 预发卡的 onResponse 回调挂在 asset._confirm 上）也张开：
    // 「可操作卡不可被折叠藏住」这条纪律现在由默认态自己兜住
    const live = createBlock(
      'confirm',
      { title: '要不要删这三卷？' },
      { messageId: 'm1', part: null },
      { asset: { assetId: 'as-c', presentation: '', finalised: true, _confirm: () => {} } },
    );
    expect(defaultFolded('confirm', live.payload, live)).toBe(false);
    // 历史卡（回调随快照/重载消失）同样张开，与普通图版一致
    const history = assetBlock('confirm', { title: '要不要删这三卷？' });
    expect(defaultFolded('confirm', history.payload, history)).toBe(false);
  });

  it('②回归：非资产块的默认态逐值不变（夹注恒折 / 脚注按状态 / 来文正文不折）', () => {
    expect(defaultFolded('reasoning', { text: 'x' })).toBe(true);
    expect(defaultFolded('tool', { status: 'error' })).toBe(false);
    expect(defaultFolded('tool', { status: 'done' })).toBe(true);
    expect(defaultFolded('markdown', { text: 'x' })).toBe(false);
    expect(defaultFolded('user', { text: 'x' })).toBe(false);
  });

  it('③折叠行 = 物类签 + 题名（与架上签条同一枚签）；无题名只出签（签恒在）', () => {
    // 折叠行只在**用户手动收起**后现身（默认张开），但文案口径与架上签条同源
    const b = assetBlock('table', { title: '图版 1' });
    expect(foldLabel('table', b.payload, true, b)).toBe('▸ 表 图版 1');
    expect(foldLabel('table', b.payload, false, b)).toBe('▾ 收起 表 图版 1');
    const untitled = assetBlock('table');
    expect(foldLabel('table', untitled.payload, true, untitled)).toBe('▸ 表');
    // 开放 kind（未登记物类签）= 回落「录」，不空着
    const open = assetBlock('acme/custom-kind', { title: '外来的' });
    expect(foldLabel('acme/custom-kind', open.payload, true, open)).toBe('▸ 录 外来的');
    // 题名里的换行压成空格（折叠行恒一行，nowrap 语义）
    const wrapped = assetBlock('table', { title: '两行\n题名' });
    expect(foldLabel('table', wrapped.payload, true, wrapped)).toBe('▸ 表 两行 题名');
  });

  it('③回归：非资产调用面照旧（夹注/脚注文案逐字不变）', () => {
    expect(foldLabel('reasoning', { text: 'x'.repeat(214) }, true)).toBe('▸ 思考 214 字');
    expect(foldLabel('reasoning', { text: '思' }, false)).toBe('▾ 收起思考');
    expect(foldLabel('tool', { args: '', output: '', err: '' }, true)).toBe('▸ 工具 · 待执行');
  });

  it('④测高：资产折叠态 = FOLD_ROW_H（折叠行即本体）；展开态另算', () => {
    const b = assetBlock('table', { title: '图版 1' });
    expect(measureBlockHeight(b, true)).toBe(FOLD_ROW_H);
    const expanded = measureBlockHeight(b, false);
    expect(expanded).not.toBe(FOLD_ROW_H);
    expect(expanded).toBeGreaterThan(FOLD_ROW_H); // 表体（题签 + 表头 + 行）
    // 钉住态（同样默认张开）的折叠高同源
    expect(measureBlockHeight(assetBlock('table', { title: 'x', pinned: true }), true)).toBe(FOLD_ROW_H);
  });

  it('⑤折叠位入 measureSignature（折叠/展开不得互吃缓存高）', () => {
    const b = assetBlock('table', { title: '图版 1' });
    expect(measureSignature(b, true)).not.toBe(measureSignature(b, false));
    // 签名形状：kind + 表现 + 折叠位（表现换了也要重测）
    expect(measureSignature(b, true)).toBe('open|table|grid|1');
    expect(measureSignature(assetBlock('table', { title: '另一张' }), true)).toBe('open|table|grid|1');
  });

  it('⑥接线在册：生产三处调用点都**传块**（漏传 = 资产不受折叠控制，而①-⑤仍绿）', () => {
    expect(PANEL_TSX).toContain('isFoldable(block.kind, block)');
    expect(PANEL_TSX).toContain('foldLabel(block.kind, p, folded, block)');
    // 折叠态**不渲染块体**（折叠行即本体——与 ToolBody 的 `if (folded) return null` 同义）
    expect(PANEL_TSX).toContain('Body && !(block.asset != null && folded)');
    expect(FOLD_STATE_TS).toContain('defaultFolded(b.kind, b.payload, b)');
  });

  it('文件头现行规则行已同批改写：资产那条规则在册（默认**张开**），且**明写这是显式规格变更**', () => {
    expect(FOLD_TS).toContain('**资产块**（带 asset 元数据的块 —— 图版卡族）：**默认张开**');
    expect(FOLD_TS).toContain('**显式规格变更**');
    // 旧口径（「默认**收起成一行签条**」+ 两条豁免）不得再以现状口吻在册
    expect(FOLD_TS).not.toContain('默认**收起成一行签条**');
    expect(FOLD_TS).not.toContain('挑出来的收藏');
    // 「其余 kind 不可折叠」那条的限定（未带 asset 元数据的那些）照旧
    expect(FOLD_TS).toContain('其余 kind（来文/正文/抄录/拟策/贴黄——**未带 asset 元数据**的那些）不可折叠。');
    expect(FOLD_TS).not.toContain('//   - 其余 kind（来文/正文/抄录/拟策/贴黄）不可折叠。');
  });
});
