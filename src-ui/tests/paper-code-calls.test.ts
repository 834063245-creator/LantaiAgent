// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 程序内调用显形批（2026-11-21）——四段链路的钉子：
//   ① 宿主旁路：runCode 的 onDispatch 每笔两拍（起跑 running → 落定 done/error），
//      起跑序 = 派发序（2026-11-23 运行态批）
//   ② 线格式：code_execution 把它转成 onProgress 的标记行，不污染结果信封
//   ③ 分流：part-mutator 把标记行按 seq 原地落进 part.calls（绝不拼进 output）
//   ④ 纸面投影：行文本 / 上限注记 / 折读，渲染与测高同一份（含「⋯ 在跑」）
import { describe, expect, it } from 'vitest';
import { EventKind } from '../src/agent/agent-types';
import { evalBootstrapSource, WORKER_BOOTSTRAP_SOURCE } from '../src/agent/code-run/bootstrap';
import { CODE_CALL_MARK, createCodeExecutionTool } from '../src/agent/code-run/code-execution-tool';
import { type CodeDispatchRecord, codeCallStatus } from '../src/agent/code-run/dispatch-record';
import { type CodeBindingSpec, type CodeWorkerLike, runCode } from '../src/agent/code-run/host';
import {
  CODE_CALL_SHOW_CAP,
  codeCallLine,
  codeCallLines,
  codeCallsReadout,
  codeCallsSignature,
} from '../src/paper/code-calls';
import type { AssistantPart } from '../src/ui/message-model';
import { applyEventToParts, finalisePendingToolParts } from '../src/ui/part-mutator';

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

/** 等待微任务队列排空（多轮：worker 出站/入站各经一次 queueMicrotask）。 */
async function flushMicrotasks(n = 24): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('① 宿主旁路 onDispatch（两拍）', () => {
  it('起跑先到（running，无 summary），落定按同一 seq 更新（done）', async () => {
    const got: CodeDispatchRecord[] = [];
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const runP = runCode(`await tools.slow({action:'run'}); return 'ok';`, {
      createWorker: makeFakeWorker,
      onDispatch: (d) => got.push(d),
      bindings: [binding('slow', async () => ({ output: await gate, isError: false }))],
    });
    await flushMicrotasks();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      seq: 1,
      name: 'slow',
      action: 'run',
      status: 'running',
      startedAt: expect.any(Number),
    });
    expect(got[0]?.summary).toBeUndefined();

    release('done output');
    const result = await runP;
    expect(result.error).toBeUndefined();
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({
      seq: 1,
      name: 'slow',
      action: 'run',
      status: 'done',
      summary: 'done output',
    });
    // 落定沿用起跑戳：展示面不得重起计时
    expect(got[1]?.startedAt).toBe(got[0]?.startedAt);
  });

  it('逐笔落定：name / action / status / summary；seq 按派发序递增', async () => {
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
    // 三笔 = 三条起跑 + 三条落定
    expect(got).toHaveLength(6);
    expect(got.filter((d) => d.status === 'running')).toHaveLength(3);
    const settled = got.filter((d) => d.status === 'done' || d.status === 'error');
    expect(settled).toHaveLength(3);
    expect(settled.map((d) => d.seq).sort()).toEqual([1, 2, 3]);
    // 每笔两拍用同一 seq；三笔共六个事件（先后按实际调度）
    expect([...got.map((d) => d.seq)].sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3, 3]);
    const fsRead = settled.find((d) => d.name === 'fs' && d.action === 'read');
    expect(fsRead).toMatchObject({ status: 'done', summary: 'line one' });
    const shell = settled.find((d) => d.name === 'shell');
    expect(shell).toMatchObject({ action: 'run', status: 'done' });
    const failed = settled.find((d) => d.status === 'error');
    expect(failed).toMatchObject({ name: 'fs', action: 'write', status: 'error' });
    expect(failed?.summary).toContain('EACCES');
  });

  it('程序结束仍未落定 → 收成 error（「在跑」不得成为终态）', async () => {
    const got: CodeDispatchRecord[] = [];
    const ac = new AbortController();
    const runP = runCode(`await tools.hang({}); return 1;`, {
      createWorker: makeFakeWorker,
      signal: ac.signal,
      onDispatch: (d) => got.push(d),
      bindings: [binding('hang', () => new Promise(() => {}))],
    });
    await flushMicrotasks();
    expect(got[0]?.status).toBe('running');
    ac.abort();
    const result = await runP;
    expect(result.error?.kind).toBe('aborted');
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({ seq: 1, status: 'error', summary: '未落定' });
  });

  it('程序先结束、调用后返回：迟到结果按同 seq 从「未落定」改成真实结果', async () => {
    const got: CodeDispatchRecord[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runP = runCode(`tools.slow({}); return 'done';`, {
      createWorker: makeFakeWorker,
      onDispatch: (d) => got.push(d),
      settleGraceMs: 20,
      bindings: [
        // 读类不进写闸：调用必须在程序 return 之前真的启动，才谈得上「迟到返回」
        binding('slow', async () => {
          await gate;
          return { output: 'late ok', isError: false };
        }),
      ],
    });
    const result = await runP;
    expect(result.result).toBe('done');
    // 宽限到点：起跑 + 收成「未落定」
    expect(got.map((d) => d.status)).toEqual(['running', 'error']);
    release();
    await flushMicrotasks(40);
    expect(got[got.length - 1]).toMatchObject({ seq: 1, status: 'done', summary: 'late ok' });
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
  it('每笔两拍都转成 onProgress 标记行；结果文本里没有标记', async () => {
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
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.startsWith(CODE_CALL_MARK))).toBe(true);
    expect(JSON.parse(chunks[0]!.slice(CODE_CALL_MARK.length))).toMatchObject({
      name: 'fs',
      status: 'running',
    });
    expect(JSON.parse(chunks[1]!.slice(CODE_CALL_MARK.length))).toMatchObject({
      name: 'fs',
      status: 'done',
      summary: 'hello',
    });
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

  function progress(parts: AssistantPart[], rec: CodeDispatchRecord): void {
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: {
        id: 'c1',
        name: 'code_execution',
        args: '',
        read_only: false,
        partial: false,
        output: `${CODE_CALL_MARK}${JSON.stringify(rec)}`,
      },
    } as never);
  }

  function callsOf(parts: AssistantPart[]): CodeDispatchRecord[] | undefined {
    const part = parts[0];
    return part?.type === 'tool' ? part.calls : undefined;
  }

  it('同一 seq 两拍原地更新（不追加第二行）；output 保持空', () => {
    const parts = progressPart();
    progress(parts, { seq: 1, name: 'shell', action: 'run', status: 'running', startedAt: 100 });
    expect(callsOf(parts)).toEqual([{ seq: 1, name: 'shell', action: 'run', status: 'running', startedAt: 100 }]);
    progress(parts, {
      seq: 1,
      name: 'shell',
      action: 'run',
      status: 'done',
      summary: 'exit 0',
      startedAt: 100,
    });
    expect(callsOf(parts)).toEqual([
      { seq: 1, name: 'shell', action: 'run', status: 'done', summary: 'exit 0', startedAt: 100 },
    ]);
    expect(parts[0]?.type === 'tool' ? parts[0].output : 'x').toBeUndefined();
  });

  it('不同 seq 追加；ToolResult 把仍未落定的行收成 error', () => {
    const parts = progressPart();
    progress(parts, { seq: 1, name: 'fs', status: 'done', summary: 'a.ts' });
    progress(parts, { seq: 2, name: 'shell', action: 'run', status: 'running' });
    expect(callsOf(parts)).toHaveLength(2);

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
    expect(parts[0]?.type === 'tool' ? parts[0].output : '').toContain('── result ──');
    expect(callsOf(parts)).toEqual([
      { seq: 1, name: 'fs', status: 'done', summary: 'a.ts' },
      { seq: 2, name: 'shell', action: 'run', status: 'error', summary: '未落定' },
    ]);
  });

  it('回合收尾（finalisePendingToolParts）也把仍在跑的内调收成 error', () => {
    const parts = progressPart();
    progress(parts, { seq: 1, name: 'shell', action: 'run', status: 'running' });
    expect(finalisePendingToolParts(parts)).toBe(true);
    expect(parts[0]?.type === 'tool' ? parts[0].status : '').toBe('error');
    expect(callsOf(parts)?.[0]).toMatchObject({ status: 'error', summary: '未落定' });
  });

  it('旧卷快照（只有 ok）照旧读得出来；坏行不制造假事实', () => {
    const parts = progressPart();
    progress(parts, { seq: 1, name: 'fs', ok: true, summary: 'a.ts' } as CodeDispatchRecord);
    progress(parts, { seq: 2, name: 'shell', ok: false, summary: 'boom' } as CodeDispatchRecord);
    expect(callsOf(parts)).toHaveLength(2);
    expect(callsOf(parts)?.map(codeCallStatus)).toEqual(['done', 'error']);

    const before = callsOf(parts)?.length;
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
    expect(callsOf(parts)).toHaveLength(before ?? 0);
  });
});

describe('④ 纸面投影（渲染 / 测高 / 墨迹同一份）', () => {
  const rec = (seq: number, name: string, status: 'running' | 'done' | 'error' = 'done', action?: string) => ({
    seq,
    name,
    ...(action ? { action } : {}),
    status,
    ...(status === 'running' ? {} : { summary: status === 'done' ? 'ok' : 'boom' }),
  });

  it('行文本：序号 · 工具(动作) · ✓/✗/⋯ · 摘要（在跑说明「在跑」）', () => {
    expect(codeCallLine(rec(3, 'fs', 'done', 'read'))).toEqual({ text: '3. fs(read) ✓ ok', status: 'done' });
    expect(codeCallLine(rec(5, 'shell', 'error'))).toEqual({ text: '5. shell ✗ boom', status: 'error' });
    expect(codeCallLine(rec(7, 'shell', 'running', 'run'))).toEqual({
      text: '7. shell(run) ⋯ 在跑',
      status: 'running',
    });
  });

  it('旧卷（只有 ok 没有 status）：按 ok 回退成败', () => {
    expect(codeCallStatus({ ok: true })).toBe('done');
    expect(codeCallStatus({ ok: false })).toBe('error');
    expect(codeCallStatus({})).toBe('done');
    expect(codeCallLine({ seq: 1, name: 'fs', ok: true, summary: 'a.ts' })).toEqual({
      text: '1. fs ✓ a.ts',
      status: 'done',
    });
  });

  it('上限：超出 12 条出注记（不静默丢）', () => {
    const many = Array.from({ length: CODE_CALL_SHOW_CAP + 3 }, (_, i) => rec(i + 1, 'fs'));
    const { lines, note } = codeCallLines(many);
    expect(lines).toHaveLength(CODE_CALL_SHOW_CAP);
    expect(note).toBe(`其余 3 条未显示（共 ${CODE_CALL_SHOW_CAP + 3} 条）`);
    expect(codeCallLines([])).toEqual({ lines: [], note: '' });
    expect(codeCallLines(undefined)).toEqual({ lines: [], note: '' });
  });

  it('折读：内调 N + 在跑（单笔点名）+ 失败数（三者都可同时出现）；无调用 = 空串', () => {
    expect(codeCallsReadout([rec(1, 'fs'), rec(2, 'fs', 'error')])).toBe('内调 2 · 1 失败');
    expect(codeCallsReadout([rec(1, 'fs'), rec(2, 'shell', 'running', 'run')])).toBe('内调 2 · 在跑 shell(run)');
    expect(codeCallsReadout([rec(1, 'fs'), rec(2, 'fs', 'running'), rec(3, 'shell', 'running')])).toBe(
      '内调 3 · 2 在跑',
    );
    expect(codeCallsReadout([rec(1, 'fs'), rec(2, 'fs', 'error'), rec(3, 'shell', 'running', 'run')])).toBe(
      '内调 3 · 在跑 shell(run) · 1 失败',
    );
    expect(codeCallsReadout(undefined)).toBe('');
  });

  it('缓存签名：行文本变化即失效（running → done 必须重画墨迹）', () => {
    expect(codeCallsSignature(undefined)).toBe('');
    const running = codeCallsSignature([rec(1, 'shell', 'running', 'run')]);
    const done = codeCallsSignature([rec(1, 'shell', 'done', 'run')]);
    expect(running).not.toBe('');
    expect(done).not.toBe(running);
    // 追加一行也变（测高按行数长高）
    expect(codeCallsSignature([rec(1, 'fs'), rec(2, 'fs')])).not.toBe(codeCallsSignature([rec(1, 'fs')]));
  });
});
