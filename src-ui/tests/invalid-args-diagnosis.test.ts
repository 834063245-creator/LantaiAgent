// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具参数 JSON 坏 —— 报错要**指名病灶**，不是只给通用成因。
//
// 真机事故（2026-11-18 ~ 11-20，9 次）：模型要发两条工具调用，却把两个完整对象
// 首尾相接塞进**一个** tool_calls 元素的 arguments。旧报错只说「少/多一个 }、尾随
// 逗号，补齐后重发」——括号根本不缺，模型照着这句逐字节重发三次（会话 130:180-185），
// 直到 loop guard 把它拽回来。本文件钉住：这种形态必须被认出来并给出正确改法。
//
// 判据形态：读的是工具结果的 output（模型看得见的那段话），不是内部实现。

import { describe, expect, it } from 'vitest';
import {
  describeConcatenatedCalls,
  invalidArgsErrorText,
  StreamingToolExecutor,
} from '../src/agent/streaming-executor';
import { type Tool, ToolRegistry } from '../src/agent/tool';

function stubTool(executed: string[]): Tool {
  return {
    name: () => 'shell',
    description: () => 'shell domain',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    domain: () => 'shell',
    actions: () => ['run'],
    readOnlyActions: () => [],
    execute: async () => {
      executed.push('run');
      return 'ok';
    },
  };
}

/** 真机原文（会话 145:1439 逐字节）——两条 shell run 粘在一起。 */
const REAL_WORLD =
  '{"action": "run", "command": "cd /d/HoloGramHG && sed -n 1,40p .github/workflows/engine-preflight.yml"}' +
  '{"action": "run", "command": "cd /d/HoloGramHG && git log --oneline --grep=\\"chore(release)\\" -3; echo \\"=== tags ===\\"; git tag --sort=-creatordate | head -5"}';

function parseError(raw: string): unknown {
  try {
    JSON.parse(raw);
    return null;
  } catch (e) {
    return e;
  }
}

describe('describeConcatenatedCalls — 认出「几条调用首尾相接」', () => {
  it('真机形态：两条 shell 调用粘连 → 报 2 条 + 可读的头一条', () => {
    const text = describeConcatenatedCalls(REAL_WORLD);
    expect(text).not.toBeNull();
    expect(text).toContain('2 条调用首尾相接');
    // 头一条的节选（60 字符封顶）足以让模型认出「是我写的第一条」
    expect(text).toContain('"action": "run"');
    expect(text).toContain('cd /d/HoloGramHG');
    expect(text).toContain('改法');
  });

  it('三条也算', () => {
    const text = describeConcatenatedCalls('{"a":1}{"b":2}{"c":3}');
    expect(text).toContain('3 条调用首尾相接');
  });

  it('参数里带 } 的字符串不骗扫（写代码时遍地都是）', () => {
    const text = describeConcatenatedCalls(
      '{"action":"edit","newString":"if (a) { b(); } // } 假的"}{"action":"read","path":"x"}',
    );
    expect(text).toContain('2 条调用首尾相接');
  });

  it('只是普通损坏（括号没配平）→ 不认作粘连', () => {
    expect(describeConcatenatedCalls('{"kind": "table", "payload": {"rows": [[1]], "title": "x"}')).toBeNull();
    expect(describeConcatenatedCalls('{invalid')).toBeNull();
    expect(describeConcatenatedCalls('{"a": 1, }')).toBeNull();
  });

  it('单个合法对象不误报', () => {
    expect(describeConcatenatedCalls('{"action":"run","command":"ls"}')).toBeNull();
  });
});

describe('invalidArgsErrorText — 粘连时给对改法，不 generic 猜括号', () => {
  it('认作粘连：说「不是括号的问题」，并把四条改法写清', () => {
    const text = invalidArgsErrorText(REAL_WORLD, parseError(REAL_WORLD));
    expect(text).toContain('error: invalid JSON arguments');
    expect(text).toContain('不是括号或逗号的问题');
    expect(text).toContain('2 条调用首尾相接');
    expect(text).toContain('tool_calls 数组里的两个元素');
    // 通用成因句在这条路径上是反向指引，必须不出现
    expect(text).not.toContain('常见成因');
  });

  it('普通损坏：通用成因照旧', () => {
    const raw = '{"a": 1, }';
    const text = invalidArgsErrorText(raw, parseError(raw));
    expect(text).toContain('常见成因');
    expect(text).not.toContain('首尾相接');
  });
});

describe('执行器实路 — 粘连参数不执行副作用，回给模型的是定向报错', () => {
  it('addTool 后拿到的 output 是「首尾相接」诊断，且工具没被执行', async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(stubTool(executed));
    const executor = new StreamingToolExecutor(registry, () => {}, null, null, null);
    executor.addTool({ id: 'call_01_kanji', name: 'shell', arguments: REAL_WORLD });
    const results = await executor.awaitRemaining();

    expect(results).toHaveLength(1);
    expect(results[0].err).toBe('invalid JSON arguments');
    expect(results[0].output).toContain('2 条调用首尾相接');
    expect(executed).toEqual([]);
  });
});
