// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace provider 配置守护（Phase C，2026-08-24 工作区归属根治——P14 恒 swap
// 退役落账）。新语义钉住四类历史 bug 不复活：
//   ① 手工字段枚举 diff（_agentRebuildKey——temperature 漏过、maxTokens 差点漏）
//   ② 拆除路径（Key 清空 setAgent(null) → 会话整列消失——用户症状的直接根因）
//   ③ 配置烘焙进构造（factory 无 Key 返 null → Agent 不存在 → 会话不存在）
//   ④ setProvider 未写穿 ctx → 子 Agent 继承旧 provider（P13 #1）
// 现形态：provider = live 无状态适配器（使用点按名现解析），换引用只剩
// 「提供方身份变更」一个场景；Key 清空不拆 Agent，请求期报错。
// 通过静态源扫描钉（workspace.ts 是高 fan-in 文件，静态钉防回归）；live
// provider 行为由 tests/provider-live.test.ts 回归。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, '../src/workspace.ts'), 'utf8');
/** 剥掉行注释与块注释后的代码本体（文档性提及退役物不误报）。 */
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n');

function applyAgentConfigBody(): string {
  const start = codeOnly.indexOf('async applyAgentConfig(');
  expect(start).toBeGreaterThan(-1);
  return codeOnly.slice(start, codeOnly.indexOf('async setupAgent(', start));
}

describe('workspace provider 配置 — 使用点解析（Phase C，恒 swap 退役）', () => {
  it('_agentRebuildKey / _lastAgentCfgKey 手工 diff 已整链退役（代码零残留）', () => {
    expect(codeOnly).not.toContain('_agentRebuildKey');
    expect(codeOnly).not.toContain('_lastAgentCfgKey');
  });

  it('_buildProvider = live 形态（无状态协议适配器，按名现解析）', () => {
    const start = codeOnly.indexOf('private _buildProvider');
    expect(start).toBeGreaterThan(-1);
    const body = codeOnly.slice(start, start + 400);
    expect(body).toContain('createLiveProvider');
  });

  it('applyAgentConfig：身份变更才换引用（唯一换引用场景）', () => {
    const body = applyAgentConfigBody();
    expect(body).toContain('this.prov?.name() !== act.name');
    expect(body).toContain('this._buildProvider(s)');
    expect(body).toContain('this.agent?.setProvider(prov, pricing)');
    expect(body).toContain('agentSessionState.forEachAgent((h) => h.setProvider(prov, pricing))');
  });

  it('Key 清空不再拆 Agent/会话（teardown 分支整体退役）', () => {
    const body = applyAgentConfigBody();
    expect(body).not.toContain('chatPanel.setAgent(null)');
    expect(body).not.toContain('this.agent = null');
    expect(body).not.toContain('this.prov = null');
    // Key 缺失仅诊断呈现（请求期由 live provider 报 MISSING_CREDENTIAL）
    expect(body).toContain('setDiag');
  });

  it('Agent 缺席 → 全量装配 + 恢复历史案卷分支保留（装配失败恢复路径）', () => {
    const body = applyAgentConfigBody();
    expect(body).toContain('if (!this.agent)');
    expect(body).toContain('await this.setupAgent(chatPanel)');
    expect(body).toContain('autoRestoreLastSession');
    const bootstrap = body.indexOf('if (!this.agent)');
    const swap = body.indexOf('this.prov?.name() !== act.name');
    expect(bootstrap).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(bootstrap);
  });

  it('同身份：定价热同步（setPricing，不换引用）', () => {
    const body = applyAgentConfigBody();
    expect(body).toContain('this.agent?.setPricing(pricing)');
    expect(body).toContain('agentSessionState.forEachAgent((h) => h.setPricing(pricing))');
  });

  it('factory：Agent 恒可构造（Key 缺失不再返 null）', () => {
    const start = codeOnly.indexOf('const factory = async (): Promise<AgentHandle | null> =>');
    expect(start).toBeGreaterThan(-1);
    const body = codeOnly.slice(start, codeOnly.indexOf('chatPanel.setAgentFactory(factory)', start));
    expect(body).not.toContain('act.apiKey');
    expect(body).toContain('this._buildProvider(s)');
    // 配置快照来自同步 settings（零 IPC）——凭据不进构造
    expect(body).toContain('const s = loadSettings();');
  });
});
