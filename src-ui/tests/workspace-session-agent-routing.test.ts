// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多会话 Agent 路由（landmine L4 回归，2026-11-05）
//
// 雷：工作区曾用共享 `agentRef`（= 最后创建的卷）承担两件事——agent_spawn 的
// spawner 与 turn-start 提醒注入。并发多卷时，A 卷的派生/提醒会落到 B 卷（与
// 2026-08-13 多会话错位事故同族）。修法：
//   · 工厂内每会话一个 `sessionAgentRef`，spawn 与提醒注入只认本槽；
//   · 本槽的 spawner 传进 `createAgent` 的 config —— 这是 spawn-tool capability
//     的 `when` 输入：不传 ⇒ capability 不装，模型只能拿到共享注册表里的基础
//     agent_spawn（L4 根因）；传了 ⇒ capability 把 agent_spawn 换成直接绑
//     `agent.spawnSubAgent` 的版本；
//   · 共享注册表的 spawner 换成 fail-loud 占位——宁可可见失败，也不静默错路由；
//   · 共享 `_agentRef` 整颗删除（唯一读者正是上面两处），raw Agent 引用只留
//     `_lastRawAgent`（记忆保存等工作区级能力）。
//
// 判据是源码形状（与 workspace-lifecycle.test.ts 同款先例）：这两条路由都写在
// `_setupAgentInner` 的工厂闭包里，没有可独立调用的导出面。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(path.resolve(process.cwd(), 'src/workspace.ts'), 'utf8');

function between(start: string, end: string): string {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`锚点缺失: ${start} / ${end}`);
  return src.slice(a, b);
}

const factoryBody = () => between('const factory = async (sessionId: number)', 'chatPanel.setAgentFactory(factory)');
const sharedRegistryBody = () => between('private async _buildRegistryLocked', 'this.registry = registry;');

describe('L4 多会话路由：会话内只认本卷 Agent', () => {
  it('工厂为每卷建 sessionAgentRef，spawn 与提醒注入都走它', () => {
    const body = factoryBody();
    expect(body).toContain('const sessionAgentRef: { current: Agent | null } = { current: null };');
    expect(body).toContain('sessionAgentRef.current?.spawnSubAgent(');
    expect(body).toContain('sessionAgentRef.current?.insertMessage(');
    expect(body, 'agent 解析出来后必须填入本卷槽，否则回调静默空转').toContain('sessionAgentRef.current = agent;');
  });

  it('本卷 spawner 传进 createAgent config（spawn-tool capability 的装配输入）', () => {
    const cfg = between('handle = await runtime.createAgent(', 'compositionOverride,');
    expect(cfg).toContain('subAgentSpawner: async');
    expect(cfg).toContain('sessionAgentRef.current?.spawnSubAgent(');
  });

  it('工厂不再读工作区共享 agentRef（错路由源）', () => {
    const body = factoryBody();
    // 大小写敏感：sessionAgentRef 是另一个标识符，不构成豁免
    expect(body).not.toMatch(/\bagentRef\.current/);
    expect(body).not.toContain('_agentRef');
    expect(src).not.toContain('private _agentRef');
  });

  it('共享注册表的 spawner 是 fail-loud 占位，不回落「最后创建的卷」', () => {
    const body = sharedRegistryBody();
    expect(body).toContain('subAgentSpawner: unboundSessionSpawner');
    expect(body).not.toContain('this._agentRef');
    expect(src).toContain("'[agent_spawn] 未绑定会话");
  });
});
