// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方 prompt 段插件（P4 B④ 试点 + 续批）钉住面：
//   1. 贡献清单：插件装载后注册 graph-snapshot/memory/claude-md 三段
//      （序 = 迁出前表尾序——续批新迁段插头部保序，见 migratedPromptSections）；
//   2. 零漂移：通道内缺省拼装（表 10 段 + 贡献 3 段）≡ 迁移前出厂面重述
//      （sections 注入 13 段）——逐字节全等（B④ 搬运的核心承诺）；
//   3. 注册面依赖：无通道环境缺省拼装缺迁移段——convergence 夹具必须经
//      withFirstPartyPromptChannel 复现生产装配面的机制原因（obstacle ③）；
//   4. 段语义保留：applicable 直收 PromptSectionContext——空 graphSnapshot/
//      memorySection/claudeMdSection 时迁移段跳过（与表内时代逐字同行为，
//      无实例缓存障碍）；
//   5. 通道腰生命周期：run 期间贡献在册，run 返回后读取面归零（prompt 是
//      字节敏感面，拆卸不残留）。

import { describe, expect, it } from 'vitest';
import { withFirstPartyPromptChannel } from '../src/composition/first-party-prompts';
import {
  assembleSystemPrompt,
  builtinPromptSections,
  migratedPromptSections,
} from '../src/composition/prompt-sections';
import { activePromptContributions, promptsServicePlugin } from '../src/composition/prompt-service';
import { Context } from '../src/cordis';
import { promptSegmentsPlugin } from '../src/plugins/prompt-segments-plugin';

const FULL_CTX = {
  graphData: { nodes: [] },
  projectPath: '/p',
  memorySection: 'mem',
  graphSnapshot: 'snap',
  claudeMdSection: 'md',
  providerName: 'deepseek',
  shellEnvSection: 'env-line',
};

describe('第一方 prompt 段插件（P4 B④ 试点 + 续批）', () => {
  it('贡献清单：插件装载注册 graph-snapshot/memory/claude-md（序 = 迁出前表尾序）', async () => {
    const root = new Context();
    const svcFiber = await root.plugin(promptsServicePlugin);
    const segFiber = await root.plugin(promptSegmentsPlugin);
    expect(activePromptContributions().map((s) => s.id)).toEqual(['graph-snapshot', 'memory', 'claude-md']);
    await segFiber.dispose();
    await svcFiber.dispose();
  });

  it('零漂移：通道内缺省拼装 ≡ 迁移前出厂面重述（sections 注入 13 段）', async () => {
    // 迁移前出厂面重述：表 + 迁出段一并注入（无通道 = 无贡献追加）
    const preMigrationFace = assembleSystemPrompt(FULL_CTX, [...builtinPromptSections(), ...migratedPromptSections()]);
    await withFirstPartyPromptChannel(async () => {
      expect(assembleSystemPrompt(FULL_CTX)).toBe(preMigrationFace);
    });
  });

  it('注册面依赖：无通道环境缺省拼装缺迁移段（夹具须包腰的机制原因）', () => {
    const out = assembleSystemPrompt(FULL_CTX);
    expect(out).not.toContain('## 记忆库');
    expect(out).not.toContain('## 项目架构快照');
    expect(out).not.toContain('## 项目规范');
    // 表内段不受影响
    expect(out).toContain('## 行为规则');
    expect(out).toContain('## 多 Agent 协作');
  });

  it('段语义保留：applicable 收装配期真值——空白 snapshot/memory/claudeMd 跳过', async () => {
    const root = new Context();
    const svcFiber = await root.plugin(promptsServicePlugin);
    const segFiber = await root.plugin(promptSegmentsPlugin);
    const out = assembleSystemPrompt({
      graphData: { nodes: [] },
      projectPath: '/p',
      memorySection: '',
      claudeMdSection: '',
      shellEnvSection: 'env-line',
    });
    expect(out).not.toContain('## 项目架构快照');
    expect(out).not.toContain('## 记忆库');
    expect(out).not.toContain('## 项目规范');
    // 命中条件时参与（通道内贡献 render 直收 PromptSectionContext）
    const hit = assembleSystemPrompt(FULL_CTX);
    expect(hit).toContain('## 项目架构快照\n```\nsnap');
    expect(hit).toContain('## 记忆库\nmem');
    expect(hit).toContain('## 项目规范\nmd');
    await segFiber.dispose();
    await svcFiber.dispose();
  });

  it('通道腰生命周期：run 期间贡献在册，run 返回后读取面归零', async () => {
    expect(activePromptContributions()).toEqual([]);
    const result = await withFirstPartyPromptChannel(async () => {
      expect(activePromptContributions().map((s) => s.id)).toEqual(['graph-snapshot', 'memory', 'claude-md']);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(activePromptContributions()).toEqual([]);
  });
});
