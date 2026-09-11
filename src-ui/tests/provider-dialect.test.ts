// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 方言解析器守护（2026-08-27 provider 插件化收口；同日平台化 Phase 1 D2 修订版升格）：
//   ① 无服务/无 adapter → PROVIDER_DIALECT 响亮报错（降级显式非静默，P1-C2）
//   ② 第一方装配（llm-adapters-plugin）后内核 anthropic/openai 可用（生产路径）
//   ③ 贡献覆盖同 kind **后注册胜**（对齐 renderer-service 语义），dispose 分层回落
//   ④ 未知 kind 响亮报错并点名已注册方言——钉死「错误不静默」宪法
//     （修复前行为：未知 kind 静默跌进 openai 分支；内核回落 if 分支已拆除，
//      全部方言统一走 ctx.llm 注册表）

import { describe, expect, it } from 'vitest';

import type { LlmAdapterContribution } from '../src/composition/services';
import { activeLlmAdapters, compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { llmAdaptersPlugin } from '../src/plugins/builtin/llm-adapters';
import { createProvider } from '../src/provider/index';
import type { Provider, ProviderRuntimeArgs } from '../src/provider/types';

/** 方言桩：只带可断言的 name 标记，其余为空实现。 */
function stub(tag: string): Provider {
  return {
    name: () => tag,
    model: () => tag,
    stream: async function* () {
      /* 探针不产流 */
    },
  };
}

function dialect(id: string, kind: string, tag: string): LlmAdapterContribution {
  return { id, kind, create: () => stub(tag) };
}

/** 与 provider-live.test 的种子同构的最小 settings 行。 */
const SETTINGS = (kind: string) => ({
  kind,
  name: 'p1',
  apiKey: 'test-key',
  baseUrl: 'http://a.test/v1',
  model: 'm1',
});

/** 生产最小装配复现：四 service + 第一方 llm-adapters（内核方言贡献在册）。 */
async function booted(): Promise<{ dispose: () => Promise<void> }> {
  const root = new Context();
  const servicesFiber = root.plugin(compositionServicesPlugin);
  await servicesFiber;
  const adaptersFiber = root.plugin(llmAdaptersPlugin);
  await adaptersFiber;
  return {
    dispose: () => adaptersFiber.dispose().then(() => servicesFiber.dispose()),
  };
}

describe('方言解析器（createProvider 收口）', () => {
  // 注意次序：本用例必须是文件内首个 createProvider 调用（验证零装配裸路径）
  it('未装配任何 adapter → PROVIDER_DIALECT 响亮报错（降级显式非静默，P1-C2）', () => {
    let thrown: unknown;
    try {
      createProvider(SETTINGS('openai'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error)?.message ?? '')).toContain('PROVIDER_DIALECT');
  });

  it('第一方 llm-adapters 装配后内核 openai / anthropic 可用，name 直通（生产路径）', async () => {
    const env = await booted();
    try {
      const p = createProvider(SETTINGS('openai'));
      expect(p.name()).toBe('p1');
      expect(typeof p.stream).toBe('function');
      const a = createProvider(SETTINGS('anthropic'));
      expect(a.name()).toBe('p1');
    } finally {
      await env.dispose();
    }
  });

  it('Phase 2：responses 协议（OpenAI Responses）在册——createProvider 可解析', async () => {
    const env = await booted();
    try {
      const r = createProvider(SETTINGS('responses'));
      expect(r.name()).toBe('p1');
      expect(typeof r.stream).toBe('function');
      // adapter 带 label（协议下拉展示面）
      const adapters = activeLlmAdapters();
      const respAdapter = adapters.find((d) => d.kind === 'responses');
      expect(respAdapter).toBeDefined();
      expect(respAdapter?.label).toBe('OpenAI Responses');
    } finally {
      await env.dispose();
    }
  });

  it('未知 kind 响亮报错：点名 kind 与全部已注册方言（不再静默跌进 openai）', async () => {
    const env = await booted();
    try {
      let thrown: unknown;
      try {
        createProvider(SETTINGS('anthromorphic')); // 故意拼错
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const msg = String((thrown as Error)?.message ?? '');
      expect(msg).toContain('PROVIDER_DIALECT');
      expect(msg).toContain('"anthromorphic"');
      expect(msg).toContain('anthropic');
      expect(msg).toContain('openai');
    } finally {
      await env.dispose();
    }
  });
});

interface DialectEnv {
  register(d: LlmAdapterContribution): () => void;
  dispose(): Promise<void>;
}

async function bootedWithRegistry(): Promise<DialectEnv> {
  const root = new Context();
  const servicesFiber = root.plugin(compositionServicesPlugin);
  await servicesFiber;
  const adaptersFiber = root.plugin(llmAdaptersPlugin);
  await adaptersFiber;
  return {
    register: (d) => root.llm.register(d),
    dispose: () => adaptersFiber.dispose().then(() => servicesFiber.dispose()),
  };
}

describe('方言解析器 · 贡献道生命周期', () => {
  it('同 kind 后注册胜；dispose 先注册者不影响后者；全撤回落内核', async () => {
    const env = await bootedWithRegistry();
    try {
      const dA = dialect('probe/a', 'openai', 'TAG-A');
      const dB = dialect('probe/b', 'openai', 'TAG-B');
      const disposeA = env.register(dA);
      const disposeB = env.register(dB);

      // 后注册胜
      expect(createProvider(SETTINGS('openai')).name()).toBe('TAG-B');

      // 先注册者退场不影响后注册者
      disposeA();
      expect(createProvider(SETTINGS('openai')).name()).toBe('TAG-B');

      // 全部退场 → 回落内核
      disposeB();
      expect(createProvider(SETTINGS('openai')).name()).toBe('p1');
    } finally {
      await env.dispose();
    }
  });

  it('非目标 kind 的贡献不干扰其他方言解析', async () => {
    const env = await bootedWithRegistry();
    try {
      const disposeGeminiish = env.register(dialect('probe/x', 'weird-dialect', 'TAG-X'));
      expect(createProvider(SETTINGS('openai')).name()).toBe('p1'); // 不被误伤
      expect(() => createProvider(SETTINGS('weird-dialect'))).not.toThrow(); // 贡献方言自身可解析
      disposeGeminiish();
      expect(() => createProvider(SETTINGS('weird-dialect'))).toThrow(/PROVIDER_DIALECT/); // 撤销后响亮
    } finally {
      await env.dispose();
    }
  });

  it('runtime 实参透传：maxTokensFor / thinking 抵达方言工厂', async () => {
    const env = await bootedWithRegistry();
    try {
      let seen: ProviderRuntimeArgs | null = null;
      const capture: LlmAdapterContribution = {
        id: 'probe/capture',
        kind: 'openai',
        create: (rt) => {
          seen = rt;
          return stub('CAPTURED');
        },
      };
      env.register(capture);
      const p = createProvider({ ...SETTINGS('openai'), modelOverrides: { m1: { maxTokens: 2048 } } });
      expect(p.name()).toBe('CAPTURED');
      expect(seen).not.toBeNull();
      expect(seen?.model).toBe('m1');
      expect(seen?.thinking).toBeUndefined();
      expect(seen?.maxTokensFor('m1')).toBe(2048);
    } finally {
      await env.dispose();
    }
  });
});
