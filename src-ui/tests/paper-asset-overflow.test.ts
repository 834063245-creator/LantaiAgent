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
  observedKeyOf,
  reportObservedBlockHeight,
  splitObservedKey,
  subscribeObservedBlockHeights,
} from '../src/paper/measure';
import { ASSET_DERIVED } from '../src/paper/type-tokens';

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

  // 规格变更（2026-09-18 真机取证）：旧规格 = 越界表现回落 JSON 兜底视图（那条测试把病灶
  // 钉成了规格：模型按白名单选 'table' 是合法的，渲染侧却无声给一张 JSON 卡）。
  // 新规格 = 越界表现回落**该 kind 的默认表现**（deps_impact → graph），测高与渲染器同源；
  // 只有**未知 kind** 才走 '*' JSON 兜底（上面 future_custom 一例仍钉着该契约）。
  it('presentation 白名单外 → 回落该 kind 的默认表现（deps_impact+table → graph）', () => {
    const b = assetBlock('deps_impact', { nodes: [{ id: 'r' }] }, 'table');
    const asGraph = assetBlock('deps_impact', { nodes: [{ id: 'r' }] }, 'graph');
    expect(measureBlockHeight(b)).toBe(measureBlockHeight(asGraph));
  });

  it('media 图：label 行 + 320 上限 + 边框（保守占满，加载后实测收敛）', () => {
    const b = assetBlock('file', { ext: 'png', filePath: 'x.png' });
    expect(measureBlockHeight(b)).toBe(4 + ASSET_DERIVED.plateHeadH + (13 * 1.8 + 4) + 2 + 320);
  });

  it('media 文件行：非图扩展走单行文件行', () => {
    const b = assetBlock('file', { ext: 'pdf', filePath: 'x.pdf' });
    // 题签恒在（2026-09-17 收尾）：媒体块也带题签行（签「图」）
    expect(measureBlockHeight(b)).toBe(4 + ASSET_DERIVED.plateHeadH + (13 * 1.8 + 4) + 11 * 1.8);
  });

  it('chart 柱状：type 行 + svg 封顶 240（标签已进 SVG，不占盒外行）', () => {
    const b = assetBlock('chart', {
      type: 'bar',
      data: [
        { label: '甲', value: 1 },
        { label: '乙', value: 2 },
      ],
    });
    // D8/D9（2026-09-16）：分类标签移入 SVG 内（与柱体同坐标系），不再产生盒外标签行。
    // 规格变更（2026-09-17 盒定比例批）：SVG 高不再由「版心宽 × vbH ÷ 坐标系宽」封顶，
    // 改为按类目数分档（≤4 类 180 / ≤10 类 210 / 更多 240）——2 类柱图因此是 180 行高，
    // 不再被拉到 240（旧模型下 3 类柱图还会被 meet 缩成 213px 宽居中）。真源见
    // ASSET_DERIVED.chartSvgH / docs/plans/tool-image-context-plan.md §5.0。
    expect(measureBlockHeight(b)).toBe(8 + (9 * 1.8 + 4) + ASSET_DERIVED.chartSvgH('bar', 2));
  });

  it('chart 纯数值 data：无标签条（标签进 SVG 后纯数值同样无盒外行）', () => {
    const b = assetBlock('chart', { type: 'line', data: [1, 2, 3] });
    expect(measureBlockHeight(b)).toBe(8 + (9 * 1.8 + 4) + ASSET_DERIVED.chartSvgH('line', 3));
  });

  it('chart config.title / 轴名各占一行（D4/D9 新增，旧实现完全忽略 config）', () => {
    const withTitle = assetBlock('chart', { type: 'bar', data: [1, 2], config: { title: '论文量' } });
    expect(measureBlockHeight(withTitle)).toBe(8 + (9 * 1.8 + 4) + (11 * 1.8 + 6) + ASSET_DERIVED.chartSvgH('bar', 2));
    const withAxis = assetBlock('chart', { type: 'bar', data: [1, 2], config: { xName: '月份' } });
    expect(measureBlockHeight(withAxis)).toBe(8 + (9 * 1.8 + 4) + ASSET_DERIVED.chartSvgH('bar', 2) + (8 * 1.8 + 2));
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
    // 题签恒在（2026-09-17 第二批）：无题名的表也出题签行 ⇒ 其总高恒计入
    expect(measureBlockHeight(b)).toBe(4 + ASSET_DERIVED.plateHeadH + headRow + 2 * bodyRow);
  });

  it('graph 分层布局（A5 二期）：层宽×最宽层行高公式同 GraphLayeredBody', () => {
    const b = assetBlock('deps_impact', {
      nodes: [{ id: 'r' }, { id: 'a' }, { id: 'b' }],
      edges: [
        { from: 'r', to: 'a' },
        { from: 'r', to: 'b' },
      ],
    });
    // 规格变更（2026-09-17 盒定比例批）：图高不再由「版心宽 × 层宽×行高 ÷ 坐标系宽」
    // 换算封顶（旧式 720×134/360 = 268），改为**只随行数**（最宽层 2 行 → 2×52+16 = 120）。
    expect(measureBlockHeight(b)).toBe(8 + ASSET_DERIVED.graphViewH(2));
  });

  it('tree 表现：全节点行高（3 节点 → 3 行；与列数无关）', () => {
    const b = assetBlock(
      'deps_impact',
      {
        nodes: [{ id: 'r' }, { id: 'a' }, { id: 'b' }],
        edges: [
          { from: 'r', to: 'a' },
          { from: 'r', to: 'b' },
        ],
      },
      'tree',
    );
    // 规格变更同上一例：tree 走的是「全节点行数」（3 行）而非最宽层
    expect(measureBlockHeight(b)).toBe(8 + ASSET_DERIVED.graphViewH(3));
  });

  it('graph 查询式/空数据：占位单行（不再按 SVG 计高）', () => {
    expect(measureBlockHeight(assetBlock('deps_impact', { nodeId: 'x' }))).toBe(8 + 30);
    expect(measureBlockHeight(assetBlock('deps_impact', { nodes: [], edges: [] }))).toBe(8 + 30);
  });

  it('board：横排列高中取最大列（列题 + Σ卡高）', () => {
    const b = assetBlock('board', {
      columns: [
        { title: '待办', cards: [{ label: 'a' }] },
        { title: '完成', cards: [{ label: 'b', body: 'd' }] },
      ],
    });
    // 卡体文本 mock 36：带 body 卡 +38；列高 = 规线 2 + padding-top 6 + 列题 29.4 + 卡 42.4
    const colMax = 2 + 6 + (13 * 1.8 + 6) + (1 + 12 + 13 * 1.8 + 6) + 36 + 2;
    // 题签恒在（2026-09-17）：看板体高含题签行（签「板」）
    expect(measureBlockHeight(b)).toBe(4 + ASSET_DERIVED.plateHeadH + colMax);
  });

  it('board 空数据：占位单行（题签行仍在）', () => {
    expect(measureBlockHeight(assetBlock('board', {}))).toBe(4 + ASSET_DERIVED.plateHeadH + 30);
  });

  it('timeline：逐项 max(标题/时标行) + 正文实测 + 行距', () => {
    const b = assetBlock('timeline', {
      items: [
        { ts: 'v1', title: 't1', body: 'b1' },
        { ts: 'v2', title: 't2' },
      ],
    });
    // 文本 mock 恒 36：时标列 96 宽 → 2 行×18=36；标题 → ceil(36/23.4)=2 行×23.4=46.8
    const titleLineH = 2 * (13 * 1.8);
    const tsTwoLines = 2 * (10 * 1.8);
    const nodeH = 9 + 4;
    const headMax = Math.max(Math.max(titleLineH, tsTwoLines), nodeH); // 46.8
    const item1 = headMax + 36 + 2; // 正文实测 36 + 2
    const item2 = headMax; // 无正文
    // 题签恒在同上：时间轴体高含题签行（签「序」）
    expect(measureBlockHeight(b)).toBe(4 + ASSET_DERIVED.plateHeadH + item1 + 10 + item2);
  });

  it('timeline 空数据：占位单行（题签行仍在）', () => {
    expect(measureBlockHeight(assetBlock('timeline', { items: [] }))).toBe(4 + ASSET_DERIVED.plateHeadH + 30);
  });

  it('html：内距 4 + iframe 初始 240（上报后由实测回写抬到实际上报值）', () => {
    const b = assetBlock('html', { code: '<p>x</p>' });
    // 题签恒在同前（签「页」）
    expect(measureBlockHeight(b)).toBe(4 + ASSET_DERIVED.plateHeadH + 240);
  });

  it('form：题/文/选项列（desc 实测）/操作行（钤印钮面同拟策：13px 宋体 + margin-top 14）', () => {
    const b = assetBlock('confirm', { title: 't', body: 'b', options: [{ label: 'l', description: 'd' }] });
    const actionsH = 13 * 1.8 + 5 * 2 + 1 * 2 + 14; // .pp-pc-btn 行（CHROME_TOKENS.plan.actions*）
    expect(measureBlockHeight(b)).toBe(4 + (15 * 1.8 + 4) + (36 + 8) + (2 + 12 + 13 * 1.8 + 36) + 8 + actionsH);
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

  it('只读拟策：chrome 31 + 标题实测 36+12 + markdown 体 36（内容走 measureMdBlocks）', () => {
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

  it('needsObservedHeight：资产/开放/拟策/夹注·正文·抄录要实测，其余内置文本族不要', () => {
    expect(needsObservedHeight('file', true)).toBe(true);
    expect(needsObservedHeight('future_custom', false)).toBe(true);
    expect(needsObservedHeight('plan', false)).toBe(true);
    // 2026-09-19 夹注叠字批（真会话对拍实测）：canvas 折行与 DOM 折行系统性分家
    // ——夹注 936 条里 27% 块高有差、正文 163 条里 17%、抄录 36 条里 11% ⇒ 入族。
    expect(needsObservedHeight('reasoning', false)).toBe(true);
    expect(needsObservedHeight('markdown', false)).toBe(true);
    expect(needsObservedHeight('diff', false)).toBe(true);
    // 不入族者亦实测为零偏差/恒高：来文 60/60 零偏差（题签+花押定值、正文短）；
    // 工具卡载荷段全封顶（468/468）；工具组/子代理头恒一行结构块。
    expect(needsObservedHeight('user', false)).toBe(false);
    expect(needsObservedHeight('tool', false)).toBe(false);
    expect(needsObservedHeight('toolgroup', false)).toBe(false);
  });

  it('实测优先：record 存在时 cached 直接采用，静态镜像不参与', () => {
    const cache = createBlockMeasureCache();
    const b = assetBlock('html', { code: 'x' });
    // 记录键 = 壳层 data-block-observed 同源（observedKeyOf——渲染态入键）
    reportObservedBlockHeight(observedKeyOf(b, false, false, false), b.w, 800);
    expect(measureBlockHeightCached(b, cache)).toBe(800);
  });

  it('记录宽与块宽不一致 → 实测作废回落静态镜像（钉住改宽后待重报）', () => {
    const cache = createBlockMeasureCache();
    const b = assetBlock('html', { code: 'x' });
    reportObservedBlockHeight(observedKeyOf(b, false, false, false), 640, 800);
    expect(observedBlockHeightOf(observedKeyOf(b, false, false, false), b.w)).toBeUndefined();
    expect(measureBlockHeightCached(b, cache)).toBe(4 + ASSET_DERIVED.plateHeadH + 240);
  });

  it('记录变化 → 签名变化 → 缓存重测采用新实测（反馈框展开/iframe 上报路径）', () => {
    const cache = createBlockMeasureCache();
    const b = block('plan', { planId: 'p', title: 't', content: 'c', status: 's', _callback: () => {} });
    reportObservedBlockHeight(observedKeyOf(b, false, false, false), b.w, 500);
    expect(measureBlockHeightCached(b, cache)).toBe(500);
    reportObservedBlockHeight(observedKeyOf(b, false, false, false), b.w, 300);
    expect(measureBlockHeightCached(b, cache)).toBe(300);
  });

  /* ── 渲染态签名（2026-09-19 夹注叠字批）── */
  it('观测键 = 块 id + 渲染态；渲染态翻转 → 旧读数作废（不喂给另一种盒子）', () => {
    const b = block('reasoning', { text: '思考' });
    const collapsed = observedKeyOf(b, true, false, false);
    const expanded = observedKeyOf(b, false, false, false);
    expect(collapsed).not.toBe(expanded);
    expect(splitObservedKey(expanded)).toEqual([b.id, 'flow|f0s0o0']);
    // 折叠态读到的 44.97 不许被展开态消费（同一块 id、同宽）
    reportObservedBlockHeight(collapsed, b.w, 44.97);
    expect(observedBlockHeightOf(collapsed, b.w)).toBe(45); // ceil
    expect(observedBlockHeightOf(expanded, b.w)).toBeUndefined();
    // 钉住态也是另一种盒子（纸内白边 + 报头）
    const pinned = observedKeyOf({ ...b, state: 'pinned' }, false, false, false);
    expect(pinned).not.toBe(expanded);
    expect(observedBlockHeightOf(pinned, b.w)).toBeUndefined();
  });

  it('同宽换态 = restated（立即重排）：折叠翻转不等 120ms 去抖', () => {
    const events: number[] = [];
    const off = subscribeObservedBlockHeights(() => events.push(events.length));
    const b = block('reasoning', { text: '思考' });
    const collapsed = observedKeyOf(b, true, false, false);
    expect(reportObservedBlockHeight(collapsed, b.w, 45)).toBe('registered');
    expect(events).toHaveLength(0); // 首报校准登记不脉冲
    // 展开：同宽、换渲染态 → 旧读数已废，新读数立即生效（用户手势刚落）
    const expanded = observedKeyOf(b, false, false, false);
    expect(reportObservedBlockHeight(expanded, b.w, 1200)).toBe('restated');
    expect(events).toHaveLength(1);
    expect(observedBlockHeightOf(expanded, b.w)).toBe(1200);
    // 展开后流式长高：同态值变 → changed
    expect(reportObservedBlockHeight(expanded, b.w, 1250)).toBe('changed');
    expect(events).toHaveLength(2);
    off();
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
