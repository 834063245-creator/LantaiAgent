// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩简报的**产出面**（2026-11-26）——补两处：转录稿要看得到思考、标题表要有「死路」。
//
// 背景（用户判断 + NVIDA《You don't need long context》arXiv:2611.05306 的六段模板）：
// agent 的工作产物里，工具结果是**可再造**的（文件、命令都能重跑），正文多半是给人看的
// 结论，唯独「想过什么、否掉了什么」只存在于思考里。旧转录稿整段丢弃思考 ⇒ 回放够不到
// 时（会话被替换 / 含附图 / 装不下预算）摘要的「决策与理由」「死路」是盲写的。
// 而「死路」是唯一**无法从工具结果重建**的信息：失败过的尝试在磁盘上不留痕迹。

import { describe, expect, it } from 'vitest';
import {
  buildCompactionInstruction,
  buildMergePrompt,
  buildSummaryPrompt,
  renderTranscript,
} from '../src/plugins/builtin/compaction/compaction-summarize';

/** 一条再普通不过的 agent 轮次：先想、再说话、再调工具。 */
function turn(reasoning: string | undefined) {
  return [
    {
      role: 'assistant' as const,
      ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
      content: '先看这个文件',
      tool_calls: [{ id: 't1', name: 'fs', arguments: '{"action":"read"}' }],
    },
    { role: 'tool' as const, tool_call_id: 't1', name: 'fs', content: '文件正文' },
  ];
}

describe('转录稿：思考必须进摘要的输入', () => {
  it('思考出现在转录里，且排在正文之前（先想、再说）', () => {
    const t = renderTranscript(turn('我怀疑是缓存没失效，先读文件确认') as any);
    expect(t).toContain('[助手思考]');
    expect(t).toContain('我怀疑是缓存没失效');
    expect(t.indexOf('我怀疑是缓存没失效')).toBeLessThan(t.indexOf('先看这个文件'));
  });

  it('没有思考的轮次不产生空标签（不编造空串）', () => {
    const t = renderTranscript(turn(undefined) as any);
    expect(t).not.toContain('[助手思考]');
    expect(t).toContain('先看这个文件');
  });

  it('工具往返仍在（思考进来不等于工具结果出去）', () => {
    const t = renderTranscript(turn('理由') as any);
    expect(t).toContain('[助手调用 fs]');
    expect(t).toContain('[工具 fs 结果]');
    expect(t).toContain('文件正文');
  });
});

describe('简报标题表：三条生成路径同一份', () => {
  const briefs: Array<[string, string]> = [
    ['回放口径（主路径）', buildCompactionInstruction()],
    ['回放口径（分块时）', buildCompactionInstruction({ index: 2, total: 3 })],
    ['转录口径（回退）', buildSummaryPrompt(null)],
    ['分块合并', buildMergePrompt()],
  ];

  it('每条路径都要求写「死路」——失败过的尝试在文件里不留痕迹', () => {
    for (const [name, text] of briefs) expect(text, name).toContain('## 死路');
  });

  it('每条路径都要区分「已验证」与「推断」', () => {
    for (const [name, text] of briefs) {
      expect(text, name).toContain('## 验证与故障');
      expect(text, name).toContain('推断：');
    }
  });

  it('标题集合逐字一致（改一处不会漏另外两处）', () => {
    const headings = (t: string) => (t.match(/^## .+$/gm) ?? []).join('|');
    const base = headings(buildCompactionInstruction());
    for (const [name, text] of briefs) expect(headings(text), name).toBe(base);
  });

  it('顺序：验证 → 死路 → 待办（越靠后越要写下一步）', () => {
    const t = buildSummaryPrompt(null);
    expect(t.indexOf('## 验证与故障')).toBeLessThan(t.indexOf('## 死路'));
    expect(t.indexOf('## 死路')).toBeLessThan(t.indexOf('## 待办与下一步'));
  });
});
