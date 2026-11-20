// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper-fence — 围栏标记判据（CommonMark 4.5）与它在三处消费方的行为面。
//
// 病灶（2026-11-19 实地会话）：模型用**四反引号**包一层演示三反引号 mermaid——旧实现把
// 正好三个反引号当围栏，多出的那个进了语言签、内层三反引号 mermaid 被当成闭围栏，
// 纸面上于是出现「抄录·语言行反引号 text」「正文块里排 flowchart」「空白抄录块」三连。
// 本套锁死四条纪律：
//   1 开围栏 = 3 个及以上**同种**字符；闭围栏须同种且**不短于**；
//   2 转译层按原标记回吐（不是一律三个反引号）；
//   3 行内码须**等长**反引号串闭合；
//   4 三处消费方（转译 / 块级解析 / 查看器分段）判据同源——同一份输入给出同一结论。

import { describe, expect, it } from 'vitest';
import { fenceCloseOf, fenceMarkOf, fenceOpenOf, reemitFence } from '../src/paper/fence';
import { parseInline, parseMarkdown } from '../src/paper/markdown';
import { splitFencedSegments, translateMessages } from '../src/paper/translate';
import { splitMarkdownSections } from '../src/plugins/builtin/renderers/viewers/markdown-doc';
import type { AssistantMessage } from '../src/ui/message-model';

const BT = '`';
const THREE = BT.repeat(3);
const FOUR = BT.repeat(4);

/** 现场原文（会话 142 第 16 条消息的病灶段，逐字复刻）。 */
const DEMO_BODY = [
  '帮我画个图：',
  THREE + 'mermaid',
  'flowchart LR',
  '  A[用户提问] --> B{需要工具?}',
  '  B -- 是 --> C[调用工具]',
  THREE,
].join('\n');
const DEMO = FOUR + 'text\n' + DEMO_BODY + '\n' + FOUR;

function textMsg(text: string): AssistantMessage {
  return {
    role: 'assistant',
    _id: 'a1',
    status: 'done',
    respondingTo: 'u1',
    parts: [{ type: 'text', text, finalised: true }],
  } as AssistantMessage;
}

describe('paper/fence — 标记判据（CommonMark 4.5）', () => {
  it('开围栏：3 个及以上同种字符，语言取信息串首词', () => {
    expect(fenceOpenOf(THREE + 'ts')).toEqual({ mark: { char: BT, len: 3 }, lang: 'ts', info: 'ts' });
    expect(fenceOpenOf(FOUR + 'text')).toEqual({ mark: { char: BT, len: 4 }, lang: 'text', info: 'text' });
    expect(fenceOpenOf('~~~mermaid')).toEqual({ mark: { char: '~', len: 3 }, lang: 'mermaid', info: 'mermaid' });
    // 裸围栏：有标记无语言
    expect(fenceOpenOf(THREE)).toEqual({ mark: { char: BT, len: 3 } });
    // 信息串原文留着（回吐时还原；语言只取首词）
    expect(fenceOpenOf(THREE + 'ts startLine=3')).toMatchObject({ lang: 'ts', info: 'ts startLine=3' });
  });

  it('反引号围栏的信息串不得含反引号（这正是「外层必须更长」的由来）', () => {
    expect(fenceOpenOf(THREE + 'a' + BT + 'b')).toBeUndefined();
    // 波浪线无此限
    expect(fenceOpenOf('~~~a' + BT + 'b')).toMatchObject({ mark: { char: '~' }, info: 'a' + BT + 'b' });
  });

  it('闭围栏：同种字符 + 不短于 + 其后只剩空白', () => {
    const three = { char: BT, len: 3 } as const;
    expect(fenceCloseOf(THREE, three)).toBe(true);
    expect(fenceCloseOf(FOUR, three)).toBe(true); // 长于开围栏也闭合
    expect(fenceCloseOf(THREE + '   ', three)).toBe(true); // 行尾空白不算内容
    expect(fenceCloseOf('~~~', three)).toBe(false); // 异种字符
    expect(fenceCloseOf(THREE + 'mermaid', three)).toBe(false); // 带信息串 = 围栏体的一行
    expect(fenceCloseOf(BT + BT, three)).toBe(false); // 短于开围栏
  });

  it('行判据 fenceMarkOf 只认字符与长度（够不够长由闭合判据比）', () => {
    expect(fenceMarkOf(THREE)).toEqual({ char: BT, len: 3 });
    expect(fenceMarkOf('~~~~')).toEqual({ char: '~', len: 4 });
    expect(fenceMarkOf('~~ 太短')).toBeUndefined();
    expect(fenceMarkOf('正文')).toBeUndefined();
  });

  it('回吐：按原标记还原（四反引号不会缩成三个）', () => {
    const mark = fenceOpenOf(FOUR + 'text')?.mark;
    expect(mark).toBeDefined();
    if (mark === undefined) throw new Error('mark 应存在');
    expect(reemitFence(mark, 'text', ['a', THREE])).toBe(FOUR + 'text\na\n' + THREE + '\n' + FOUR);
  });
});

describe('paper/fence — 转译层：病灶现场不再劈块', () => {
  it('四反引号外层 + 内层 mermaid：整段是一个抄录块，语言 = text', () => {
    // 旧行为（病灶）：三块——语言为反引号 text 的抄录 + flowchart 正文 + 空抄录
    expect(splitFencedSegments(DEMO)).toEqual([{ kind: 'diff', text: DEMO_BODY, lang: 'text' }]);
  });

  it('转译全链：病灶消息只产出一个抄录块（无空块、无混进正文的 flowchart）', () => {
    const blocks = translateMessages([textMsg(DEMO)]);
    expect(blocks.map((b) => b.kind)).toEqual(['diff']);
    expect(blocks[0].payload).toMatchObject({ lang: 'text' });
    expect((blocks[0].payload as { text: string }).text).toContain(THREE + 'mermaid');
  });

  it('四反引号 mermaid 仍走 markdown（摘图链路不被围栏长度挡住）', () => {
    const text = [FOUR + 'mermaid', 'graph TD; A-->B;', FOUR].join('\n');
    const segs = splitFencedSegments(text);
    expect(segs).toEqual([{ kind: 'markdown', text }]);
    // 回吐的是原标记（四个），故 parseMarkdown 照常收成 lang=mermaid 的代码块
    expect(parseMarkdown(segs[0].text)).toEqual([{ t: 'code', lang: 'mermaid', text: 'graph TD; A-->B;' }]);
  });

  it('波浪线外层包反引号围栏：外层不被内层反引号截断', () => {
    const inner = [THREE + 'ts', 'const a = 1;', THREE].join('\n');
    const text = ['~~~markdown', inner, '~~~'].join('\n');
    expect(splitFencedSegments(text)).toEqual([{ kind: 'diff', text: inner, lang: 'markdown' }]);
  });

  it('流式未闭合：照常产出块（差分块随 token 生长）', () => {
    expect(splitFencedSegments('前文\n' + THREE + 'diff\n+ 一行')).toEqual([
      { kind: 'markdown', text: '前文' },
      { kind: 'diff', text: '+ 一行', lang: 'diff' },
    ]);
  });
});

describe('paper/fence — 块级解析：与转译层同源', () => {
  it('四反引号围栏收成一个代码块（长度与语言都对）', () => {
    expect(parseMarkdown(DEMO)).toEqual([{ t: 'code', lang: 'text', text: DEMO_BODY }]);
  });

  it('闭围栏短于开围栏 = 围栏体的一行，真闭围栏在下一行', () => {
    const text = [FOUR, THREE, 'x', FOUR].join('\n');
    expect(parseMarkdown(text)).toEqual([{ t: 'code', lang: undefined, text: [THREE, 'x'].join('\n') }]);
  });

  it('未见过的闭合串（三反引号 + mermaid）不是闭围栏：其后内容仍属同一块', () => {
    const text = [FOUR + 'text', THREE + 'mermaid', 'graph TD', FOUR].join('\n');
    expect(parseMarkdown(text)).toEqual([
      { t: 'code', lang: 'text', text: [THREE + 'mermaid', 'graph TD'].join('\n') },
    ]);
  });
});

describe('paper/fence — 行内码：等长反引号串才闭合（CommonMark 6.1）', () => {
  it('单反引号包住一个围栏标记（现场原文的写法）', () => {
    const line = '只要回复里写 ' + BT + ' ' + THREE + 'mermaid ' + BT + ' 围栏代码块';
    expect(parseInline(line)).toEqual([
      { text: '只要回复里写 ' },
      { text: THREE + 'mermaid', c: true },
      { text: ' 围栏代码块' },
    ]);
  });

  it('双反引号包住内容里的单反引号；三连与单连各成各的', () => {
    expect(parseInline('用 ' + BT + BT + 'code' + BT + BT + ' 与 ' + BT + 'a' + BT)).toEqual([
      { text: '用 ' },
      { text: 'code', c: true },
      { text: ' 与 ' },
      { text: 'a', c: true },
    ]);
    expect(parseInline(THREE + 'mermaid' + THREE)).toEqual([{ text: 'mermaid', c: true }]);
  });

  it('落单反引号按字面留着（流式容忍，不吞字）', () => {
    expect(parseInline('裸 ' + BT + ' 落单')).toEqual([{ text: '裸 ' + BT + ' 落单' }]);
  });
});

describe('paper/fence — 查看器分段：同一份判据', () => {
  it('四反引号围栏里的伪标题不进标题树', () => {
    const doc = [FOUR + 'text', '# 伪标题', FOUR, '', '# 真标题'].join('\n');
    const sections = splitMarkdownSections(doc);
    expect(sections.map((s) => s.title)).toEqual(['', '真标题']);
    // 伪标题那一行留在第一节正文里（围栏体原样），没被切成新段
    expect(sections[0].text).toContain('# 伪标题');
  });
});
