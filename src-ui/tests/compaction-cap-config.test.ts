// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 摘要 cap 的**配置面**（2026-09-23）——`.lantai/compaction-config.json` 的
// summaryMaxTokens 决定摘要调用真正发出的 max_tokens：
//   ① 配置值生效到 host.summaryMaxTokens，并一路到 wire（req.max_tokens）；
//   ② 自动调优回写配置时**保留**该字段（不许把用户手写的 cap 顺手写没）；
//   ③ 缺省 / 坏值回落 SUMMARY_OUTPUT_BUDGET（8192，对齐 DSH），不静默接受垃圾值。
//
// mock 面 = tests/helpers/kernel-fs.ts 的内存 fs（站在 rpc-contract 具名 helper 上）：
// 压缩配置与事件账都经 kernelReadFile/kernelWriteFile 落盘。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import type { Agent } from '../src/agent/agent';
import { SUMMARY_OUTPUT_BUDGET } from '../src/agent/compaction-summarize';
import { createExecState } from '../src/agent/execution-state';
import { ToolRegistry } from '../src/agent/tool';
import type { Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

/** projectPath='.' ⇒ 压缩配置路径（setCompactionConfigPath 的拼法）。 */
const CONFIG_PATH = './.lantai/compaction-config.json';

function configFixture(summaryMaxTokens?: number): string {
  return JSON.stringify({
    compactRatio: 0.5,
    recentKeep: 1,
    ...(summaryMaxTokens === undefined ? {} : { summaryMaxTokens }),
    tunedAt: Date.now(),
    sampleCount: 8,
    avgCompressionRatio: 0.07,
    avgLossFactor: 0.1,
    reasoning: 'fixture',
  });
}

function makeAgent(contextWindow = 200000): { agent: Agent; caps: number[] } {
  const caps: number[] = [];
  const prov: Provider = {
    name: () => 'mock',
    model: () => 'mock',
    prewarm() {},
    async *stream(_signal: AbortSignal, req: any) {
      caps.push(req.max_tokens);
      yield { type: ChunkType.Text, text: '摘要文本' } as any;
      yield { type: ChunkType.Done } as any;
    },
  };
  const agent = createTestAgent(prov, new ToolRegistry(), 'You are a test agent.', {
    contextWindow,
    execState: createExecState(),
  });
  (agent as any).setCompactionConfigPath('.');
  return { agent, caps };
}

function pushMessages(agent: Agent, n: number, tokensEach: number): void {
  const a = agent as any;
  for (let i = 0; i < n; i++) {
    a.session.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '汉'.repeat(tokensEach) });
  }
}

/** 5 次 summary 样本 —— 自动调优的起步门槛（compaction-model 的 MIN_SAMPLES_FOR_TUNE）。 */
function seedTuningSamples(agent: Agent): void {
  for (let i = 0; i < 5; i++) {
    agent.getCompactionTracker().recordCompaction({
      ts: Date.now(),
      regionMsgCount: 20,
      regionTokensEst: 20000,
      summaryInputTokens: 20000,
      summaryOutputTokens: 1500,
      tailMsgCount: 4,
      preTokens: 90000,
      postTokens: 30000,
      outcome: 'summary',
    });
  }
}

describe('摘要 cap 配置面（summaryMaxTokens）', () => {
  beforeEach(() => {
    H.kernelFs!.fs.files.clear();
    H.kernelFs!.fs.writes.length = 0;
  });

  it('配置值生效到 wire 的 max_tokens；自动调优回写不丢该字段', async () => {
    const fs = H.kernelFs!.fs;
    fs.files.set(CONFIG_PATH, configFixture(2048));
    const { agent, caps } = makeAgent();

    // 缺省 = DSH 同款 8192；配置加载后才换成配置值
    expect((agent as any).summaryMaxTokens).toBe(SUMMARY_OUTPUT_BUDGET);
    const applied = await agent.applyAutoTuneConfig();
    expect(applied?.summaryMaxTokens).toBe(2048);
    expect((agent as any).compactRatio).toBe(0.5);
    expect((agent as any).summaryMaxTokens).toBe(2048);

    seedTuningSamples(agent);
    pushMessages(agent, 12, 200);
    await agent.compactNow(new AbortController().signal);

    // ① 配置值一路到 wire
    expect(caps).toEqual([2048]);
    expect(agent.getCompactionStats().events.at(-1)?.summaryMaxTokens).toBe(2048);

    // ② 压缩落地（outcome=summary）触发自动调优回写；compactRatio 0.5 → 夹到 ≥0.7
    //    = changed ⇒ 真发生了一次配置写。
    await vi.waitFor(() => {
      expect(fs.writes.filter((w) => w.file_path.includes('compaction-config.json')).length).toBeGreaterThan(0);
    });
    const written = fs.writes.filter((w) => w.file_path.includes('compaction-config.json')).at(-1)!;
    const persisted = JSON.parse(written.content) as { compactRatio: number; summaryMaxTokens?: number };
    expect(persisted.compactRatio).toBeGreaterThanOrEqual(0.7);
    expect(persisted.summaryMaxTokens).toBe(2048); // ← 手写的 cap 没被写没
  });

  it('缺省 / 坏值回落 8192（不静默接受垃圾值）', async () => {
    const fs = H.kernelFs!.fs;
    const { agent } = makeAgent();

    // 旧配置文件（无此字段）→ 保持缺省
    fs.files.set(CONFIG_PATH, configFixture());
    await agent.applyAutoTuneConfig();
    expect((agent as any).summaryMaxTokens).toBe(SUMMARY_OUTPUT_BUDGET);

    // 坏值（低于可写完整摘要的下限）→ 保持缺省
    fs.files.set(CONFIG_PATH, configFixture(10));
    await agent.applyAutoTuneConfig();
    expect((agent as any).summaryMaxTokens).toBe(SUMMARY_OUTPUT_BUDGET);
  });
});
