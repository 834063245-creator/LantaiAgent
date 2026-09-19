// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具卡载荷可读性专项（2026-09-14，用户报「输入输出展开之后乱得要死，
// 看着跟乱码一样」）——展示变换 + 渲染面 + 测量同源的守护。
//
// 病灶（真机载荷实测）：
//   ① shell 输出带 ANSI 转义（`\u001b[0m\u001b[36mChecked 703 files\u001b[0m`）
//      → 纸面上是字面乱码；
//   ② JSON 载荷里的 Windows 路径双重转义（`"\\\\?\\D:\\ws\\a.md"`）刺眼；
//   ③ 20–30KB 单行 JSON 无结构，旧 CSS break-all 从 token 中间剁开。
// 断言按用户可见结果写：展开一张卡，看到的是干净的、分段的、有结构的内容。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// measure 依赖 Canvas 2D（jsdom 没有）→ vi.mock '@chenglou/pretext'（同款范式）
const { prepareMock, layoutMock } = vi.hoisted(() => ({
  prepareMock: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: prepareMock,
  layout: layoutMock,
  clearCache: vi.fn(),
}));

import { builtinRendererDefs } from '../src/app/paper/builtin-renderers';
import type { SourcedBlock } from '../src/paper/block-model';
import { createBlock } from '../src/paper/block-model';
import { measureBlockHeight } from '../src/paper/measure';
import { hasPayloadToShow, sanitizePayloadText, toolDisplay, toolLinesText } from '../src/paper/tool-text';

/** Windows 扩展路径真值（工具载荷里最常见的长串）。 */
const WIN_PATH = '\\\\?\\D:\\ws\\docs\\a.md';

/** 真机 shell 输出实况（ANSI + 中文摘要行）。 */
const ANSI_OUT = '[任务已完成, exit code: 0]\n\u001b[0m\u001b[36mChecked 703 files in 1697ms\u001b[0m\u001b[0m\n';

function toolBlock(payload: Record<string, unknown>): SourcedBlock {
  return createBlock('tool', { toolId: 't', name: 'shell', label: 'shell', status: 'done', ...payload } as never, {
    messageId: 'm',
    part: null,
  });
}

describe('载荷洁净化 — ANSI/控制字符（真机乱码源）', () => {
  it('ANSI 颜色/样式序列整体剔除，不留 [36m 字面', () => {
    expect(sanitizePayloadText(ANSI_OUT)).toBe('[任务已完成, exit code: 0]\nChecked 703 files in 1697ms\n');
  });

  it('OSC（窗口标题）与单字符转义、其余 C0 控制字符一并剔除；制表/换行保留', () => {
    expect(sanitizePayloadText('a\u001b]0;title\u0007b\u001b(Bc\u0007d')).toBe('abcd');
    expect(sanitizePayloadText('列1\t列2\n行')).toBe('列1\t列2\n行');
  });

  it('CR/CRLF 归一为换行（进度条覆盖写不再留残影）', () => {
    expect(sanitizePayloadText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('JSON 载荷结构化 — 真值展开 + 解转义', () => {
  it('字符串值解转义：Windows 路径单反斜杠（不再 \\\\?\\D: 满屏）', () => {
    const raw = JSON.stringify({ path: WIN_PATH, note: 'x'.repeat(80) });
    expect(raw).toContain('\\\\\\\\'); // 原始载荷：JSON 双重转义（旧观感的乱码源）
    const d = toolDisplay(raw);
    expect(d.text).toContain(`path: "${WIN_PATH}"`);
    expect(d.text).not.toContain('\\\\\\\\');
    // 结构：容器摊成花括号块，键值各一行（首行 `{`，字段缩进一级）
    expect(toolLinesText(d.lines ?? []).split('\n')[0]).toBe('{');
    expect(d.lines?.[1].level).toBe(1);
    expect(d.lines?.[1].parts[0].tone).toBe('key');
  });

  it('短容器内联成一行（不摊成无谓的括号塔）', () => {
    const d = toolDisplay(JSON.stringify({ branch: 'main', ahead: 679, files: [] }));
    expect(d.text).toBe('{ branch: "main", ahead: 679, files: [] }');
    expect(d.lines).toHaveLength(1);
  });

  it('长数组：头行带项数注记；条目形状整列一致（全短则整列一行式）', () => {
    const short = JSON.stringify({
      count: 3,
      results: Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.md`, path: `/ws/f${i}.md` })),
    });
    const dShort = toolDisplay(short);
    expect(dShort.text).toContain('results: [ 3 项');
    expect(dShort.text).toContain('    · { name: "f0.md", path: "/ws/f0.md" }');
    expect(dShort.text.split('\n').filter((l) => l.includes('· '))).toHaveLength(3);

    // 长值（超内联上限）→ 整列摊成列表体：首字段挂标记，其余字段缩进一级对齐
    const long = JSON.stringify({
      count: 2,
      results: Array.from({ length: 2 }, (_, i) => ({ name: `f${i}.md`, path: `${WIN_PATH}${'x'.repeat(80)}${i}` })),
    });
    const dLong = toolDisplay(long);
    expect(dLong.text).toContain(`    · name: "f0.md"\n      path: "${WIN_PATH}${'x'.repeat(80)}0"`);
    // 同列条目形状一致（一行式/多行式混排是最刺眼的杂乱源）
    const markers = dLong.text.split('\n').filter((l) => l.includes('· '));
    expect(markers).toHaveLength(2);
    expect(markers.every((l) => l.trimStart().startsWith('· name: "'))).toBe(true);
  });

  it('标量数组头行 + 逐项列表；短标量数组内联', () => {
    expect(toolDisplay(JSON.stringify(['a', 'b'])).text).toBe('["a", "b"]');
    const many = toolDisplay(JSON.stringify(Array.from({ length: 12 }, (_, i) => `item-${i}`)));
    expect(many.text).toContain('[ 12 项');
    expect(many.text).toContain('  · "item-0"');
  });

  it('数字/布尔/null 原样字面量（不当作字符串），键名保持', () => {
    const d = toolDisplay(JSON.stringify({ n: 1, t: true, z: null }));
    expect(d.text).toBe('{ n: 1, t: true, z: null }');
    // 着色面：键/数字字面量/结构符分离（空白为 plain）
    const tones = (d.lines?.[0].parts ?? []).map((p) => p.tone).filter((t) => t !== 'plain');
    expect(tones).toEqual(['punct', 'key', 'num', 'punct', 'key', 'num', 'punct', 'key', 'num', 'punct']);
  });

  it('展示文本 = 行的逐字投影（测量/墨迹消费同一文本）', () => {
    const d = toolDisplay(JSON.stringify({ a: { b: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, c: 'x' }));
    expect(d.text).toBe(toolLinesText(d.lines ?? []));
    expect(d.text.split('\n')).toHaveLength(d.lines?.length ?? -1);
  });

  it('超行数上限：截断 + 注记（不静默丢信息）', () => {
    const raw = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ i, name: `n${i}` })) });
    const d = toolDisplay(raw);
    expect(d.text).toContain('行未展开（共');
    expect(d.lines?.length).toBe(401); // 400 行 + 注记行
  });
});

describe('纯文本与混合载荷 — 内容不丢', () => {
  it('非 JSON 载荷不结构化（lines=null，渲染层直出全文）', () => {
    const d = toolDisplay('const a = 1;\nconsole.log(a);');
    expect(d.lines).toBeNull();
    expect(d.text).toBe('const a = 1;\nconsole.log(a);');
  });

  it('混合载荷：长 JSON 行展开成结构块，其余行原样保留', () => {
    const log = JSON.stringify({
      ts: '2026-09-10T18:55:25Z',
      level: 'info',
      ctx: { msgs: 250, note: 'x'.repeat(120) },
    });
    const d = toolDisplay(`=== 日志尾部 ===\n${log}\n尾注一行`);
    expect(d.lines).not.toBeNull();
    expect(d.text).toContain('=== 日志尾部 ===');
    expect(d.text).toContain('  ts: "2026-09-10T18:55:25Z"');
    expect(d.text).toContain('尾注一行');
  });

  it('大载荷里的个别 JSON 行不连坐截断：展开超限即回落纯文本（全文保住）', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const log = JSON.stringify({ a: 1, b: 'y'.repeat(200) });
    const d = toolDisplay(`${big}\n${log}`);
    expect(d.lines).toBeNull();
    expect(d.text.split('\n')).toHaveLength(501);
  });

  it('空白载荷判据：渲染端不支起空段头（渲染/测量同判据）', () => {
    expect(hasPayloadToShow('')).toBe(false);
    expect(hasPayloadToShow('   \n\t ')).toBe(false);
    expect(hasPayloadToShow('\u001b[0m\u001b[36m\u001b[0m')).toBe(false); // 纯转义的「有内容」假象
    expect(hasPayloadToShow('x')).toBe(true);
  });
});

describe('字符串载荷解开 — 程文/工具输出的双层编码（2026-09-19）', () => {
  it('整段是 JSON 字符串字面量：解开为文本本体（真换行回来，转义乱码消失）', () => {
    const ls = 'ls -la .lantai\ntotal 129385\n-rw-r--r-- 1 x 37882346 audit.jsonl';
    const raw = JSON.stringify(ls); // 真机形态：完成值经二次编码，40 行塌成一行
    expect(raw).toContain('\\n');
    const d = toolDisplay(raw);
    expect(d.text).toBe(ls);
    expect(d.text.split('\n')).toHaveLength(3);
  });

  it('解开后是 JSON 容器：走结构化打印（键值行 + 四档墨，不是满屏反斜杠）', () => {
    const win = String.raw`\\?\D:\ws\a.md`;
    const payload = JSON.stringify({ files: [win], count: 2, note: 'x'.repeat(80) });
    const d = toolDisplay(JSON.stringify(payload)); // 双层：字符串里套 JSON 文本
    expect(d.lines).not.toBeNull();
    expect(d.text).toContain('count: 2');
    expect(d.text).toContain(`"${win}"`); // 单反斜杠真值（路径本体的 \\?\ 打头照旧）
    expect(d.text).not.toContain(String.raw`\\\\?`); // 四反斜杠 = 旧的双重转义形态
  });

  it('解开层数封顶：套娃两层解开，超过封顶原样直出（不递归爆）', () => {
    const inner = JSON.stringify({ a: 1, b: 'y'.repeat(80) });
    expect(toolDisplay(JSON.stringify(inner)).text).toContain('a: 1'); // 字符串套 JSON 文本 → 结构化
    const deep = JSON.stringify(JSON.stringify(JSON.stringify(inner)));
    const d = toolDisplay(deep);
    expect(d.text).not.toContain('a: 1');
    expect(d.text).toContain('\\"a\\"'); // 超限即原样（仍是编码形态，不炸不空）
  });

  it('短引号串照常解（`"ok"` → ok）；非字符串 JSON 不误解', () => {
    expect(toolDisplay('"ok"').text).toBe('ok');
    expect(toolDisplay('"unterminated').text).toBe('"unterminated');
    expect(toolDisplay('123').text).toBe('123');
  });

  it('混合载荷里的长字符串字面量行：解开成容器再展开', () => {
    const inner = JSON.stringify({ ts: '2026-09-19T00:00:00Z', note: 'z'.repeat(120) });
    const d = toolDisplay(`=== 日志尾部 ===\n${JSON.stringify(inner)}\n尾注一行`);
    expect(d.lines).not.toBeNull();
    expect(d.text).toContain('=== 日志尾部 ===');
    expect(d.text).toContain('note: "');
    expect(d.text).toContain('尾注一行');
  });
});

describe('截断 JSON 的尽力结构打印（2026-09-19）', () => {
  /** 真机形态：模型自己 `JSON.stringify(x).slice(0, N)`——整段 parse 必然失败。 */
  const truncJson = (n: number): string =>
    `{"pattern":"image_url","count":3,"scanned_files":1,"results":[{"file":"${WIN_PATH}","line":10},{"file":"b.ts","line":20}],"tail":"${'z'.repeat(n)}`;

  it('截断的容器：按串外定界符摊行（parse 失败也读出结构）', () => {
    const d = toolDisplay(truncJson(200));
    expect(d.lines).not.toBeNull();
    expect(d.text).toContain('"pattern":"image_url",');
    expect(d.text.split('\n').length).toBeGreaterThan(4);
  });

  it('串内一字不改：长值不被腰斩，只有空白被插进结构位', () => {
    const d = toolDisplay(truncJson(200));
    // 所有非空白字符原样保留（只动空白 = 可逆）
    const strip = (s: string): string => s.replace(/\s+/g, '');
    expect(strip(d.text)).toBe(strip(truncJson(200)));
  });

  it('不像 JSON 的长行不动（shell 行不误判）', () => {
    const shell = `[任务已完成, exit code: 0] ${'x'.repeat(200)}, 后面还有一段说明`;
    expect(toolDisplay(shell).lines).toBeNull();
    const prose = `[INFO] build ok, 3 files changed, ${'y'.repeat(200)}`;
    expect(toolDisplay(prose).lines).toBeNull();
  });

  it('长 token 里的字面转义还原成真行（截断的编码串没有闭合引号）', () => {
    const doc = ['# 契约', '', '> 生成物勿手改', '', '## 工具面', '- browser', '- fs', `- ${'p'.repeat(120)}`].join(
      '\\n',
    );
    const d = toolDisplay(`{"len":45313,"head":"${doc}","tail":"${'q'.repeat(300)}`);
    const lines = d.text.split('\n');
    expect(lines.some((l) => l.trim() === '> 生成物勿手改')).toBe(true);
    expect(lines.some((l) => l.trim() === '- browser')).toBe(true);
    expect(lines.some((l) => l.trim() === '"len":45313,')).toBe(true);
  });

  it('短转义值照旧内联（不为拆而拆）', () => {
    const d = toolDisplay(`{"count":2,"note":"a\\nb\\nc","pad":"${'x'.repeat(140)}"}`);
    expect(d.text).toContain('"a\\nb\\nc"');
  });

  it('值级块引：键下的多行文档摊成真行（不是一行转义串）', () => {
    const doc = `# 标题\n\n正文第一段\n正文第二段\n${'x'.repeat(140)}`;
    const d = toolDisplay(JSON.stringify({ len: 45313, head: doc }));
    expect(d.text).toContain('head: │');
    expect(d.text.split('\n').filter((l) => l.includes('正文'))).toHaveLength(2);
  });
});

describe('渲染面 — 分段 + 着色 + 折叠', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  const renderTool = (payload: Record<string, unknown>) => {
    const def = builtinRendererDefs().find((d) => d.kind === 'tool');
    expect(def, '内置 tool 渲染器存在').toBeDefined();
    act(() => {
      root?.render(createElement(def!.component, { block: toolBlock(payload) }));
    });
  };

  it('参数/输出/错误三段各有段头，段类承载语义（错误段走 pp-sec--err + pp-out--err）', () => {
    renderTool({
      args: JSON.stringify({ action: 'output', jobId: 10 }),
      output: 'done',
      err: 'boom',
    });
    const labels = [...container!.querySelectorAll('.pp-sec-label')].map((el) => el.textContent);
    expect(labels).toEqual(['参数', '输出', '错误']);
    // 参数=石青直排盒；输出/错误=滚动盒（错误墨归 CSS 段类——渲染端无 inline style）
    expect(container!.querySelector('.pp-sec .pp-args')?.textContent).toContain('action: "output"');
    const outs = container!.querySelectorAll('.pp-out');
    expect(outs).toHaveLength(2);
    expect(outs[1].className).toContain('pp-out--err');
    // 段类挂在段上（段头染色的挂点：参数段石青 / 输出段中性 / 错误段 --fail）
    expect(container!.querySelector('.pp-args')?.closest('.pp-sec')?.className).toContain('pp-sec--args');
    expect(outs[0].closest('.pp-sec')?.className).toContain('pp-sec--out');
    expect(outs[1].closest('.pp-sec')?.className).toContain('pp-sec--err');
  });

  it('结构化行渲染出分色片段（键/字符串/数字/结构符）', () => {
    renderTool({ args: '', output: JSON.stringify({ path: WIN_PATH, n: 3, ok: true }) });
    expect(container!.querySelector('.pp-tv-k')?.textContent).toBe('path: ');
    expect(container!.querySelector('.pp-tv-s')?.textContent).toBe(`"${WIN_PATH}"`); // 单反斜杠真值
    expect([...container!.querySelectorAll('.pp-tv-n')].map((el) => el.textContent)).toEqual(['3', 'true']);
    expect(container!.querySelector('.pp-tv-p')?.textContent).toBe('{');
  });

  it('ANSI 不进 DOM：展开 shell 卡看到的是干净输出', () => {
    renderTool({ args: '', output: ANSI_OUT });
    const out = container!.querySelector('.pp-out')?.textContent ?? '';
    expect(out).toContain('Checked 703 files in 1697ms');
    expect(out.includes('\u001b')).toBe(false);
    expect(out.includes('[36m')).toBe(false);
  });

  it('空白输出不支起空段头（只画参数段）', () => {
    renderTool({ args: JSON.stringify({ a: 1 }), output: '   \n' });
    const labels = [...container!.querySelectorAll('.pp-sec-label')].map((el) => el.textContent);
    expect(labels).toEqual(['参数']);
  });

  it('折叠态：体全收（折叠行即本体）', () => {
    const def = builtinRendererDefs().find((d) => d.kind === 'tool');
    act(() => {
      root?.render(
        createElement(def!.component, {
          block: toolBlock({ args: JSON.stringify({ a: 1 }), output: 'x' }),
          folded: true,
        }),
      );
    });
    expect(container!.querySelector('.pp-sec')).toBeNull();
  });
});

describe('测量镜像 — 测高消费展示文本（渲染/测量同源）', () => {
  it('pretext 收到的是展示文本而非原始 JSON 串', () => {
    prepareMock.mockClear();
    measureBlockHeight(toolBlock({ args: JSON.stringify({ path: WIN_PATH }), status: 'done' }), false);
    const seen = prepareMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(seen).toContain(`path: "${WIN_PATH}"`);
    expect(seen).not.toContain('\\\\\\\\');
  });
});
