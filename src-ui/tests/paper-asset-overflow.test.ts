// Copyright (c) 2026 Wenbing Jing. MIT License.

// paper 资产/拟策块溢出专项（2026-08-30 会话流渲染走查）：
//   - 资产块旧测高恒 80、签名不含 payload——媒体图 320 / JSON 兜底 400+ /
//     html 卡 1000 全被按成 80，绝对定位流里下一块压字（画图族卡片溢出根因）；
//   - 拟策卡旧固定预算（标题 39 / 选项区 118 / 操作行 40）装不下实渲染；
//   - 动态高（图片/iframe/拟策交互态）由实测回写桥兜底（壳层 RO → report）。
// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'（paper-v3a 同款）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutMock, richStatsMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: richStatsMock,
}));

import { createBlock, resetBlockIdCounterForTests, type SourcedBlock } from '../src/paper/block-model';
import {
  clearObservedBlockHeights,
  clearPaperMeasureCache,
  createBlockMeasureCache,
  measureBlockHeight,
  measureBlockHeightCached,
  measureSignature,
  needsObservedHeight,
  observedBlockHeightOf,
  reportObservedBlockHeight,
  subscribeObservedBlockHeights,
} from '../src/paper/measure';

function block(kind: Parameters<typeof createBlock>[0], payload: object): SourcedBlock {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

function assetBlock(kind: string, payload: unknown, presentation = '', w = 720): SourcedBlock {
  return {
    ...createBlock(kind, payload as never, { messageId: 'm', part: null }),
    w,
    asset: { assetId: 'as_1', presentation, title: 't', finalised: true },
  };
}

describe('measure：资产块按表现原语计高（80px 常量退役）', () => {
  beforeEach(() => {
    layoutMock.mockClear();
    richStatsMock.mockClear();
    clearPaperMeasureCache();
    clearObservedBlockHeights();
    resetBlockIdCounterForTests();
  });

  it('未知 kind（非资产）走 JSON 兜底视图：padding 12 + head 24 + pre 内距 20 + 文本 36', () => {
    const b = block('future_custom', { a: 1 });
    expect(measureBlockHeight(b)).toBe(12 + (10 * 1.8 + 6) + 20 + 36);
  });

  it('JSON 兜底封顶：pretty 高于预算时文本截到 340（.pp-json-pre 360 − 内距 20）', () => {
    layoutMock.mockReturnValueOnce({ height: 9999, lineCount: 999 });
    const b = block('future_custom', { big: 'x'.repeat(9999) });
    expect(measureBlockHeight(b)).toBe(12 + (10 * 1.8 + 6) + 20 + 340);
  });

  it('presentation 白名单外（deps_impact+table 无渲染器）回落 JSON 兜底视图', () => {
    const b = assetBlock('deps_impact', { nodes: [{ id: 'r' }] }, 'table');
    expect(measureBlockHeight(b)).toBe(12 + (10 * 1.8 + 6) + 20 + 36);
  });

  it('media 图：label 行 + 320 上限 + 边框（保守占满，加载后实测收敛）', () => {
    const b = assetBlock('file', { ext: 'png', filePath: 'x.png' });
    expect(measureBlockHeight(b)).toBe(4 + (13 * 1.8 + 4) + 2 + 320);
  });

  it('media 文件行：非图扩展走单行文件行', () => {
    const b = assetBlock('file', { ext: 'pdf', filePath: 'x.pdf' });
    expect(measureBlockHeight(b)).toBe(4 + (13 * 1.8 + 4) + 11 * 1.8);
  });

  it('chart 柱状：type 行 + svg 封顶 240 + 标签行（viewBox 宽自适应公式同 ChartBody）', () => {
    const b = assetBlock('chart', {
      type: 'bar',
      data: [
        { label: '甲', value: 1 },
        { label: '乙', value: 2 },
      ],
    });
    // w=720，viewBox 宽 = max(320, 2×44)=320 → 720×220/320=495 → 封顶 240；
    // 标签 joined 文本 mock 36 → ceil(36/16.2)=3 行
    const labelH = 6 + 3 * (9 * 1.8);
    expect(measureBlockHeight(b)).toBe(8 + (9 * 1.8 + 4) + 240 + labelH);
  });

  it('chart 纯数值 data：标签条只剩 margin 空条（空 span 无行盒）', () => {
    const b = assetBlock('chart', { type: 'line', data: [1, 2, 3] });
    expect(measureBlockHeight(b)).toBe(8 + (9 * 1.8 + 4) + 240 + 6);
  });

  it('metric：auto-fill 列数（minmax(120,1fr)+gap8）→ 行数 × 卡高', () => {
    const payload = { caption: 'kpi', items: Array.from({ length: 5 }, (_, i) => ({ label: `k${i}`, value: i })) };
    const oneRow = assetBlock('metric', payload);
    expect(measureBlockHeight(oneRow)).toBe(4 + (13 * 1.8 + 6) + (2 + 16 + 11 * 1.8 + 20 * 1.2));
    // 12 项 → 3 行（+2 行距 8）
    const threeRows = assetBlock('metric', {
      ...payload,
      items: Array.from({ length: 12 }, (_, i) => ({ label: `k${i}`, value: i })),
    });
    expect(measureBlockHeight(threeRows)).toBe(4 + (13 * 1.8 + 6) + 3 * (2 + 16 + 11 * 1.8 + 20 * 1.2) + 2 * 8);
  });

  it('grid 表格：表头 + 逐行文字测量（列宽偶分近似）', () => {
    const b = assetBlock('table', {
      columns: ['a', 'b'],
      rows: [
        [1, 2],
        [3, 4],
      ],
    });
    const line = 11 * 1.8;
    const headRow = 2 * line + 8 + 1; // 表头两列各一行 + padding + border-bottom
    const bodyRow = 2 * line + 8 + 0.5; // 单元格 mock 36 → ceil(36/19.8)=2 行
    expect(measureBlockHeight(b)).toBe(4 + headRow + 2 * bodyRow);
  });

  it('graph：确定性树布局几何（深度/规模公式同 GraphTreeBody）+ 360 封顶', () => {
    const b = assetBlock('deps_impact', {
      nodes: [{ id: 'r' }, { id: 'a' }, { id: 'b' }],
      edges: [
        { from: 'r', to: 'a' },
        { from: 'r', to: 'b' },
      ],
    });
    // 深度 1 → W = 2×160+40 = 360；H = 3×52+30 = 186 → 720×186/360=372 → 封顶 360
    expect(measureBlockHeight(b)).toBe(8 + 360);
  });

  it('html：内距 4 + iframe 初始 240（上报后由实测回写抬到实际上报值）', () => {
    const b = assetBlock('html', { code: '<p>x</p>' });
    expect(measureBlockHeight(b)).toBe(4 + 240);
  });

  it('form：题/文/选项列（desc 实测）/操作行', () => {
    const b = assetBlock('confirm', { title: 't', body: 'b', options: [{ label: 'l', description: 'd' }] });
    expect(measureBlockHeight(b)).toBe(
      4 + (15 * 1.8 + 4) + (36 + 8) + (2 + 12 + 13 * 1.8 + 36) + 8 + (11 * 1.8 + 8 + 2),
    );
  });

  it('随表现切换变高：media 图与文件行不同款（presentation 是高度信号）', () => {
    expect(measureSignature(assetBlock('file', { ext: 'png', filePath: 'x' }, 'media'))).not.toBe(
      measureSignature(assetBlock('file', { ext: 'png', filePath: 'x' }, '')),
    );
  });
});

describe('measure：拟策卡精确镜像（固定预算退役）', () => {
  beforeEach(() => {
    layoutMock.mockClear();
    clearPaperMeasureCache();
    clearObservedBlockHeights();
    resetBlockIdCounterForTests();
  });

  it('只读拟策：chrome 31 + 标题实测 36+12 + 条目 36', () => {
    const b = block('plan', { planId: 'p', title: 't', content: 'c', status: 's' });
    expect(measureBlockHeight(b)).toBe(31 + 36 + 12 + 36);
  });

  it('交互拟策（两方案）：选项区逐枚实测（25 + 2×83.4）+ 操作行 49.4——旧 118/40 装不下', () => {
    const b = block('plan', {
      planId: 'p',
      title: 't',
      content: 'c',
      status: 's',
      options: [
        { label: 'A', description: '方案一' },
        { label: 'B', description: '方案二' },
      ],
      _callback: () => {},
    });
    const perOption = 14 + 2 + 13 * 1.8 + 2 + 36 + 6; // padding + border + label + desc 间距 + desc 实测 + margin
    expect(measureBlockHeight(b)).toBe(31 + (36 + 12) + 36 + (25 + 2 * perOption) + (13 * 1.8 + 10 + 2 + 14));
  });
});

describe('实测回写桥（动态高兜底）', () => {
  beforeEach(() => {
    layoutMock.mockClear();
    clearPaperMeasureCache();
    clearObservedBlockHeights();
    resetBlockIdCounterForTests();
  });

  it('needsObservedHeight：资产/开放/拟策要实测，内置文本族不要', () => {
    expect(needsObservedHeight('file', true)).toBe(true);
    expect(needsObservedHeight('future_custom', false)).toBe(true);
    expect(needsObservedHeight('plan', false)).toBe(true);
    expect(needsObservedHeight('tool', false)).toBe(false);
    expect(needsObservedHeight('markdown', false)).toBe(false);
  });

  it('实测优先：record 存在时 cached 直接采用，静态镜像不参与', () => {
    const cache = createBlockMeasureCache();
    const b = assetBlock('html', { code: 'x' });
    reportObservedBlockHeight(b.id, b.w, 800);
    expect(measureBlockHeightCached(b, cache)).toBe(800);
  });

  it('记录宽与块宽不一致 → 实测作废回落静态镜像（钉住改宽后待重报）', () => {
    const cache = createBlockMeasureCache();
    const b = assetBlock('html', { code: 'x' });
    reportObservedBlockHeight(b.id, 640, 800);
    expect(observedBlockHeightOf(b.id, b.w)).toBeUndefined();
    expect(measureBlockHeightCached(b, cache)).toBe(4 + 240);
  });

  it('记录变化 → 签名变化 → 缓存重测采用新实测（反馈框展开/iframe 上报路径）', () => {
    const cache = createBlockMeasureCache();
    const b = block('plan', { planId: 'p', title: 't', content: 'c', status: 's', _callback: () => {} });
    reportObservedBlockHeight(b.id, b.w, 500);
    expect(measureBlockHeightCached(b, cache)).toBe(500);
    reportObservedBlockHeight(b.id, b.w, 300);
    expect(measureBlockHeightCached(b, cache)).toBe(300);
  });

  it('首报静默登记不触发订阅；挂载后值变才重排（滚动意图修 2026-08-31）', () => {
    const events: number[] = [];
    const off = subscribeObservedBlockHeights(() => events.push(events.length));
    // 挂载首报 = 校准登记（滚动磁盘挂载场景）：只写入记录，不脉冲全局重排
    expect(reportObservedBlockHeight('x1', 720, 100)).toBe('registered');
    expect(events).toHaveLength(0);
    // 同值重报（卸载→重挂载记录保留）：无变化
    expect(reportObservedBlockHeight('x1', 720, 100)).toBe('unchanged');
    expect(events).toHaveLength(0);
    // 挂载后值变 = 动态高（媒体图加载/html iframe 上报/拟策反馈框展开）：立即重排
    expect(reportObservedBlockHeight('x1', 720, 120)).toBe('changed');
    expect(events).toHaveLength(1);
    off();
  });

  it('宽度变化 = 旧实测作废待重报（钉住改宽），首次上报属登记', () => {
    const events: number[] = [];
    const off = subscribeObservedBlockHeights(() => events.push(events.length));
    reportObservedBlockHeight('x3', 720, 100);
    // 改宽后重报：宽度不匹配 → 登记新记录（不通知），旧宽记录已作废
    expect(reportObservedBlockHeight('x3', 640, 80)).toBe('registered');
    expect(observedBlockHeightOf('x3', 720)).toBeUndefined();
    expect(observedBlockHeightOf('x3', 640)).toBe(80);
    expect(events).toHaveLength(0);
    // 再变仍走动态高即时通知
    expect(reportObservedBlockHeight('x3', 640, 90)).toBe('changed');
    expect(events).toHaveLength(1);
    off();
  });

  it('clearObservedBlockHeights 复位（测试域）', () => {
    reportObservedBlockHeight('x2', 720, 100);
    expect(observedBlockHeightOf('x2', 720)).toBe(100);
    clearObservedBlockHeights();
    expect(observedBlockHeightOf('x2', 720)).toBeUndefined();
  });
});
