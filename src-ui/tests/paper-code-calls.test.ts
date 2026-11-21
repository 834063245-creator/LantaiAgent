// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 程序内调用显形批（2026-11-21）——四段链路的钉子：
//   ① 宿主旁路：runCode 的 onDispatch 逐笔给 name/action/ok/summary（顺序 = 落定序）
//   ② 线格式：code_execution 把它转成 onProgress 的标记行，不污染结果信封
//   ③ 分流：part-mutator 把标记行落进 part.calls（绝不拼进 output）
//   ④ 纸面投影：行文本 / 上限注记 / 折读，渲染与测高同一份
import { describe, expect, it } from 'vitest';
import { EventKind } from '../src/agent/agent-types';
import { evalBootstrapSource, WORKER_BOOTSTRAP_SOURCE } from '../src/agent/code-run/bootstrap';
import { CODE_CALL_MARK, createCodeExecutionTool } from '../src/agent/code-run/code-execution-tool';
import {
  type CodeBindingSpec,
  type CodeDispatchRecord,
  type CodeWorkerLike,
  runCode,
} from '../src/agent/code-run/host';
import { CODE_CALL_SHOW_CAP, codeCallLine, codeCallLines, codeCallsReadout } from '../src/paper/code-calls';
import type { AssistantPart } from '../src/ui/message-model';
import { applyEventToParts } from '../src/ui/part-mutator';

/** fake worker（同 code-execution.test.ts 的最小形态）。 */
function makeFakeWorker(): CodeWorkerLike {
  const worker: CodeWorkerLike = {
    postMessage: () => {},
    terminate: () => {},
    onmessage: null,
    onerror: null,
  };
  const port = evalBootstrapSource(WORKER_BOOTSTRAP_SOURCE, (out) => {
    queueMicrotask(() => worker.onmessage?.({ data: out }));
  });
  worker.postMessage = (msg: unknown) => {
    queueMicrotask(() => port.post(msg));
  };
  return worker;
}

function binding(name: string, invoke: CodeBindingSpec['invoke'], readOnly = true): CodeBindingSpec {
  return { name, readOnly, invoke };
}

describe('① 宿主旁路 onDispatch', () => {
  it('逐笔落定：name / action / ok / summary，序 = 落定序', async () => {
    const got: CodeDispatchRecord[] = [];
    const result = await runCode(
      `const [a, b] = await Promise.all([
         tools.fs({action:'read', filePath:'a.ts'}),
         tools.shell({action:'run', command:'x'}),
       ]);
       await tools.fs({action:'write', filePath:'b.ts'}).catch(() => {});
       return 'ok';`,
      {
        createWorker: makeFakeWorker,
        onDispatch: (d) => got.push(d),
        bindings: [
          binding('fs', async (args) =>
            args.action === 'write'
              ? { output: 'EACCES: denied', isError: true }
              : { output: 'line one\nline two', isError: false },
          ),
          binding('shell', async () => ({ output: 'exit 0', isError: false })),
        ],
      },
    );
    expect(result.error).toBeUndefined();
    // 三笔都落定；序是落定序（Promise.all 两条读并行，先后不保证 ⇒ 只钉集合与序号）
    expect(got).toHaveLength(3);
    expect(got.map((d) => d.seq).sort()).toEqual([1, 2, 3]);
    const fsRead = got.find((d) => d.name === 'fs' && d.action === 'read');
    expect(fsRead).toMatchObject({ ok: true, summary: 'line one' });
    const shell = got.find((d) => d.name === 'shell');
    expect(shell).toMatchObject({ action: 'run', ok: true });
    const failed = got.find((d) => !d.ok);
    expect(failed).toMatchObject({ name: 'fs', action: 'write', ok: false });
    expect(failed?.summary).toContain('EACCES');
  });

  it('旁路抛错不阻断程序（展示面故障 ≠ 执行失败）', async () => {
    const result = await runCode('return 1+1;', {
      createWorker: makeFakeWorker,
      onDispatch: () => {
        throw new Error('ui boom');
      },
      bindings: [binding('fs', async () => ({ output: 'x', isError: false }))],
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('2');
  });
});

describe('② 线格式：标记行不污染结果信封', () => {
  it('code_execution 把每一笔转成 onProgress 标记行；结果文本里没有标记', async () => {
    const chunks: string[] = [];
    const tool = createCodeExecutionTool({
      bindings: [binding('fs', async () => ({ output: 'hello', isError: false }))],
      createWorker: makeFakeWorker,
    });
    const out = await tool.execute({ code: "await tools.fs({action:'read'}); return 'done';", description: 'x' }, (c) =>
      chunks.push(c),
    );
    expect(out).toBe('── result ──\ndone');
    expect(out).not.toContain(CODE_CALL_MARK);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startsWith(CODE_CALL_MARK)).toBe(true);
    expect(JSON.parse(chunks[0]!.slice(CODE_CALL_MARK.length))).toMatchObject({ name: 'fs', ok: true });
  });
});

describe('③ 分流：标记行进 part.calls，不进 output', () => {
  function progressPart(): AssistantPart[] {
    const parts: AssistantPart[] = [];
    applyEventToParts(parts, {
      kind: EventKind.ToolDispatch,
      tool: { id: 'c1', name: 'code_execution', args: '{}', read_only: false, partial: false },
    } as never);
    return parts;
  }

  it('逐条落进 calls；output 保持空（等 ToolResult 覆盖）', () => {
    const parts = progressPart();
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: {
        id: 'c1',
        name: 'code_execution',
        args: '',
        read_only: false,
        partial: false,
        output: `${CODE_CALL_MARK}${JSON.stringify({ seq: 1, name: 'fs', action: 'read', ok: true, summary: 'a.ts' })}`,
      },
    } as never);
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: {
        id: 'c1',
        name: 'code_execution',
        args: '',
        read_only: false,
        partial: false,
        output: `${CODE_CALL_MARK}${JSON.stringify({ seq: 2, name: 'shell', ok: false, summary: 'boom' })}`,
      },
    } as never);
    const part = parts[0];
    expect(part?.type).toBe('tool');
    const calls = part?.type === 'tool' ? part.calls : undefined;
    expect(calls).toEqual([
      { seq: 1, name: 'fs', action: 'read', ok: true, summary: 'a.ts' },
      { seq: 2, name: 'shell', ok: false, summary: 'boom' },
    ]);
    expect(part?.type === 'tool' ? part.output : 'x').toBeUndefined();

    // ToolResult 之后 output 才是权威正文；calls 不被覆盖
    applyEventToParts(parts, {
      kind: EventKind.ToolResult,
      tool: {
        id: 'c1',
        name: 'code_execution',
        args: '',
        read_only: false,
        partial: false,
        output: '── result ──\nok',
      },
    } as never);
    expect(part?.type === 'tool' ? part.output : '').toContain('── result ──');
    expect(part?.type === 'tool' ? part.calls : []).toHaveLength(2);
  });

  it('坏行不制造假事实（解析失败 = 直接丢弃）', () => {
    const parts = progressPart();
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: {
        id: 'c1',
        name: 'code_execution',
        args: '',
        read_only: false,
        partial: false,
        output: `${CODE_CALL_MARK}{bad json`,
      },
    } as never);
    expect(parts[0]?.type === 'tool' ? parts[0].calls : []).toBeUndefined();
  });
});

describe('④ 纸面投影（渲染 / 测高 / 墨迹同一份）', () => {
  const rec = (seq: number, name: string, ok = true, action?: string): CodeDispatchRecord => ({
    seq,
    name,
    ...(action ? { action } : {}),
    ok,
    summary: ok ? 'ok' : 'boom',
  });

  it('行文本：序号 · 工具(动作) · ✓/✗ · 摘要', () => {
    expect(codeCallLine(rec(3, 'fs', true, 'read'))).toBe('3. fs(read) ✓ ok');
    expect(codeCallLine(rec(5, 'shell', false))).toBe('5. shell ✗ boom');
  });

  it('上限：超出 12 条出注记（不静默丢）', () => {
    const many = Array.from({ length: CODE_CALL_SHOW_CAP + 3 }, (_, i) => rec(i + 1, 'fs'));
    const { lines, note } = codeCallLines(many);
    expect(lines).toHaveLength(CODE_CALL_SHOW_CAP);
    expect(note).toBe(`其余 3 条未显示（共 ${CODE_CALL_SHOW_CAP + 3} 条）`);
    expect(codeCallLines([])).toEqual({ lines: [], note: '' });
    expect(codeCallLines(undefined)).toEqual({ lines: [], note: '' });
  });

  it('折读：内调 N（有失败时点名失败数）；无调用 = 空串', () => {
    expect(codeCallsReadout([rec(1, 'fs'), rec(2, 'fs', false)])).toBe('内调 2 · 1 失败');
    expect(codeCallsReadout([rec(1, 'fs')])).toBe('内调 1');
    expect(codeCallsReadout(undefined)).toBe('');
  });
});
