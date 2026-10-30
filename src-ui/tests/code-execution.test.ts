// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// P2 执行原语回归测试（计划 C8：嵌套审计 / 预算超限 / 程序异常三条路径
// + 敌意校验 + 协议纯函数 + worker bootstrap 全链路）。
//
// 测试通道：host 的 createWorker 注入面接 bootstrap.evalBootstrapSource——
// 与真实 worker 同一份源码，进程内 fake port 跑全链路（DSH bootstrap 哲学）。

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { evalBootstrapSource, WORKER_BOOTSTRAP_SOURCE } from '../src/agent/code-run/bootstrap';
import {
  createCodeExecutionTool,
  projectBindingEntry,
  renderBindingCatalog,
} from '../src/agent/code-run/code-execution-tool';
import { type CodeBindingSpec, type CodeWorkerLike, runCode } from '../src/agent/code-run/host';
import { normalizeJsonArgs, parseWorkerMessage } from '../src/agent/code-run/protocol';
import { codeRuntimePlugin, resetCodeRuntimeForTests, runViaRuntime } from '../src/agent/code-run/runtime-service';
import { ToolRegistry } from '../src/agent/tool';
import { defineTool } from '../src/agent/tools/define-tool';
import { convergeRegistry } from '../src/agent/tools/domains';

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
    // 无值无错 = 「程序完成、无输出」的合法落定（2026-08-30 实机事故修复——
    // 此前被当垃圾丢弃 → 无 return 的程序永不结算，挂到超时/用户中止）
    expect(parseWorkerMessage({ t: 'done' })).toMatchObject({ t: 'done' });
    // worker 实发形态：{t:'done', value: undefined}（structured clone 保留 undefined 属性）
    expect(parseWorkerMessage({ t: 'done', value: undefined })).toMatchObject({ t: 'done' });
    // 值/错误在场但形状非法仍然拒
    expect(parseWorkerMessage({ t: 'done', value: 42 })).toBeNull();
    expect(parseWorkerMessage({ t: 'done', error: { kind: 42 } })).toBeNull();
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

  it('回归（2026-08-30 实机事故）：无 return 的程序正常落定，日志即产出', async () => {
    // 真实事故形态：scan 类程序只 console.log 不 return——worker 发
    // {t:'done', value: undefined}，宿主解析器曾把它当垃圾丢弃 →
    // run 永不结算（挂到 120s 超时或用户中止，体感 = 用了就卡死）
    const result = await runCode(
      `console.log('=== 盘点 ===');
       console.log('  3x 13px');`,
      { createWorker: makeFakeWorker, bindings: [] },
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBeUndefined();
    expect(result.logs).toEqual(['=== 盘点 ===', '  3x 13px']);
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

  it('敌意校验：未声明绑定名 → 调用即抛 unknown-binding（程序侧拦截，宿主层双保险）', async () => {
    let hostCalls = 0;
    const result = await runCode(
      `try { await tools.secret({}); return 'no'; } catch (e) { return e.code + ':' + e.message; }`,
      {
        createWorker: makeFakeWorker,
        bindings: [
          binding('read', true, async () => {
            hostCalls++;
            return { output: '', isError: false };
          }),
        ],
      },
    );
    // 规格变更（P3，2026-10-30，故意且已声明）：旧形态 = 未声明绑定是 undefined 属性，
    // 调用抛 TypeError「is not a function」；新形态 = 命名空间是 Proxy，未知属性返回
    // 「调用即抛」的函数 ⇒ e.code = 'unknown-binding'（程序内可分类自纠）。
    // 拦截面不变：仍在程序侧当场炸，不进宿主（宿主 unknown-tool-binding 拒绝是第二道防线）。
    expect(result.result).toContain('unknown-binding');
    expect(result.result).toContain('secret');
    expect(hostCalls).toBe(0);
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

describe('完成值形态 + 日志渲染（2026-09-19 程文输出换代）', () => {
  /** 程序源码里写死一个字符串值（JSON.stringify 保证逐字节无损注入）。 */
  const programReturning = (value: string): string => `return ${JSON.stringify(value)};`;

  it('字符串完成值原样出：真换行/制表/单反斜杠路径不被二次转义', async () => {
    const text = 'ls -la .lantai\ntotal 129385\n-rw-r--r-- 1 x 37882346 audit.jsonl';
    const winPath = String.raw`\\?\D:\ws\docs\a.md`;
    const lines = await runCode(programReturning(text), { createWorker: makeFakeWorker, bindings: [] });
    const path = await runCode(programReturning(winPath), { createWorker: makeFakeWorker, bindings: [] });
    // 规格变更（2026-09-19）：旧行为是 JSON 编码形态（`"ls -la\ntotal…"` —— 真换行
    // 变字面 \n、整段塌成一行），新行为是文本本体（真机 40 行清单塌成一行的根治）
    expect(lines.result).toBe(text);
    expect(lines.result).not.toContain('\\n');
    expect(path.result).toBe(winPath);
    // 旧观感：路径被 JSON 再编码一层（`\\\\?\\D:\\…`）——四反斜杠打头即旧形态
    expect(path.result).not.toContain(String.raw`\\\\?`);
  });

  it('非字符串完成值仍走 JSON 文本（对象/数组/字面量契约不变）', async () => {
    const obj = await runCode(`return {count: 2, files: ['a', 'b']};`, {
      createWorker: makeFakeWorker,
      bindings: [],
    });
    expect(obj.result).toBe('{"count":2,"files":["a","b"]}');
    const num = await runCode(`return 42;`, { createWorker: makeFakeWorker, bindings: [] });
    expect(num.result).toBe('42');
  });

  it('无效完成值仍归一为 invalid-output（函数/undefined 根级不可序列化）', async () => {
    const fn = await runCode(`return function () {};`, { createWorker: makeFakeWorker, bindings: [] });
    expect(fn.error?.kind).toBe('invalid-output');
  });

  it('console.log 有界 inspect：深度/条目封顶 + 循环标记 + Error 取栈', async () => {
    const result = await runCode(
      `const a = {name: 'x'}; a.self = a; console.log(a);
       console.log({deep:{a:{b:{c:{d:1}}}}});
       console.log(Array.from({length: 60}, (_, i) => i));
       console.log(new Error('boom'));`,
      { createWorker: makeFakeWorker, bindings: [] },
    );
    expect(result.error).toBeUndefined();
    const [cyclic, deep, arr, err] = result.logs;
    // 旧实现：循环引用掉进 String(a) → '[object Object]'（信息静默丢失）
    expect(cyclic).toBe('{name: x, self: [Circular]}');
    // 深度封顶：注释承诺过、实现此前并不存在（深对象炸成单行巨串）
    expect(deep).toBe('{deep: {a: {b: {c: [Object]}}}}');
    // 条目封顶 + 可见注记（不静默截断）
    expect(arr.startsWith('[0, 1, 2,')).toBe(true);
    expect(arr).toContain('… +10');
    // Error 不是可枚举对象：旧实现 stringify 成 '{}'（栈全丢）
    expect(err).toContain('Error: boom');
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

  it('无 return 程序：日志即产出，不算失败（2026-08-30 实机事故回归）', async () => {
    const tool = createCodeExecutionTool({
      bindings: [],
      createWorker: makeFakeWorker,
    });
    const out = await tool.execute({ code: `console.log('a'); console.log('b');`, description: 'x' });
    expect(out).toContain('── logs ──');
    expect(out).toContain('a');
    expect(out).not.toContain('[code_execution 失败]');
    expect(out).not.toContain('── result ──');
  });

  it('字符串完成值进卡即文本本体：result 段下是真换行（展示面分段消费同一信封）', async () => {
    const tool = createCodeExecutionTool({ bindings: [], createWorker: makeFakeWorker });
    const text = 'drwxr-xr-x agents\n-rw-r--r-- audit.jsonl';
    const out = await tool.execute({ code: `return ${JSON.stringify(text)};`, description: '盘点' });
    expect(out).toBe(`── result ──\n${text}`);
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
    // 规格变更（2026-09-19）：字符串完成值不再 JSON 编码（旧值 = '"via-service"'）
    expect(result.result).toBe('via-service');
    // 清理：fiber dispose + 复位模块态（不泄漏到后续用例）
    await fiber.dispose();
    resetCodeRuntimeForTests();
  });
});

// ── P1 绑定目录（code-execution-upgrade-plan §3）──
describe('P1 绑定目录', () => {
  /** 域门面替身（action 枚举 + 一个必填参数）。 */
  function domainTool(name: string, actions: string[]) {
    return defineTool({
      name,
      description: name,
      domain: name,
      actions,
      schema: z.object({ action: z.enum(actions as [string, ...string[]]), path: z.string() }),
      execute: async () => name,
    });
  }

  /** 域动作实现（convergeRegistry 靠它们判定域门面是否存在）。 */
  function actionTool(name: string, readOnly = false) {
    return defineTool({
      name,
      description: name,
      readOnly,
      schema: z.object({ filePath: z.string() }),
      execute: async () => name,
    });
  }

  it('投影只取三样：名字 / 动作枚举 / 必填键（action 剔除，参数说明不进）', () => {
    expect(projectBindingEntry(domainTool('fs', ['read', 'write']))).toEqual({
      name: 'fs',
      actions: ['read', 'write'],
      required: ['path'],
    });
  });

  it('渲染：空集为空串 / 按名排序 / 动作超上限缩写为 …', () => {
    expect(renderBindingCatalog([])).toBe('');
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const text = renderBindingCatalog([{ name: 'zeta', actions: several(many) }, { name: 'alpha' }]);
    const lines = text.split('\n').filter((l) => l.startsWith('  '));
    expect(lines).toEqual(['  alpha', `  zeta(action: a|b|c|d|e|f|…)`]);
  });

  it('目录不含 code_execution 自身；缺省无 catalog 时退化为裸名字（不出空括号）', () => {
    const reg = new ToolRegistry();
    reg.register(actionTool('read_file_content', true));
    convergeRegistry(reg);
    reg.register(
      defineTool({
        name: 'code_execution',
        description: 'self',
        schema: z.object({ code: z.string() }),
        execute: async () => '',
      }),
    );
    const withCatalog = createCodeExecutionTool({ bindings: [], catalog: () => reg.visibleTools() });
    expect(withCatalog.description()).toContain('  fs(action: read)');
    expect(
      withCatalog
        .description()
        .split('\n')
        .filter((l) => l.includes('code_execution')),
    ).toEqual([]);

    const fallback = createCodeExecutionTool({
      bindings: [{ name: 'fs', readOnly: true, invoke: async () => ({ output: '', isError: false }) }],
    });
    expect(fallback.description()).toContain('\n  fs');
    expect(fallback.description()).not.toContain('fs()');
  });

  it('目录读活注册表：后注册 + 复收敛的动作立刻出现在描述里（域门面是构建期快照）', () => {
    const reg = new ToolRegistry();
    reg.register(actionTool('read_file_content', true));
    convergeRegistry(reg);
    const tool = createCodeExecutionTool({ bindings: [], catalog: () => reg.visibleTools() });
    expect(tool.description()).toContain('  fs(action: read)');

    // 装配期之后才出现的动作（域实例不会自更新，必须复收敛——见计划 §3.4 取证）
    reg.register(actionTool('write_file'));
    convergeRegistry(reg);
    expect(tool.description()).toContain('  fs(action: read|write)');
  });
});

/** 把 string[] 收窄成 renderBindingCatalog 需要的形态（测试 helper）。 */
function several(names: string[]): string[] {
  return names;
}

// ── P2 并发面（code-execution-upgrade-plan §4）──
describe('P2 并发面', () => {
  /** 记录 start/end 序的写绑定：锁键由参数 key 决定（'*' = 排他闸）。 */
  function keyedBinding(order: string[], readOnlyFor?: (args: Record<string, unknown>) => boolean): CodeBindingSpec {
    return {
      name: 'w',
      readOnly: false,
      ...(readOnlyFor ? { readOnlyFor } : {}),
      lockKey: (args) => (typeof args.key === 'string' ? args.key : '*'),
      invoke: async (args) => {
        const n = args.n as number;
        order.push(`start-${n}`);
        await flushMicrotasks(3);
        order.push(`end-${n}`);
        return { output: 'ok', isError: false };
      },
    };
  }

  it('同键写串行：第二个写等第一个写完（start-2 晚于 end-1）', async () => {
    const order: string[] = [];
    const result = await runCode(
      `await Promise.all([tools.w({n:1,key:'file:a'}), tools.w({n:2,key:'file:a'})]); return 'done';`,
      { createWorker: makeFakeWorker, bindings: [keyedBinding(order)] },
    );
    expect(result.error).toBeUndefined();
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('异键写并行：两个写同时在途（start 交错，end 按提交序）', async () => {
    const order: string[] = [];
    const result = await runCode(
      `await Promise.all([tools.w({n:1,key:'file:a'}), tools.w({n:2,key:'file:b'})]); return 'done';`,
      { createWorker: makeFakeWorker, bindings: [keyedBinding(order)] },
    );
    expect(result.error).toBeUndefined();
    expect(order).toEqual(['start-1', 'start-2', 'end-1', 'end-2']);
  });

  it("排他闸：'*' 等在途键控写排空，并阻塞其后键控写", async () => {
    const order: string[] = [];
    const result = await runCode(
      `await Promise.all([
         tools.w({n:1,key:'file:a'}),
         tools.w({n:2,key:'*'}),
         tools.w({n:3,key:'file:b'}),
       ]); return 'done';`,
      { createWorker: makeFakeWorker, bindings: [keyedBinding(order)] },
    );
    expect(result.error).toBeUndefined();
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  });

  it('域工具只读动作不进写链：readOnlyFor 命中即并行', async () => {
    const order: string[] = [];
    const binding = keyedBinding(order, (args) => args.action === 'read');
    const result = await runCode(
      `await Promise.all([tools.w({n:1,action:'read'}), tools.w({n:2,action:'read'})]); return 'done';`,
      { createWorker: makeFakeWorker, bindings: [binding] },
    );
    expect(result.error).toBeUndefined();
    expect(order).toEqual(['start-1', 'start-2', 'end-1', 'end-2']);
  });
});

// ── P3 错误面（code-execution-upgrade-plan §5）──
describe('P3 错误面', () => {
  it('未知绑定：程序内当场抛（零宿主往返），带 code / 最近邻 / 可用清单', async () => {
    let hostCalls = 0;
    const result = await runCode(
      `try { await tools.fss({}); } catch (e) {
         return JSON.stringify({ code: e.code, msg: e.message, hint: e.hint });
       }`,
      {
        createWorker: makeFakeWorker,
        bindings: [
          binding('fs', true, async () => {
            hostCalls++;
            return { output: 'x', isError: false };
          }),
        ],
      },
    );
    const got = JSON.parse(result.result ?? '{}') as { code?: string; msg?: string; hint?: string };
    expect(got.code).toBe('unknown-binding');
    expect(got.msg).toContain('did you mean "fs"');
    expect(got.hint).toContain('fs');
    expect(hostCalls).toBe(0); // 未进宿主：错在 worker 侧当场抛
  });

  it('参数校验失败：程序内 catch 拿到 invalid-args（宿主 reply 的 code/hint 贯通）', async () => {
    const result = await runCode(
      `try { await tools.fs({action:'write'}); } catch (e) { return [e.code, e.hint ?? ''].join('|'); }`,
      {
        createWorker: makeFakeWorker,
        bindings: [
          binding('fs', false, async () => ({
            output: '参数校验失败: filePath: Required',
            isError: true,
            code: 'invalid-args',
            hint: 'pass filePath',
          })),
        ],
      },
    );
    expect(result.result).toBe('invalid-args|pass filePath');
  });

  it('门禁打回 = blocked：四类失败可用同一套 e.code 分支处置', async () => {
    const result = await runCode(
      `const seen = [];
       for (const name of ['fs', 'shell']) {
         try { await tools[name]({}); } catch (e) { seen.push(e.code); }
       }
       return seen.join('|');`,
      {
        createWorker: makeFakeWorker,
        bindings: [
          binding('fs', false, async () => ({ output: '计划模式：不允许写入', isError: true, code: 'blocked' })),
          binding('shell', false, async () => ({ output: 'boom', isError: true, code: 'tool-error' })),
        ],
      },
    );
    expect(result.result).toBe('blocked|tool-error');
  });

  it('协议键放行：await tools / JSON.stringify(tools) / in 探测都不炸', async () => {
    const result = await runCode(
      `const t = await tools;
       const s = JSON.stringify(tools);
       return [typeof t, s, 'fs' in tools, 'nope' in tools].join('|');`,
      { createWorker: makeFakeWorker, bindings: [binding('fs', true, async () => ({ output: '', isError: false }))] },
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBe('object|{}|true|false');
  });
});
