// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// wait 工具行为面 — 「只等目标，不干等」（2026-11-20 取消 durationMs 后立）。
//
// 本批拆掉的是 wait 的固定时长 sleep 兜底：用户原话「这个干等也太傻逼了，我要取消干等传参」。
// 这里按用户操作序列重写判据（旧判据只有 asset-tools 里一个传 durationMs 的夹具，随该行为一并退役）：
//   ① 参数面只剩 agentId / timeoutMs（干等参数不得复活）
//   ② 没有可等目标 = 立即返回（不等 1 毫秒，更不等默认 10s）
//   ③ 有目标 = 落地即返回（单个 / 全部在跑）
//   ④ 超时 = 报还在跑，目标不被杀

import { afterEach, describe, expect, it } from 'vitest';
import { SubAgentStatus } from '../src/agent/subagent-runtime-contract';
import { SubAgentPool } from '../src/plugins/builtin/subagent-in-process/coordinator';
import { createWaitTool } from '../src/plugins/builtin/wait-domain/wait';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function neverFinishes() {
  return (_signal: AbortSignal) => new Promise<{ text: string; err?: string }>(() => {});
}

function finishesAfter(ms: number, text: string) {
  return async (_signal: AbortSignal) => {
    await sleep(ms);
    return { text };
  };
}

const pools: SubAgentPool[] = [];
function newPool(): SubAgentPool {
  const pool = new SubAgentPool();
  pools.push(pool);
  return pool;
}

afterEach(() => {
  for (const p of pools.splice(0)) p.stopAll();
});

/** 立即返回的判据：远小于任何「睡一觉」的粒度（旧实现空参默认 sleep 10s）。 */
const IMMEDIATE_MS = 250;

describe('wait 参数面：干等已拆', () => {
  it('只有 agentId / timeoutMs —— durationMs 不得复活', () => {
    const props = Object.keys(
      (createWaitTool().parameters() as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(props).toContain('agentId');
    expect(props).toContain('timeoutMs');
    expect(props).not.toContain('durationMs');
  });

  it('描述已不含「固定时长兜底」措辞（模型看不到干等入口）', () => {
    const desc = createWaitTool().description();
    expect(desc).toMatch(/event-driven/i);
    expect(desc).not.toMatch(/durationMs/i);
    expect(desc).not.toMatch(/fallback sleep/i);
  });
});

describe('wait：没有可等目标 → 立即返回，不干等', () => {
  it('有池但没有在跑子 Agent：立即说明「无可等待目标」', async () => {
    const t0 = Date.now();
    const out = await createWaitTool(newPool()).execute({});
    expect(out).toContain('没有运行中的子 Agent');
    expect(Date.now() - t0).toBeLessThan(IMMEDIATE_MS);
  });

  it('缺池（装配缺帐）：立即报缺帐，不睡一觉再回「已等待」', async () => {
    const t0 = Date.now();
    const out = await createWaitTool(undefined).execute({});
    expect(out).toContain('没有子 Agent 池');
    expect(out).not.toContain('已等待');
    expect(Date.now() - t0).toBeLessThan(IMMEDIATE_MS);
  });

  it('agentId 不存在：立即报未找到（不拿默认时长去睡）', async () => {
    const pool = newPool();
    const t0 = Date.now();
    const out = await createWaitTool(pool).execute({ agentId: 'sub-nothere' });
    expect(out).toContain('未找到子 Agent sub-nothere');
    expect(Date.now() - t0).toBeLessThan(IMMEDIATE_MS);
  });
});

describe('wait：有目标 → 落地即返回', () => {
  it('传 agentId：等那一个落地，返回状态 + 结果摘要', async () => {
    const pool = newPool();
    const spawned = pool.spawn('跑个小任务', finishesAfter(60, '我是子 Agent 的结论'));
    if (!spawned) throw new Error('spawn failed');
    pool.registerAlias('sub-a', spawned.id);

    const t0 = Date.now();
    const out = await createWaitTool(pool).execute({ agentId: 'sub-a' });
    const elapsed = Date.now() - t0;

    expect(out).toContain('已完成');
    expect(out).toContain('我是子 Agent 的结论');
    expect(elapsed).toBeGreaterThanOrEqual(40); // 真的等了目标，不是立刻返回
    expect(elapsed).toBeLessThan(1200);
  });

  it('不传 agentId：等当前**全部**在跑的子 Agent 落地（慢的那个说了算）', async () => {
    const pool = newPool();
    const fast = pool.spawn('快任务', finishesAfter(40, '快结论'));
    const slow = pool.spawn('慢任务', finishesAfter(160, '慢结论'));
    if (!fast || !slow) throw new Error('spawn failed');

    const t0 = Date.now();
    const out = await createWaitTool(pool).execute({});
    const elapsed = Date.now() - t0;

    expect(out).toContain('2 个子 Agent 全部落地');
    expect(out).toContain('快结论');
    expect(out).toContain('慢结论');
    expect(elapsed).toBeGreaterThanOrEqual(120); // 等到了慢的那个
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('wait：超时只结束这一次等待，不杀目标', () => {
  it('timeoutMs 到点 → 报仍在跑；目标继续运行', async () => {
    const pool = newPool();
    const spawned = pool.spawn('长跑任务', neverFinishes());
    if (!spawned) throw new Error('spawn failed');
    pool.registerAlias('sub-long', spawned.id);

    const out = await createWaitTool(pool).execute({ agentId: 'sub-long', timeoutMs: 120 });
    expect(out).toContain('超时');
    expect(out).toContain('继续等');
    // 目标没被杀：仍在册且仍是 Running
    expect(pool.getHandle('sub-long')?.status).toBe(SubAgentStatus.Running);
  });
});
