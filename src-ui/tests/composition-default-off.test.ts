// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S6 P1b：选择集语义（`defaultOff` 行 + `disabled: false` 回开）+ 诊断按**原因分栏**。
//
// 用户序列（设计与实现的对拍面）：
//   1. 插件出货一行「默认关」（ToolContribution.defaultOff）→ 装载照常注册（通道在册、
//      可寻址），但**默认不进任何组合**；
//   2. 用户在自己的 preset 里对该行写 `disabled: false` → 回开（既有语义，零新语法）；
//   3. 诊断面：「某行不见了」有三种原因必须可分——未选中（没选）/ 被禁用（显式关掉）/
//      seam 裁剪（provider 或事件域，根本不是工具行）。
//
// 字节中性：出厂面（standard/minimal）当前**零**贡献声明 defaultOff ⇒ 本批对
// convergence 快照零影响（默认关是惰性能力，谁声明谁生效）。这条由最后一个用例钉住。

import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/agent/tool';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import type { SeamAddressRow } from '../src/composition/roster';
import { type FactoryComposition, factoryComposition, resolveRoster } from '../src/composition/roster';
import { compositionServicesPlugin, type ToolContribution } from '../src/composition/services';
import type { BuiltinToolRow } from '../src/composition/tool-rows';
import { Context } from '../src/cordis';

const ids = (rows: ReadonlyArray<{ id: string }>): string[] => rows.map((r) => r.id);

/** 行工厂：本用例审组合解析的**行面**（谁进组合、诊断归哪栏），不审装配出的工具。 */
function row(id: string, defaultOff?: boolean): BuiltinToolRow {
  return { id, factory: () => [], ...(defaultOff ? { defaultOff: true } : {}) };
}

type Seams = FactoryComposition['seams'];

function factoryOf(tools: BuiltinToolRow[], seamOverrides: Partial<Seams> = {}): FactoryComposition {
  const empty: Seams = { llm: [], subagents: [], fs: [], shell: [], sessionPersistence: [], loopEvents: [] };
  return { tools, prompt: [], capabilities: [], shell: [], seams: { ...empty, ...seamOverrides } };
}

function probeTool(name: string): Tool {
  return {
    name: () => name,
    description: () => 'probe',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => 'ok',
  };
}

describe('S6 P1b 选择集语义：defaultOff 行默认不进组合，preset 写 disabled:false 回开', () => {
  it('默认关的行不进产物，且诊断归「未选中」栏（不是「被禁用」）', () => {
    const f = factoryOf([row('plugin/acme/experimental', true), row('plugin/acme/plain')]);

    const r = resolveRoster(f, []);

    expect(ids(r.tools)).toEqual(['plugin/acme/plain']);
    expect(r.diagnostics.unselected).toEqual(['plugin/acme/experimental']);
    expect(r.diagnostics.disabled).toEqual([]); // 从未进过组合 ≠ 有人关掉了它
  });

  it('preset 写 disabled:false 回开（零新语法——既有 applyDisable 语义位）', () => {
    const f = factoryOf([row('plugin/acme/experimental', true), row('plugin/acme/plain')]);

    const r = resolveRoster(f, [{ tools: [{ id: 'plugin/acme/experimental', disabled: false }] }]);

    expect(ids(r.tools)).toEqual(['plugin/acme/experimental', 'plugin/acme/plain']); // 表序不变
    expect(r.diagnostics.unselected).toEqual([]);
    expect(r.diagnostics.disabled).toEqual([]);
  });

  it('显式禁用普通行归「被禁用」栏；两类原因同卷并存时各归各栏', () => {
    const f = factoryOf([row('plugin/acme/experimental', true), row('plugin/acme/plain')]);

    const r = resolveRoster(f, [{ tools: [{ id: 'plugin/acme/plain', disabled: true }] }]);

    expect(ids(r.tools)).toEqual([]);
    expect(r.diagnostics.disabled).toEqual(['plugin/acme/plain']); // 有人主动关掉
    expect(r.diagnostics.unselected).toEqual(['plugin/acme/experimental']); // 从未被选
  });

  it('seam 裁剪独立成栏（此前与行域禁用混在同一个扁平数组里）', () => {
    const f = factoryOf([], { loopEvents: [{ id: 'turn/start' }] as SeamAddressRow[] });

    const r = resolveRoster(f, [{ 'seam/loopEvents': [{ id: 'turn/start', disabled: true }] }]);

    expect(r.diagnostics.seamCapped).toEqual(['turn/start']);
    expect(r.diagnostics.disabled).toEqual([]); // 旧行为：seam id 混进「禁用行」栏
    expect(r.seamDisabled.loopEvents).toEqual(['turn/start']); // 裁剪面本身不变
  });

  it('贡献面 defaultOff 随折算行进解析域（通道 → pluginToolRows → factoryComposition）', async () => {
    const root = new Context();
    const fiber = await root.plugin(compositionServicesPlugin);
    try {
      const dispose = root.tools.register({
        id: 'acme/experimental',
        defaultOff: true,
        factory: () => probeTool('acme_experimental'),
      } satisfies ToolContribution);

      // 折算行透传标记，且行 id 照常可寻址（装载面照常注册）
      expect(pluginToolRows().find((r) => r.id === 'plugin/acme/experimental')?.defaultOff).toBe(true);

      const r = resolveRoster(factoryComposition(), []);
      expect(ids(r.tools)).not.toContain('plugin/acme/experimental');
      expect(r.diagnostics.unselected).toContain('plugin/acme/experimental');

      // 回开：patch 按 id 寻址（可寻址性 = 装载面照常注册的直接证据）
      const reopened = resolveRoster(factoryComposition(), [
        { tools: [{ id: 'plugin/acme/experimental', disabled: false }] },
      ]);
      expect(ids(reopened.tools)).toContain('plugin/acme/experimental');
      expect(reopened.diagnostics.unselected).toEqual([]);

      dispose();
    } finally {
      await fiber.dispose();
    }
  });

  it('出厂面字节中性：第一方行零声明 defaultOff ⇒ 未选中栏恒空（谁声明谁生效）', async () => {
    await withFirstPartyToolChannel(async () => {
      const r = resolveRoster(factoryComposition(), []);
      expect(r.diagnostics.unselected).toEqual([]);
      expect(ids(r.tools)).toEqual(ids(factoryComposition().tools));
    });
  });
});
