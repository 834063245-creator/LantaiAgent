// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件激活生命周期（S6 P3a）——「登记 ≠ 激活」的行为面。
//
// 三层分别钉住：
//   ① 账本体（composition/activation.ts，叶模块）：声明校验 / kill switch no-op /
//      引用计数 / 并发首次激活 / 失败可见 / 归零即停 / plan 前缀判定；
//   ② 服务面：compositionServicesPlugin 挂载后 ctx.activation 可解析，随 fiber 注销；
//   ③ 装配面（runtime）：Agent 装配期 retain（首次 start）+ AgentContext.effect
//      对称释放（dispose → 归零 stop）——序列 E 的骨架。
//
// 破测（2026-09-15 逐条注入验证，见 commit message）：retain 不接线 / release 不挂
// effect / plan 前缀判定放宽 / 归零不 stop / 失败静默吞 —— 各自用例必须能红。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { ToolRegistry } from '../src/agent/tool';
import {
  activationClaims,
  activationConflict,
  activationFailure,
  activationPlan,
  activationStates,
  clearActivationsForTest,
  declareActivation,
  releaseActivation,
  releaseActivations,
  retainActivation,
} from '../src/composition/activation';
import type { ResolvedComposition } from '../src/composition/roster';
import { EMPTY_SEAM_DISABLED } from '../src/composition/seam-resolution';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import type { SubAgentSpawner } from '../src/plugins/builtin/agent-domain/subagent-tools';
import { SubAgentPool } from '../src/plugins/builtin/subagent-in-process/coordinator';
import type { Provider } from '../src/provider/types';

/** 探针 spec：记账 start/stop 调用次数（不持有真实资源）。 */
function probeSpec(log: string[], tag = 'probe') {
  return {
    resources: ['stdio'] as const,
    start: () => {
      log.push('start:' + tag);
    },
    stop: () => {
      log.push('stop:' + tag);
    },
  };
}

/** 组合产物桩：只有 tools 行面参与激活判定（其余域空）。 */
function compositionWithRows(ids: string[]): ResolvedComposition {
  return {
    tools: ids.map((id) => ({ id, factory: async () => [] })),
    prompt: [],
    capabilities: [],
    shell: [],
    seams: { llm: [], subagents: [], fs: [], shell: [], sessionPersistence: [], loopEvents: [] },
    seamDisabled: EMPTY_SEAM_DISABLED,
    activationDecl: { requires: [], exclusive: [] },
    diagnostics: { unselected: [], disabled: [], seamCapped: [], overridden: [], inserted: [] },
  };
}

function stubProvider(): Provider {
  return {
    name: () => 'stub',
    model: () => 'stub',
    stream: async function* () {
      /* 探针不产流 */
    },
  } as unknown as Provider;
}

const stubSpawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;

afterEach(() => {
  clearActivationsForTest();
});

describe('① 激活账本体（叶模块，无 ctx）', () => {
  it('声明校验：缺 start / 空插件名 / 未知资源类型 = 装载期拒绝（错误不静默）', () => {
    expect(() => declareActivation('acme/x', { start: undefined as never })).toThrow('缺 start 回调');
    expect(() => declareActivation('  ', probeSpec([]))).toThrow('非空插件名');
    expect(() => declareActivation('acme/x', { resources: ['gpu' as never], start: () => {} })).toThrow('未知资源类型');
    // 合法声明通过
    declareActivation('acme/x', probeSpec([]));
    expect(activationPlan(compositionWithRows(['plugin/acme/x/tool']))).toEqual(['acme/x']);
  });

  it('重复声明同一插件 = 拒绝（不静默覆盖）；disposer 幂等 + 陈旧性守卫', () => {
    const spec = probeSpec([]);
    const dispose = declareActivation('acme/x', spec);
    expect(() => declareActivation('acme/x', probeSpec([]))).toThrow('重复声明激活');
    dispose();
    dispose(); // 幂等
    const fresh = declareActivation('acme/x', spec);
    dispose(); // 陈旧 disposer：不得清掉 fresh 那一份
    expect(activationPlan(compositionWithRows(['plugin/acme/x/tool']))).toEqual(['acme/x']);
    fresh();
    expect(activationPlan(compositionWithRows(['plugin/acme/x/tool']))).toEqual([]);
  });

  it('kill switch：未声明激活的插件全程 no-op（retain → null / plan 空集 / release 无动作）', async () => {
    // 声明了别的插件，本组合行属主是 acme/other —— 不在声明表 ⇒ 空集
    declareActivation('acme/x', probeSpec([]));
    expect(activationPlan(compositionWithRows(['plugin/acme/other/tool']))).toEqual([]);
    expect(activationPlan(null)).toEqual([]);
    await expect(retainActivation('acme/other', 'h1')).resolves.toBeNull();
    // 无声明 ⇒ 不产生任何账（不预造空账）
    expect(activationStates()).toEqual([]);
    await releaseActivation(null); // 无句柄 = 无动作
  });

  it('plan 前缀判定含尾斜杠：hologram/web 不误命中 hologram/web-domain 的行', () => {
    declareActivation('hologram/web', probeSpec([]));
    expect(activationPlan(compositionWithRows(['plugin/hologram/web-domain/tools']))).toEqual([]);
    expect(activationPlan(compositionWithRows(['plugin/hologram/web/web_search']))).toEqual(['hologram/web']);
  });

  it('引用计数：两个持有者只 start 一次；释放到零才 stop 一次；账归零即清', async () => {
    const log: string[] = [];
    declareActivation('acme/x', probeSpec(log));
    const h1 = await retainActivation('acme/x', 'agent-1');
    expect(log).toEqual(['start:probe']);
    const h2 = await retainActivation('acme/x', 'agent-2');
    expect(log).toEqual(['start:probe']); // 不重启
    expect(activationStates()).toEqual([{ plugin: 'acme/x', holders: 2, started: true, failure: null }]);

    await releaseActivation(h1);
    expect(log).toEqual(['start:probe']); // 还有持有者 ⇒ 不停
    await releaseActivation(h2);
    expect(log).toEqual(['start:probe', 'stop:probe']);
    expect(activationStates()).toEqual([]); // 归零即清账（不留零计数空账）

    await releaseActivation(h2); // 幂等：陈旧句柄不重复减/不误停
    expect(log).toEqual(['start:probe', 'stop:probe']);
  });

  it('归零后再次激活 = 重新 start（stop 后可复活）', async () => {
    const log: string[] = [];
    declareActivation('acme/x', probeSpec(log));
    await releaseActivations([await retainActivation('acme/x', 'a1')]);
    await releaseActivations([await retainActivation('acme/x', 'a2')]);
    expect(log).toEqual(['start:probe', 'stop:probe', 'start:probe', 'stop:probe']);
  });

  it('并发首次激活共享同一份在途 start（副作用不重复启动）', async () => {
    const log: string[] = [];
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    declareActivation('acme/x', {
      start: async () => {
        log.push('start:async');
        await gate;
      },
    });
    const p1 = retainActivation('acme/x', 'a1');
    const p2 = retainActivation('acme/x', 'a2');
    await Promise.resolve(); // 让在途 start 真正进入
    expect(log).toEqual(['start:async']);
    releaseStart();
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(log).toEqual(['start:async']); // 两个持有者只启动一次
    expect(h1?.ok).toBe(true);
    expect(h2?.ok).toBe(true);
  });

  it('start 抛错 = 激活失败可见且不抛给装配面（P3b 据此跳过行）', async () => {
    declareActivation('acme/x', {
      start: () => {
        throw new Error('端口被占');
      },
    });
    const h = await retainActivation('acme/x', 'a1');
    expect(h?.ok).toBe(false);
    expect(h?.failure).toContain('端口被占');
    expect(activationFailure('acme/x')).toContain('端口被占');
    await releaseActivation(h);
  });
});

describe('② 服务面（ctx.activation 挂组合层插件）', () => {
  it('挂载后可解析、随 fiber dispose 注销', async () => {
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    root.activation.declare('acme/notes', probeSpec([]));
    expect(root.activation.declared()).toEqual(['acme/notes']);
    expect(root.activation.has('acme/notes')).toBe(true);
    await fiber.dispose();
    expect(root.reflect.get('activation')).toBeUndefined();
  });

  it('retainForComposition：按组合行面激活，返回句柄交给调用方释放', async () => {
    const log: string[] = [];
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    root.activation.declare('acme/notes', probeSpec(log));
    const handles = await root.activation.retainForComposition(
      compositionWithRows(['plugin/acme/notes/probe']),
      'holder-1',
    );
    expect(handles).toHaveLength(1);
    expect(log).toEqual(['start:probe']);
    expect(root.activation.states().map((s) => s.holders)).toEqual([1]);
    await root.activation.releaseAll(handles);
    expect(log).toEqual(['start:probe', 'stop:probe']);
    await fiber.dispose();
  });
});

describe('④ requires 显式来源与 exclusive 冲突（S6 P3b）', () => {
  /** 带 requires / exclusive 声明的组合桩。 */
  function compWith(ids: string[], decl: { requires?: string[]; exclusive?: string[] }): ResolvedComposition {
    return {
      ...compositionWithRows(ids),
      activationDecl: { requires: decl.requires ?? [], exclusive: decl.exclusive ?? [] },
    };
  }

  it('requires 是显式激活来源：没有工具行也照样激活（面板/命令类插件）', async () => {
    const log: string[] = [];
    declareActivation('acme/notes', probeSpec(log));
    // 组合里没有 plugin/acme/notes/… 行——靠 requires 声明激活
    const comp = compWith(['plugin/hologram/web-domain/web_search'], { requires: ['acme/notes'] });
    expect(activationPlan(comp)).toEqual(['acme/notes']);
    const handle = await retainActivation('acme/notes', 'a1');
    expect(log).toEqual(['start:probe']);
    await releaseActivation(handle);
  });

  it('requires 里未声明激活的插件不进激活集（没有副作用可起）', () => {
    declareActivation('acme/notes', probeSpec([]));
    const comp = compWith([], { requires: ['hologram/review-domain'] });
    expect(activationPlan(comp)).toEqual([]);
  });

  it('exclusive 冲突：同一资源被两个插件声明 ⇒ 后装配者被拒 + 原因含双方 id', async () => {
    const log: string[] = [];
    declareActivation('acme/a', { ...probeSpec(log, 'a'), exclusive: ['port:9310'] });
    declareActivation('acme/b', { ...probeSpec(log, 'b'), exclusive: ['port:9310'] });
    const holds = await retainActivation('acme/a', 'agent-1');
    expect(log).toEqual(['start:a']);

    await expect(retainActivation('acme/b', 'agent-2')).rejects.toThrow('独占资源冲突');
    // 拒绝后装配者：B 未启动、未留账
    expect(log).toEqual(['start:a']);
    expect(activationStates().map((s) => s.plugin)).toEqual(['acme/a']);
    const conflict = activationConflict();
    expect(conflict?.resource).toBe('port:9310');
    expect(conflict?.heldBy).toBe('acme/a');
    expect(conflict?.rejected).toBe('acme/b');
    // 先装配者不受影响
    expect(activationClaims()).toEqual([{ resource: 'port:9310', plugin: 'acme/a' }]);

    // 释放 A ⇒ 资源回到自由态，B 可再装配
    await releaseActivation(holds);
    expect(activationClaims()).toEqual([]);
    const hb = await retainActivation('acme/b', 'agent-2');
    expect(hb?.ok).toBe(true);
    expect(log).toEqual(['start:a', 'stop:a', 'start:b']);
    await releaseActivation(hb);
  });

  it('组合层 exclusive 声明同等参与冲突；同一插件重复 retain 不冲突', async () => {
    declareActivation('acme/a', probeSpec([]));
    const h1 = await retainActivation('acme/a', 'agent-1', ['stdio']);
    expect(activationClaims()).toEqual([{ resource: 'stdio', plugin: 'acme/a' }]);
    // 同一插件的第二卷：不是冲突（持有者本身）
    const h2 = await retainActivation('acme/a', 'agent-2', ['stdio']);
    expect(activationStates()).toEqual([{ plugin: 'acme/a', holders: 2, started: true, failure: null }]);
    await releaseActivation(h1);
    expect(activationClaims()).toEqual([{ resource: 'stdio', plugin: 'acme/a' }]); // 仍有持有者 ⇒ 不释放资源
    await releaseActivation(h2);
    expect(activationClaims()).toEqual([]);
  });

  it('retainForComposition 冲突 ⇒ 整体回滚后抛错（不留半份记账）', async () => {
    const log: string[] = [];
    declareActivation('acme/a', probeSpec(log, 'a'));
    declareActivation('acme/b', { ...probeSpec(log, 'b'), exclusive: ['port:9310'] });
    declareActivation('acme/c', { ...probeSpec(log, 'c'), exclusive: ['port:9310'] });

    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    // 先用 C 占住资源
    const seeded = await root.activation.retainForComposition(
      compWith(['plugin/acme/c/tool'], { exclusive: ['port:9310'] }),
      'seeded',
    );
    expect(log).toContain('start:c');

    // A（无冲突、声明序在前）先被 retain，随后 B 撞冲突 ⇒ 整批回滚
    await expect(
      root.activation.retainForComposition(compWith(['plugin/acme/a/tool', 'plugin/acme/b/tool'], {}), 'agent-x'),
    ).rejects.toThrow('独占资源冲突');
    expect(log).toContain('start:a');
    expect(log).toContain('stop:a'); // 回滚：A 的记账被释放
    expect(root.activation.states().map((s) => s.plugin)).toEqual(['acme/c']);

    await root.activation.releaseAll(seeded);
    await fiber.dispose();
  });

  it('第四栏读面：skipped = 激活失败的插件 + 原因（start 抛错）', async () => {
    declareActivation('acme/ok', probeSpec([]));
    declareActivation('acme/bad', {
      start: () => {
        throw new Error('端口被占');
      },
    });
    const root = new Context();
    const fiber = root.plugin(compositionServicesPlugin);
    await fiber;
    await root.activation.retainForComposition(
      compWith(['plugin/acme/ok/tool', 'plugin/acme/bad/tool'], {}),
      'agent-1',
    );
    const skipped = root.activation.skipped();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.id).toBe('acme/bad');
    expect(skipped[0]?.reason).toContain('端口被占');
    await fiber.dispose();
  });
});

describe('③ 装配面（runtime：装配期 retain + AgentContext.effect 对称释放）', () => {
  it('开卷 → start；第二卷 → 复用（不重启）；全关 → stop（序列 E 骨架）', async () => {
    const log: string[] = [];
    const root = new Context();
    const svcFiber = root.plugin(compositionServicesPlugin);
    await svcFiber;
    root.activation.declare('acme/notes', probeSpec(log));

    const comp = compositionWithRows(['plugin/acme/notes/probe']);
    const rt = new AgentRuntime(undefined, root, comp);
    await rt.ready();
    const config = () => ({
      projectPath: '',
      provider: stubProvider(),
      tools: new ToolRegistry(),
      subAgentPool: new SubAgentPool(),
      subAgentSpawner: stubSpawner,
      eventSink: () => {},
    });

    const h1 = await rt.createAgent(config(), comp);
    expect(log).toEqual(['start:probe']); // 装配期首次激活
    const h2 = await rt.createAgent(config(), comp);
    expect(log).toEqual(['start:probe']); // 第二卷复用同一副作用
    expect(root.activation.states()).toEqual([{ plugin: 'acme/notes', holders: 2, started: true, failure: null }]);

    h1.dispose();
    await vi.waitFor(() => expect(root.activation.states().map((s) => s.holders)).toEqual([1]));
    expect(log).toEqual(['start:probe']); // 还有一卷 ⇒ 不停

    h2.dispose();
    await vi.waitFor(() => expect(log).toEqual(['start:probe', 'stop:probe']));
    expect(root.activation.states()).toEqual([]);

    await svcFiber.dispose();
  });

  it('零漂移：组合里没有声明插件的行 ⇒ 装配期零激活零账（缺省 no-op）', async () => {
    const log: string[] = [];
    const root = new Context();
    const svcFiber = root.plugin(compositionServicesPlugin);
    await svcFiber;
    root.activation.declare('acme/notes', probeSpec(log));

    const comp = compositionWithRows(['plugin/hologram/web-domain/web_search']);
    const rt = new AgentRuntime(undefined, root, comp);
    await rt.ready();
    const h = await rt.createAgent(
      {
        projectPath: '',
        provider: stubProvider(),
        tools: new ToolRegistry(),
        subAgentPool: new SubAgentPool(),
        subAgentSpawner: stubSpawner,
        eventSink: () => {},
      },
      comp,
    );
    expect(log).toEqual([]);
    expect(root.activation.states()).toEqual([]);
    h.dispose();
    await vi.waitFor(() => expect(root.activation.states()).toEqual([]));
    await svcFiber.dispose();
  });

  it('无 cordis 挂载（腰外单测）⇒ 装配照常、零激活面（既有测试零漂移的构造性根据）', async () => {
    declareActivation('acme/notes', probeSpec([]));
    const comp = compositionWithRows(['plugin/acme/notes/probe']);
    const rt = new AgentRuntime(undefined, undefined, comp);
    await rt.ready();
    const h = await rt.createAgent(
      {
        projectPath: '',
        provider: stubProvider(),
        tools: new ToolRegistry(),
        subAgentPool: new SubAgentPool(),
        subAgentSpawner: stubSpawner,
        eventSink: () => {},
      },
      comp,
    );
    expect(activationStates()).toEqual([]); // 无 ctx.activation ⇒ 不记账
    h.dispose();
  });
});
