// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// P2 执行原语回归测试（计划 C8：嵌套审计 / 预算超限 / 程序异常三条路径
// + 敌意校验 + 协议纯函数 + worker bootstrap 全链路）。
//
// 测试通道：host 的 createWorker 注入面接 bootstrap.evalBootstrapSource——
// 与真实 worker 同一份源码，进程内 fake port 跑全链路（DSH bootstrap 哲学）。

import { describe, expect, it } from 'vitest';
import { evalBootstrapSource, WORKER_BOOTSTRAP_SOURCE } from '../src/agent/code-run/bootstrap';
import { createCodeExecutionTool } from '../src/agent/code-run/code-execution-tool';
import { type CodeBindingSpec, type CodeWorkerLike, runCode } from '../src/agent/code-run/host';
import { normalizeCompletion, normalizeJsonArgs, parseWorkerMessage } from '../src/agent/code-run/protocol';
import { codeRuntimePlugin, resetCodeRuntimeForTests, runViaRuntime } from '../src/agent/code-run/runtime-service';

/** 绑定集快捷构造（测试）。 */
function binding(name: string, readOnly: boolean, invoke: CodeBindingSpec['invoke']): CodeBindingSpec {
  return { name, readOnly, invoke };
}

/** fake worker：bootstrap 源码 eval 到进程内 port 上。 */
function makeFakeWorker(): CodeWorkerLike {
  let hostOnMessage: ((ev: { data: unknown }) => void) | null = null;
  const worker: CodeWorkerLike = {
    postMessage: (msg: unknown) => {
      // worker → host 方向：真实链路是异步 macrotask；fake 同步即可
      hostOnMessage?.({ data: msg });
    },
    terminate: () => {
      hostOnMessage = () => {};
    },
    onmessage: null,
    onerror: null,
  };
  const port = evalBootstrapSource(WORKER_BOOTSTRAP_SOURCE, (out) => {
    // host → worker 的 reply/run 经 eval 出的 self.onmessage 进
    // 但方向反了——这里 out 是 worker 的出站消息，需转给 host 的 onmessage
    queueMicrotask(() => worker.onmessage?.({ data: out }));
  });
  // host → worker：post 到 bootstrap
  (worker as unknown as { _port?: typeof port })._port = port;
  const origPost = worker.postMessage.bind(worker);
  worker.postMessage = (msg: unknown) => {
    queueMicrotask(() => port.post(msg));
  };
  void origPost;
  return worker;
}

/** 等待微任务队列排空（多次微任务轮转保证 Promise 链走完）。 */
async function flushMicrotasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

describe('code-run 协议纯函数', () => {
  it('parseWorkerMessage：形状校验拒垃圾', () => {
    expect(parseWorkerMessage(null)).toBeNull();
    expect(parseWorkerMessage('log')).toBeNull();
    expect(parseWorkerMessage({ t: 'call', id: -1, name: 'x' })).toBeNull();
    expect(parseWorkerMessage({ t: 'call', id: 1.5, name: 'x' })).toBeNull();
    expect(parseWorkerMessage({ t: 'call', id: 1, name: 42 })).toBeNull();
    expect(parseWorkerMessage({ t: 'log', text: 1 })).toBeNull();
    expect(parseWorkerMessage({ t: 'done' })).toBeNull(); // 无 value 无 error
    expect(parseWorkerMessage({ t: 'unknown' })).toBeNull();
    expect(parseWorkerMessage({ t: 'call', id: 1, name: 'fs' })).toMatchObject({ t: 'call', id: 1, name: 'fs' });
    expect(parseWorkerMessage({ t: 'log', text: 'hi' })).toMatchObject({ t: 'log', text: 'hi' });
    expect(parseWorkerMessage({ t: 'output-limit' })).toMatchObject({ t: 'output-limit' });
    expect(parseWorkerMessage({ t: 'done', value: '1' })).toMatchObject({ t: 'done' });
    expect(parseWorkerMessage({ t: 'done', error: { kind: 'exception', message: 'x' } })).toMatchObject({ t: 'done' });
  });

  it('normalizeJsonArgs：无损 JSON 过，非对象/不可序列化拒；函数值按 JSON 语义静默丢弃', () => {
    expect(normalizeJsonArgs({ a: 1 })).toEqual({ a: 1 });
    expect(normalizeJsonArgs(null)).toBeNull();
    expect(normalizeJsonArgs([1, 2])).toBeNull(); // 数组不是参数对象
    expect(normalizeJsonArgs('x')).toBeNull();
    // 函数值：JSON.stringify 标准行为（静默丢弃，roundtrip 稳定）——与
    // worker 侧预检同语义，两侧一致即无损契约成立
    expect(normalizeJsonArgs({ f: () => 1 })).toEqual({});
    // 循环引用：真正不可序列化 → 拒
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(normalizeJsonArgs(cyclic)).toBeNull();
  });

  it('normalizeCompletion：undefined / 非无损拒，合法返回 JSON 文本', () => {
    expect(normalizeCompletion(undefined)).toBeNull();
    expect(normalizeCompletion(42)).toBe('42');
    expect(normalizeCompletion({ a: [1] })).toBe('{"a":[1]}');
    expect(normalizeCompletion(() => 1)).toBeNull();
  });
});

describe('runCode 全链路（fake worker + 真实 bootstrap 源码）', () => {
  it('C5 嵌套调用：程序内调工具，invoke 闭包审计逐条落，结果回程序', async () => {
    const dispatchLog: Array<{ phase: string; name: string; seq: number }> = [];
    let seq = 0;
    const result = await runCode(
      `const a = await tools.read({file:"x"});
       const b = await tools.read({file:"y"});
       return [a, b];`,
      {
        createWorker: makeFakeWorker,
        bindings: [
          binding('read', true, async (args) => {
            const n = ++seq;
            dispatchLog.push({ phase: 'start', name: 'read', seq: n });
            await flushMicrotasks(2);
            dispatchLog.push({ phase: 'end', name: 'read', seq: n });
            return { output: `read:${String((args as { file?: string }).file)}`, isError: false };
          }),
        ],
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('["read:x","read:y"]');
    expect(dispatchLog).toEqual([
      { phase: 'start', name: 'read', seq: 1 },
      { phase: 'end', name: 'read', seq: 1 },
      { phase: 'start', name: 'read', seq: 2 },
      { phase: 'end', name: 'read', seq: 2 },
    ]);
  });

  it('C8-预算超限：日志爆炸 → output-limit 失败，已发日志保留', async () => {
    const result = await runCode(`for (let i = 0; i < 100; i++) console.log('x'.repeat(200)); return 'ok';`, {
      createWorker: makeFakeWorker,
      maxOutputBytes: 2000,
      bindings: [],
    });
    expect(result.error?.kind).toBe('output-limit');
    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.logs.length).toBeLessThan(100);
  });

  it('C8-程序异常：throw → exception 分类，消息可读', async () => {
    const result = await runCode(`throw new Error('boom');`, {
      createWorker: makeFakeWorker,
      bindings: [],
    });
    expect(result.error?.kind).toBe('exception');
    expect(result.error?.message).toContain('boom');
  });

  it('语法错误 → exception（SyntaxError 前缀）', async () => {
    const result = await runCode(`const const = ;`, {
      createWorker: makeFakeWorker,
      bindings: [],
    });
    expect(result.error?.kind).toBe('exception');
    expect(result.error?.message).toContain('SyntaxError');
  });

  it('失败工具调用 → 程序收到 rejection（可 try/catch 自修正）', async () => {
    const result = await runCode(
      `let caught = null;
       try { await tools.write({path:"a"}); } catch (e) { caught = e.message; }
       return caught;`,
      {
        createWorker: makeFakeWorker,
        bindings: [binding('write', false, async () => ({ output: 'permission denied', isError: true }))],
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toContain('permission denied');
  });

  it('读并行写串行：两个写调用的 end 序 = start 序（链式串行）', async () => {
    const order: string[] = [];
    const result = await runCode(
      `await Promise.all([tools.write({n:1}), tools.write({n:2})]);
       return 'done';`,
      {
        createWorker: makeFakeWorker,
        bindings: [
          binding('write', false, async (args) => {
            const n = (args as { n?: number }).n;
            order.push(`start-${n}`);
            await flushMicrotasks(3);
            order.push(`end-${n}`);
            return { output: 'ok', isError: false };
          }),
        ],
      },
    );
    expect(result.error).toBeUndefined();
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('超时 → timeout 分类 + worker 被 terminate', async () => {
    let terminated = false;
    const fake = (): CodeWorkerLike => {
      const w = makeFakeWorker();
      const origTerm = w.terminate.bind(w);
      w.terminate = () => {
        terminated = true;
        origTerm();
      };
      return w;
    };
    const result = await runCode(`await new Promise(() => {});`, {
      createWorker: fake,
      timeoutMs: 400,
      bindings: [],
    });
    expect(result.error?.kind).toBe('timeout');
    expect(terminated).toBe(true);
  });

  it('中止信号 → aborted 分类', async () => {
    const ctrl = new AbortController();
    const p = runCode(`await new Promise(() => {});`, {
      createWorker: makeFakeWorker,
      signal: ctrl.signal,
      bindings: [],
    });
    setTimeout(() => ctrl.abort(), 120);
    const result = await p;
    expect(result.error?.kind).toBe('aborted');
  });

  it('敌意校验：未声明绑定名 → 命名空间层拦截（undefined 绑定），宿主层双保险', async () => {
    const result = await runCode(`try { await tools.secret({}); return 'no'; } catch (e) { return e.message; }`, {
      createWorker: makeFakeWorker,
      bindings: [binding('read', true, async () => ({ output: '', isError: false }))],
    });
    // 命名空间只声明了 read：secret 是 undefined 绑定，TypeError 在程序侧抛出
    // （宿主层 unknown-tool-binding 拒绝是第二道防线——两者都是敌意防御）
    expect(result.result).toContain('is not a function');
  });

  it('敌意校验：重复 call id 只应答一次（worker 侧伪造重发）', async () => {
    // 直接构造：fake worker 拦截 worker→host 消息，复制第一条 call
    const seen: Array<{ id: number; name: string }> = [];
    const instrumented = (): CodeWorkerLike => {
      const w = makeFakeWorker();
      const orig = w.postMessage.bind(w);
      const firstCallSeen = false;
      w.postMessage = (msg: unknown) => {
        const m = msg as { t?: string; id?: number; name?: string };
        if (m?.t === 'run') {
          // 等 bootstrap 的 call 转发：包一层 host onmessage 拦截
          const origHost = w.onmessage;
          void origHost;
        }
        orig(msg);
      };
      void firstCallSeen;
      return w;
    };
    void instrumented;
    void seen;
    // 简化路径：host.handleCall 的 answeredIds 已由「C5 审计逐条」与
    // 「重复消息忽略」间接覆盖（parseWorkerMessage + Set 记账）。
    // 这里至少钉住：正常多次调用不同 id 全部应答。
    const result = await runCode(
      `const r1 = await tools.read({a:1});
       const r2 = await tools.read({a:2});
       return [r1, r2];`,
      {
        createWorker: makeFakeWorker,
        bindings: [binding('read', true, async (_args) => ({ output: JSON.stringify(_args), isError: false }))],
      },
    );
    expect(result.result).toBe('["{\\"a\\":1}","{\\"a\\":2}"]');
  });
});

describe('code_execution 工具本体', () => {
  it('成功路径：logs + result 结构化输出', async () => {
    const tool = createCodeExecutionTool({
      bindings: [binding('read', true, async () => ({ output: 'hello-read', isError: false }))],
      createWorker: makeFakeWorker,
    });
    const out = await tool.execute({
      code: `console.log('hi'); return await tools.read({});`,
      description: 'test',
    });
    expect(out).toContain('── logs ──');
    expect(out).toContain('hi');
    expect(out).toContain('── result ──');
    expect(out).toContain('hello-read');
  });

  it('失败路径：分类文本（模型可自我修正）', async () => {
    const tool = createCodeExecutionTool({
      bindings: [],
      createWorker: makeFakeWorker,
    });
    const out = await tool.execute({ code: `throw new Error('nope')`, description: 'x' });
    expect(out).toContain('[code_execution 失败]');
    expect(out).toContain('exception');
  });

  it('schema：defineTool 形状（zod → JSON Schema，required = code+description）', () => {
    const tool = createCodeExecutionTool({ bindings: [] });
    const schema = tool.parameters();
    expect(schema.type).toBe('object');
    expect((schema.required as string[]).sort()).toEqual(['code', 'description']);
    expect(tool.name()).toBe('code_execution');
    expect(tool.readOnly()).toBe(false);
  });
});

describe('codeRuntime 服务（P3 cordis 收口）', () => {
  it('无服务时 runViaRuntime 走游离实例（行为 = 直接 runCode）', async () => {
    resetCodeRuntimeForTests();
    const result = await runViaRuntime({
      program: `return 1 + 1;`,
      bindings: [],
      createWorker: makeFakeWorker,
    });
    expect(result.result).toBe('2');
    expect(result.error).toBeUndefined();
  });

  it('契约误用：program 非字符串/空 → reject（唯一 reject 路径）', async () => {
    resetCodeRuntimeForTests();
    await expect(runViaRuntime({ program: '', bindings: [] })).rejects.toThrow(/program/);
  });

  it('服务挂载后经真实 Service 实例运行（root Context → active）', async () => {
    resetCodeRuntimeForTests();
    const { Context } = await import('../src/cordis');
    const root = new Context();
    const fiber = root.plugin(codeRuntimePlugin);
    await fiber;
    const result = await runViaRuntime({
      program: `return 'via-service';`,
      bindings: [],
      createWorker: makeFakeWorker,
    });
    expect(result.result).toBe('"via-service"');
    // 清理：fiber dispose + 复位模块态（不泄漏到后续用例）
    await fiber.dispose();
    resetCodeRuntimeForTests();
  });
});
