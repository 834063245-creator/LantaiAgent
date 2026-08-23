// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// prompts 第六 service（P4 通道 A-1）钉住面：
//   1. 装载：promptsServicePlugin 挂根 Context → ctx.prompts 可解析；
//      fiber dispose → 服务注销（读取面回空集）；
//   2. 注册契约：register → disposer（幂等 + 陈旧性守卫）；重名 id 装载期拒绝；
//   3. 合流点（S4-4 甲）：sections（roster 解析产物）提供即精确清单——
//      贡献段经 factoryComposition 快照已收编进解析域，不再末端追加；缺省
//      = 当前通道贡献（无服务/无贡献 = 空集 = 空输出，构造性保证）；
//   4. 段语义与内置同契约：applicable=false 跳过；render 收全量
//      PromptSectionContext；追加序 = 注册序。

import { describe, expect, it } from 'vitest';
import { assembleSystemPrompt } from '../src/composition/prompt-sections';
import {
  activePromptContributions,
  type PromptContribution,
  PromptsService,
  promptsServicePlugin,
} from '../src/composition/prompt-service';
import { Context } from '../src/cordis';

const CTX = {
  projectPath: '/proj',
  memorySection: '',
  graphSnapshot: '',
  claudeMdSection: '',
  providerName: 'deepseek',
  shellEnvSection: '- OS: win32',
};

function probeSection(id: string, text: string, applicable?: PromptContribution['applicable']): PromptContribution {
  return { id, applicable, render: () => text };
}

describe('prompts service 装载（promptsServicePlugin 挂根 Context）', () => {
  it('挂载后 ctx.prompts 可解析；fiber dispose 后读取面回空集', async () => {
    const root = new Context();
    const fiber = await root.plugin(promptsServicePlugin);
    expect(root.prompts).toBeInstanceOf(PromptsService);
    expect(root.reflect.get('prompts')).toBeDefined();
    await fiber.dispose();
    expect(root.reflect.get('prompts')).toBeUndefined();
    expect(activePromptContributions()).toEqual([]);
  });

  it("外部插件视角：inject ['prompts'] 依赖装载期可解析", async () => {
    const root = new Context();
    const svcFiber = await root.plugin(promptsServicePlugin);
    const consumer = {
      name: 'probe/prompt-consumer',
      inject: ['prompts'],
      apply(ctx: Context) {
        const dispose = ctx.prompts.register(probeSection('probe/greeting', '\n\n## 问候\n你好。'));
        ctx.effect(() => dispose, 'probe-prompt');
      },
    };
    const fiber = await root.plugin(consumer);
    expect(root.prompts.get('probe/greeting')).toBeTruthy();
    await fiber.dispose();
    expect(root.prompts.get('probe/greeting')).toBeUndefined();
    await svcFiber.dispose();
  });
});

describe('注册契约（disposer 幂等 + 陈旧性守卫 + 重名拒绝）', () => {
  it('register → list/get 可见；disposer 幂等；删后同 id 可重注册', async () => {
    const root = new Context();
    const fiber = await root.plugin(promptsServicePlugin);
    const def = probeSection('probe/a', 'A');
    const dispose = root.prompts.register(def);
    expect(root.prompts.get('probe/a')).toBe(def);
    expect(root.prompts.list().map((d) => d.id)).toEqual(['probe/a']);
    dispose();
    dispose(); // 幂等
    expect(root.prompts.get('probe/a')).toBeUndefined();
    const second = root.prompts.register(def); // 拒绝的是共存，不是名字
    expect(root.prompts.get('probe/a')).toBe(def);
    second();
    await fiber.dispose();
  });

  it('同 id 重复注册 throw；陈旧 disposer 不误删后注册的同名行', async () => {
    const root = new Context();
    const fiber = await root.plugin(promptsServicePlugin);
    const def = probeSection('probe/dup', 'D');
    const first = root.prompts.register(def);
    expect(() => root.prompts.register(def)).toThrow('duplicate contribution id "probe/dup"');
    first();
    const fresh = root.prompts.register(def);
    first(); // 陈旧 disposer 再调——不得删掉 fresh
    expect(root.prompts.get('probe/dup')).toBe(def);
    fresh();
    await fiber.dispose();
  });
});

describe('合流点：assembleSystemPrompt 解析域合流（S4-4 甲）', () => {
  it('无服务/无贡献 = 解析产物纯拼装（缺省空表 → 空输出；构造性保证）', () => {
    // B④ 收官：出厂面 = 空解析产物 + 通道贡献——无服务/无贡献时输出为空
    // （出厂段的复现需通道，见 prompt-segments-plugin.test 注册面依赖）
    const a = assembleSystemPrompt(CTX);
    const b = assembleSystemPrompt(CTX, []);
    expect(a).toBe(b); // sections 缺省 = 空贡献，两路恒等
    expect(a).toBe('');
    expect(a).not.toContain('probe-marker');
  });

  it('缺省拼装 = 当前通道贡献（注册序，尾部可见）', async () => {
    const root = new Context();
    const fiber = await root.plugin(promptsServicePlugin);
    const d1 = root.prompts.register(probeSection('probe/one', '\n\n## 一段'));
    const d2 = root.prompts.register(probeSection('probe/two', '\n\n## 二段'));
    const out = assembleSystemPrompt(CTX);
    const i1 = out.indexOf('\n\n## 一段');
    const i2 = out.indexOf('\n\n## 二段');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1); // 注册序 = 拼装序
    d1();
    d2();
    await fiber.dispose();
  });

  it('sections 注入（roster 解析产物）= 精确清单（S4-4 甲：贡献已收编进解析域）', async () => {
    const root = new Context();
    const fiber = await root.plugin(promptsServicePlugin);
    // 解析产物样本：贡献段经 factoryComposition 快照进解析域（此处手工重述
    // 该形态——resolved 段表 + 贡献段同列，roster 解析时已合并）
    const d1 = root.prompts.register(probeSection('probe/merged', '\n\n## 合并段'));
    const resolvedSections = [probeSection('resolved-only', '\n\n## 解析段'), ...(await activePromptContributions())];
    const out = assembleSystemPrompt(CTX, resolvedSections);
    expect(out).toBe('\n\n## 解析段\n\n## 合并段'); // 提供即精确清单——不再末端追加
    d1();
    await fiber.dispose();
  });

  it('applicable=false 的贡献跳过；render 收全量 PromptSectionContext', async () => {
    const root = new Context();
    const fiber = await root.plugin(promptsServicePlugin);
    let seen: string | undefined;
    root.prompts.register({
      id: 'probe/conditional',
      applicable: (ctx) => ctx.providerName === 'anthropic',
      render: (ctx) => {
        seen = ctx.projectPath;
        return '\n\n## 条件段';
      },
    });
    // providerName=deepseek → 跳过（render 不执行）
    const out = assembleSystemPrompt(CTX);
    expect(out).not.toContain('## 条件段');
    expect(seen).toBeUndefined();
    // 命中条件 → 追加且 ctx 全量可见
    const outHit = assembleSystemPrompt({ ...CTX, providerName: 'anthropic' });
    expect(outHit).toContain('\n\n## 条件段');
    expect(seen).toBe('/proj');
    await fiber.dispose();
  });

  it('服务 dispose 后拼装回出厂面（读取面守卫式归零——字节敏感面不残留）', async () => {
    const root = new Context();
    const fiber = await root.plugin(promptsServicePlugin);
    root.prompts.register(probeSection('probe/vanish', '\n\n## 会消失的段'));
    expect(assembleSystemPrompt(CTX)).toContain('## 会消失的段');
    await fiber.dispose();
    // 贡献直接进系统提示词——服务拆卸后读取面必须归零（注册表残留不得
    // 泄漏进后续拼装；四 service 无此清理是面板域的既有宽松面，本通道收紧）
    expect(activePromptContributions()).toEqual([]);
    expect(assembleSystemPrompt(CTX)).not.toContain('## 会消失的段');
  });
});
