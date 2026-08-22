// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// P14 守护：applyAgentConfig 恒 swap 语义——退役 _agentRebuildKey 手工 diff 后，
// 任何配置信号都从新快照重建 provider 并换引用。钉住三类历史 bug 不复活：
//   ① 手工字段枚举漏字段（temperature 漏过、maxTokens 覆盖差点漏）
//   ② 拆除路径忘重置 diff 键 → 重新填 key 后重建被跳过（P13 #2）
//   ③ setProvider 未写穿 ctx → 子 Agent 继承旧 provider（P13 #1）
// 通过静态源扫描 + 行为断言双轨钉（workspace.ts 是高 fan-in 文件，静态钉防回归）。

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

describe('workspace provider 热切换 — 恒 swap（P14）', () => {
  it('_agentRebuildKey / _lastAgentCfgKey 手工 diff 已整链退役（代码零残留）', () => {
    expect(codeOnly).not.toContain('_agentRebuildKey');
    expect(codeOnly).not.toContain('_lastAgentCfgKey');
  });

  it('applyAgentConfig 无条件重建 provider（恒 swap，无 diff 跳过分支）', () => {
    const start = codeOnly.indexOf('async applyAgentConfig(');
    expect(start).toBeGreaterThan(-1);
    const body = codeOnly.slice(start, codeOnly.indexOf('setupAgent', start));
    expect(body).toContain('this._buildProvider(s)');
    expect(body).toContain('this.agent?.setProvider(prov, pricing)');
    expect(body).toContain('agentSessionState.forEachAgent((h) => h.setProvider(prov, pricing))');
    // 恒 swap = 不存在「只有变化才换」的条件分支包裹重建逻辑
    expect(body).not.toMatch(/if\s*\([^)]*_lastAgentCfgKey/);
  });

  it('key 清空拆除路径存在且不再依赖键重置（P13 #2 语义保留）', () => {
    const start = codeOnly.indexOf('async applyAgentConfig(');
    const body = codeOnly.slice(start, codeOnly.indexOf('setupAgent', start));
    expect(body).toContain("act.apiKey.trim() === ''");
    expect(body).toContain('chatPanel.setAgent(null)');
  });
});
