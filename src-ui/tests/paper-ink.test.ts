// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-ink — P4 缩远墨迹：墨条几何（walkLineRanges 路径）/ LOD 迟滞 /
// 墨色板 token 字面量镜像钉死。pretext 全 mock（jsdom 无 Canvas 2D）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { walkMock, naturalWidthMock, materializeMock, richWalkMock, richMaterializeMock } = vi.hoisted(() => ({
  walkMock: vi.fn(
    (_prepared: unknown, _width: number, onLine: (line: { width: number; start: unknown; end: unknown }) => void) => {
      // 固定两行折行（宽 100 / 80）——行条几何的确定桩
      onLine({ width: 100, start: null, end: null });
      onLine({ width: 80, start: null, end: null });
      return 2;
    },
  ),
  naturalWidthMock: vi.fn(() => 200),
  materializeMock: vi.fn(() => ({ text: '测试行', width: 100, start: null, end: null })),
  /* 富行内桩：一行两片段——正文「甲」（宽 40，无前导空白）+ 行内码「乙」
   * （宽 20 + 折叠空白 5）。折行数与片段几何都由本桩确定。 */
  richWalkMock: vi.fn((_prepared: unknown, _width: number, onLine: (line: unknown) => void) => {
    onLine({ fragments: [{ itemIndex: 0 }, { itemIndex: 1 }], width: 65, end: null });
    return 1;
  }),
  richMaterializeMock: vi.fn(() => ({
    width: 65,
    end: null,
    fragments: [
      { itemIndex: 0, text: '甲', gapBefore: 5, occupiedWidth: 40 },
      { itemIndex: 1, text: '乙', gapBefore: 5, occupiedWidth: 20 },
    ],
  })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _segs: true })),
  walkLineRanges: walkMock,
  materializeLineRange: materializeMock,
  measureNaturalWidth: naturalWidthMock,
  clearCache: vi.fn(),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items, _mock: true })),
  measureRichInlineStats: vi.fn(() => ({ lineCount: 1, maxLineWidth: 100 })),
  walkRichInlineLineRanges: richWalkMock,
  materializeRichInlineLineRange: richMaterializeMock,
}));

import { createBlock, resetBlockIdCounterForTests } from '../src/paper/block-model';
import {
  createInkCache,
  INK_BAR_COLORS,
  INK_COLORS,
  INK_FAIL,
  INK_LABEL_MIN_PX,
  inkBarColorOf,
  inkColorOf,
  inkForBlock,
  LABEL_GLYPH_RATIO,
  LOD_BAR_ENTER,
  LOD_BAR_EXIT,
  LOD_ENTER,
  LOD_EXIT,
  LOD_SIL_ENTER,
  LOD_SIL_EXIT,
  lodActive,
  lodFarActive,
  lodTierOf,
  regionLabelTopWorld,
} from '../src/paper/ink';
import { clearPaperMeasureCache } from '../src/paper/measure';
import {
  CHROME_DERIVED,
  CHROME_TOKENS,
  FONT_STACKS,
  LIMIT_TOKENS,
  MD_TOKENS,
  PAPER_TYPE,
} from '../src/paper/type-tokens';

function block(kind: Parameters<typeof createBlock>[0], payload: object) {
  return createBlock(kind, payload as never, { messageId: 'm', part: null });
}

/* ═══ LOD 迟滞 ═══ */

describe('paper/ink LOD 迟滞', () => {
  it('未激活：跌破进入阈才激活', () => {
    expect(lodActive(0.6, false)).toBe(false);
    expect(lodActive(LOD_ENTER, false)).toBe(false); // 半开区间：< 才进
    expect(lodActive(0.35, false)).toBe(true);
  });
  it('已激活：回升需越过退出阈（阈值间往返不闪烁）', () => {
    expect(lodActive(0.38, true)).toBe(true); // 0.36-0.39 之间保持
    expect(lodActive(0.389, true)).toBe(true);
    expect(lodActive(LOD_EXIT, true)).toBe(false); // 退出阈半开：≥ 即退
    expect(lodActive(0.7, true)).toBe(false);
  });
  /* 2026-09-20 下移（0.55 → 0.36，用户拍板）：接管点与行影档边界同值——
   * 可读区（正文 ≥ 6px）留给 DOM，切轨只发生在「本来就读不清」的地方。 */
  it('接管阈 = 行影档边界（DOM ↔ 墨迹的切轨点与文字档 ↔ 行影档同值）', () => {
    expect(LOD_ENTER).toBe(LOD_BAR_ENTER);
    expect(LOD_EXIT).toBe(LOD_BAR_EXIT);
  });
});

/* ═══ 远档卷名标签落位（2026-09-20「卷名跳出流区」）═══
 * 病灶：旧实现把「屏幕空间偏移 labelPx × 1.6」当世界偏移用——偏移量 = 17.6/zoom
 * 世界单位随缩远无界增长。实机捕获（zoom 0.35，fillText 世界坐标）标签顶恒在纸顶
 * **之上 51-52 世界单位**（zoom 0.3 为 58-60）——墨落在纸外的桌面上。
 * 现语义：标签顶 = 纸顶 + 世界偏移，且整体钳在卷首区高内。 */
describe('paper/ink 远档卷名标签落位', () => {
  const FOLIO = 189.92; // 实机量得的卷首区高（世界单位）
  const PAPER_TOP = -1000; // 纸顶（世界）
  const regionTop = PAPER_TOP + FOLIO; // regionTop = 纸顶 + folioH

  it('标签顶落在纸面内（≥ 纸顶）——旧实现在 zoom 0.35 时高出纸顶 51 世界单位', () => {
    for (const zoom of [0.75, 0.5, 0.35, 0.3, 0.25, 0.2, 0.14, 0.1, 0.05, 0.01]) {
      const labelPx = Math.max(INK_LABEL_MIN_PX, 32 * zoom);
      expect(regionLabelTopWorld(regionTop, FOLIO, labelPx)).toBeGreaterThanOrEqual(PAPER_TOP);
    }
  });

  it('标签整体（字形盒）留在卷首区内，不压正文', () => {
    for (const zoom of [0.35, 0.2, 0.1, 0.05]) {
      const labelPx = Math.max(INK_LABEL_MIN_PX, 32 * zoom);
      const y = regionLabelTopWorld(regionTop, FOLIO, labelPx);
      expect(y + labelPx * LABEL_GLYPH_RATIO).toBeLessThanOrEqual(PAPER_TOP + FOLIO);
    }
  });

  it('极小卷首（窄流区/异常）也不出纸：offset 非负', () => {
    for (const folioH of [0, 1, 12, 40]) {
      expect(regionLabelTopWorld(0, folioH, 11)).toBeGreaterThanOrEqual(-folioH); // 纸顶 = 0 − folioH
    }
  });

  it('缩远时标签不再随 zoom 漂移（世界偏移有界：恒为标签字形盒高）', () => {
    const at035 = regionLabelTopWorld(regionTop, FOLIO, Math.max(INK_LABEL_MIN_PX, 32 * 0.35));
    const at005 = regionLabelTopWorld(regionTop, FOLIO, Math.max(INK_LABEL_MIN_PX, 32 * 0.05));
    // 0.35 档标签 11.2px、0.05 档触到 11px 下限 ⇒ 落点差 = 0.2 × 1.12 ≈ 0.22 世界单位。
    // 旧实现同两档差 176 世界单位（17.6/0.05 − 17.6/0.35）——漂移从「无界」收成「亚像素」。
    expect(Math.abs(at005 - at035)).toBeLessThan(1);
  });
});

/* ═══ 远景三档（P4c，2026-09-06）——档位判定与迟滞 ═══ */

describe('paper/ink 远景三档（P4c）', () => {
  it('文字档 → 行影档：跌破 0.36 进，回升越过 0.39 才出（阈值间保持不闪档）', () => {
    expect(lodTierOf(0.55, 'text')).toBe('text');
    expect(lodTierOf(LOD_BAR_ENTER, 'text')).toBe('text'); // 半开：< 才进
    expect(lodTierOf(0.35, 'text')).toBe('bar');
    // 0.36-0.39 之间保持行影（迟滞带）
    expect(lodTierOf(0.37, 'bar')).toBe('bar');
    expect(lodTierOf(LOD_BAR_EXIT, 'bar')).toBe('text'); // ≥ 即回文字
  });
  it('行影档 → 剪影档：跌破 0.14 进，回升越过 0.16 才出', () => {
    expect(lodTierOf(0.2, 'bar')).toBe('bar');
    expect(lodTierOf(LOD_SIL_ENTER, 'bar')).toBe('bar');
    expect(lodTierOf(0.13, 'bar')).toBe('silhouette');
    expect(lodTierOf(0.15, 'silhouette')).toBe('silhouette'); // 迟滞带
    expect(lodTierOf(LOD_SIL_EXIT, 'silhouette')).toBe('bar');
  });
  it('剪影档直跨：极远回升到 0.4 一步回文字档（跨档不粘滞）', () => {
    expect(lodTierOf(0.5, 'silhouette')).toBe('bar'); // 先出剪影档
    expect(lodTierOf(0.5, 'bar')).toBe('text'); // 再出行影档
  });
  it('lodFarActive（DOM 退场旗标）：与行影档同边界同迟滞', () => {
    expect(lodFarActive(0.5, false)).toBe(false);
    expect(lodFarActive(0.35, false)).toBe(true);
    expect(lodFarActive(0.37, true)).toBe(true); // 迟滞带保持
    expect(lodFarActive(LOD_BAR_EXIT, true)).toBe(false);
  });
});

/* ═══ 行影档墨色（P4c 距离墨量补偿——字面量钉死）═══ */

describe('paper/ink INK_BAR_COLORS 行影档镜像（P4c）', () => {
  it('条面 alpha ≈ 文字色面 × 0.45 兑水（远看应有的灰度，非黑墙）', () => {
    expect(INK_BAR_COLORS.markdown).toBe('rgba(38, 34, 28, 0.42)');
    expect(INK_BAR_COLORS.user).toBe('rgba(166, 58, 46, 0.58)'); // 朱砂 landmark 略提亮
    expect(INK_BAR_COLORS.reasoning).toBe('rgba(111, 110, 104, 0.38)');
    expect(INK_BAR_COLORS.tool).toBe('rgba(58, 91, 122, 0.44)');
    expect(inkBarColorOf('chart')).toBe('rgba(38, 34, 28, 0.24)'); // 未知/资产 → 最淡
  });
});

/* ═══ 墨色板（tokens.css 字面量镜像钉死——改 token 两处同步）═══ */

describe('paper/ink INK_COLORS 镜像', () => {
  it('文类→墨色铁律：正文=墨 / 来文=朱砂 / 夹注=石墨 / 脚注族=石青 / 贴黄=次级', () => {
    expect(INK_COLORS.markdown).toBe('rgba(38, 34, 28, 0.94)'); // --ink-1 alpha 墨（2026-08-31 浸墨化 v2）
    expect(INK_COLORS.user).toBe('#a63a2e'); // --seal
    expect(INK_COLORS.reasoning).toBe('#6f6e68'); // --graphite
    expect(INK_COLORS.tool).toBe('#3a5b7a'); // --indigo
    expect(INK_COLORS.code).toBe('#3a5b7a');
    expect(INK_COLORS.diff).toBe('#3a5b7a');
    expect(INK_COLORS.plan).toBe('#3a5b7a');
    expect(INK_COLORS.notice).toBe('rgba(38, 34, 28, 0.7)'); // --ink-2 alpha 墨（2026-08-31 浸墨化 v2）
    expect(inkColorOf('chart')).toBe('rgba(38, 34, 28, 0.48)'); // 资产/未知 → --ink-3 alpha 墨（2026-08-31 浸墨化 v2）
  });

  it('INK_FAIL = tokens.css --fail 字面量镜像（目次带识别层的「错」短规用）', () => {
    expect(INK_FAIL).toBe('#a9443f');
    expect(INK_BAR_COLORS._default).not.toBe(INK_FAIL); // 错不是文类族色，是语义状态
  });

  it('INK_BAR_COLORS 条面色 = 文字色兑水（目次带识别层的族色真源）', () => {
    expect(INK_BAR_COLORS.markdown).toBe('rgba(38, 34, 28, 0.42)');
    expect(INK_BAR_COLORS.user).toBe('rgba(166, 58, 46, 0.58)'); // 朱砂提亮（人=landmark）
    expect(INK_BAR_COLORS.tool).toBe('rgba(58, 91, 122, 0.44)'); // --indigo 石青
    expect(INK_BAR_COLORS.code).toBe('rgba(58, 91, 122, 0.44)');
    expect(inkBarColorOf('chart')).toBe('rgba(38, 34, 28, 0.24)'); // 图表/未知 → _default
  });
});

/* ═══ 墨条几何 ═══ */

describe('paper/ink inkForBlock', () => {
  beforeEach(() => {
    walkMock.mockClear();
    clearPaperMeasureCache();
    resetBlockIdCounterForTests();
  });

  it('来文块：逐行真实行宽 + 行原文（materialize 缩微直绘用）', () => {
    const cache = createInkCache();
    const b = block('user', { text: '一段来文' });
    b.w = 560;
    const ink = inkForBlock(b, false, cache);
    // mock 每次走查出 2 行：bars = 2，dy 依次 起笔位 / +lineHeight
    expect(ink.bars).toHaveLength(2);
    // 2026-09-20：起笔位 = 题签区高（正文在题签之下——旧实现画在块顶，实测偏高 58px）
    expect(ink.bars[0]).toMatchObject({ dy: CHROME_DERIVED.userKindH, x0: 0, text: '测试行' });
    expect(ink.bars[1]).toMatchObject({ dy: CHROME_DERIVED.userKindH + 22 * 1.65, text: '测试行' });
    expect(ink.lineH).toBe(22 * 1.65);
    expect(ink.size).toBe(22); // 来文楷体字号（缩放直绘用）——标题化放大
  });

  /* ═══ 纵向几何（2026-09-20 墨迹几何重做）═══
   * 病灶：旧实现让 ink 自己「逐源累加行高、源间零间距」，段落 margin / 列表
   * liGap / 标题 pt·pb / 引用·代码内距全部丢失，误差逐元素累积——实测一个
   * 478px 的 markdown 块越 LOD 阈时正文上移 68px。现在墨源 y 由测高走查
   * （measureMdBlocks）同趟产出，下列用例把「间距必须在场」钉死。 */
  it('markdown 段落间距在场：第二段起笔位 = 首段高 + pGap（不是紧贴）', () => {
    const cache = createInkCache();
    const b = block('markdown', { text: '第一段\n\n第二段' });
    b.w = 720;
    const ink = inkForBlock(b, false, cache);
    // 每段 2 行（walk mock）× 正文行高 34；段高走 layout mock（恒 36）
    expect(ink.bars).toHaveLength(4);
    expect(ink.bars[0].dy).toBe(0);
    expect(ink.bars[1].dy).toBe(PAPER_TYPE.body.size * PAPER_TYPE.body.lh);
    // 关键：第二段首行 = 首段高（mock 36）+ 段间距 14 —— 旧实现这里是 2×34 = 68（无间距）
    expect(ink.bars[2].dy).toBe(36 + MD_TOKENS.pGap);
  });

  it('markdown 列表缩进在场：项文字左缘 = liIndent（标记列让位）', () => {
    const cache = createInkCache();
    const b = block('markdown', { text: '- 甲\n- 乙' });
    b.w = 720;
    const ink = inkForBlock(b, false, cache);
    expect(ink.bars[0].x0).toBe(MD_TOKENS.liIndent);
  });

  it('diff 语言行 + pre 内距在场：文本起笔位在块顶之下', () => {
    const cache = createInkCache();
    const b = block('diff', { lang: 'ts', text: 'const a = 1;' });
    b.w = 720;
    const ink = inkForBlock(b, false, cache);
    expect(ink.bars[0].dy).toBe(CHROME_DERIVED.diffLangH + CHROME_TOKENS.diff.prePadV);
  });

  /* ═══ 富行内折行（2026-09-20 富行内批）═══
   * 病灶：含加粗/行内码/行内公式的段，测高走富行内度量（measureRichItemsHeight），
   * 墨迹却按纯文本走查——两者折行点可以不同（粗体更宽、行内码字号小一档还带
   * 横向 chrome）。现在墨迹对富行内源改走 walkRichInlineLineRanges 逐片段直绘，
   * 与测高**同一份 items、同一把尺子**。 */
  it('富行内：逐片段落墨（片段各自字体，非纯文本单字体）', () => {
    const cache = createInkCache();
    // 行内码触发富行内路径（mdHasRichInline 判据）
    const b = block('markdown', { text: '甲`乙`' });
    b.w = 720;
    const ink = inkForBlock(b, false, cache);
    expect(ink.bars).toHaveLength(1);
    const bar = ink.bars[0];
    expect(bar.frags).toBeDefined();
    expect(bar.frags).toHaveLength(2);
    // 片段字体：正文 = 17px 正文栈；行内码 = 17×0.82 = 13.94px（MD_CI_SIZE_RATIO）
    expect(bar.frags?.[0].font).toBe(`17px ${FONT_STACKS.song}`);
    expect(bar.frags?.[1].font).toContain(`${17 * MD_TOKENS.ciSizeRatio}px`);
    // 富行内行没有单一 text（逐片段直绘）
    expect(bar.text).toBe('');
  });

  it('富行内：片段横向位置按「前序 gapBefore + occupiedWidth」累加（行首不付 gapBefore）', () => {
    const cache = createInkCache();
    const b = block('markdown', { text: '甲`乙`' });
    b.w = 720;
    const ink = inkForBlock(b, false, cache);
    const frags = ink.bars[0].frags ?? [];
    // 桩：片段0 gapBefore 5（行首 → 归零）、occupiedWidth 40；片段1 gapBefore 5、occupiedWidth 20
    expect(frags[0].x).toBe(0);
    expect(frags[1].x).toBe(40 + 5);
    // 条宽取整行宽（materialize 的 width）
    expect(ink.bars[0].w).toBe(65);
  });

  it('纯文本段仍走纯文本通道（rich 不在场时不启用富行内走查）', () => {
    const cache = createInkCache();
    const b = block('markdown', { text: '普通段落' });
    b.w = 720;
    const ink = inkForBlock(b, false, cache);
    expect(ink.bars[0].frags).toBeUndefined();
    expect(ink.bars[0].text).toBe('测试行');
  });

  it('缓存命中：同签名二次取墨不重复走查', () => {
    const cache = createInkCache();
    const b = block('user', { text: '稳定' });
    b.w = 560;
    inkForBlock(b, false, cache);
    const calls = walkMock.mock.calls.length;
    inkForBlock(b, false, cache);
    expect(walkMock.mock.calls.length).toBe(calls);
  });

  it('折叠夹注 → 桩条（空 text 走矩形路径，单根短墨保「有物」观感）', () => {
    const cache = createInkCache();
    const b = block('reasoning', { text: '思考' });
    b.w = 720;
    const ink = inkForBlock(b, true, cache);
    expect(ink.bars).toHaveLength(1);
    expect(ink.bars[0]).toMatchObject({ dy: 0, x0: 0, text: '' });
  });

  it('脚注多源：段头行占位（输出段接在参数段 + 段头之后，不叠字）', () => {
    const cache = createInkCache();
    // args 用 JSON 字符串值：容器经 toolDisplay 摊成多行，桩「每段恒 2 行」
    // 的算术就乱了——标量值（顶层串）保住「args 2 行 + output 2 行 = 4 条」的可读账
    const b = block('tool', { toolId: 't', name: 'n', label: 'l', args: '"x"', status: 'done', output: 'out' });
    b.w = 640;
    const ink = inkForBlock(b, false, cache);
    expect(ink.bars).toHaveLength(4);
    // 2026-09-20：输出段起笔位 = 折叠行 + 参数段头 + 参数段高（layout mock 恒 36）
    // + 段头上距 + 输出段头（旧实现只累计参数段的行高，段头/上距全丢）
    expect(ink.bars[2].dy).toBe(
      CHROME_DERIVED.toolPadTop +
        LIMIT_TOKENS.foldRowH +
        CHROME_DERIVED.secHeadH +
        36 +
        CHROME_DERIVED.secHeadGap +
        CHROME_DERIVED.secHeadH,
    );
  });

  it('F1 无意义参数不进脚注：args "{}" 只剩 output 源（镜像 hasArgsToShow 判据）', () => {
    const cache = createInkCache();
    const b = block('tool', { toolId: 't', name: 'n', label: 'l', args: '{}', status: 'done', output: 'out' });
    b.w = 640;
    const ink = inkForBlock(b, false, cache);
    // 空骨架参数被砍（2026-09-01 三轴审计 F1）——仅 output（2 行）
    expect(ink.bars).toHaveLength(2);
  });

  it('签名/宽度变化 → 重算（收缩与resize 改宽必出新墨）', () => {
    const cache = createInkCache();
    const b = block('user', { text: '一段来文' });
    b.w = 560;
    inkForBlock(b, false, cache);
    const calls = walkMock.mock.calls.length;
    b.w = 400;
    inkForBlock(b, false, cache);
    expect(walkMock.mock.calls.length).toBeGreaterThan(calls);
  });
});
