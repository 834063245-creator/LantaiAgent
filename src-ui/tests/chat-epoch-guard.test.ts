// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话恢复/自动保存的 epoch 代际防护 + setAgent(null) 拆除语义
// （landmine-map 工作区生命周期/状态管理家族 H5 + 中危#5）。
//
// Phase B（2026-08-24 工作区归属根治）语义更新：
//   - 恢复路径改为内容层重建（不再经 agent.setAgent 写锚点），epoch 校验
//     锚点换为 sess store 的会话列表写入
//   - setAgent(null) 收窄：注销工厂 + dispose 句柄，不再清会话列表
//     （会话存在性脱离 Agent 装配）
//
// 冻结文件 chat-session.ts 只做最小外科手术，用 T0 静态断言钉住关键结构；
// 行为由现有 chat-session.test.ts / session-ledger.test.ts 回归。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sessionSrc = readFileSync(path.resolve(process.cwd(), 'src/ui/chat-session.ts'), 'utf8');
const coreSrc = readFileSync(path.resolve(process.cwd(), 'src/app/chat/chat-core.ts'), 'utf8');

describe('chat-session H5 — autoRestoreLastSession epoch 防护', () => {
  it('入口记 epoch（getWorkspaceEpoch）', () => {
    const body = sessionSrc.slice(sessionSrc.indexOf('autoRestoreLastSession'));
    // U4/Q1-B：记账退役——epoch 记录点之后是恢复引擎调用（restoreOpenSet）
    expect(body.indexOf('getWorkspaceEpoch()')).toBeLessThan(body.indexOf('restoreOpenSet('));
  });

  it('最终写 store 前有 isCurrentEpoch 校验', () => {
    const restore = sessionSrc.slice(sessionSrc.indexOf('autoRestoreLastSession'));
    // 写 block（会话列表 setState）之前必须有代际校验——恢复引擎 restoreOpenSet
    // 内持有同规校验（函数体在 restoreOpenSet 段落）
    const engine = sessionSrc.slice(sessionSrc.indexOf('async function restoreOpenSet'));
    const guardIdx = engine.indexOf('if (!isCurrentEpoch(epoch)) return;');
    expect(guardIdx).toBeGreaterThan(-1);
    const writeIdx = engine.indexOf('sessions: volumes.map', guardIdx);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(writeIdx);
    void restore;
  });
});

describe('chat-session H5 — scheduleAutoSave epoch 防护', () => {
  it('timer 闭包记 epoch 且触发前校验', () => {
    const body = sessionSrc.slice(sessionSrc.indexOf('export function scheduleAutoSave'));
    expect(body).toContain('const epoch = getWorkspaceEpoch()');
    expect(body).toContain('if (!isCurrentEpoch(epoch)) return;');
  });
});

describe('chat-core 中危#5 — setAgent(null) 语义收窄（Phase B）', () => {
  it('null 拆除注销工厂 + dispose 句柄，但不再清会话列表/消息 store', () => {
    const teardown = coreSrc.slice(coreSrc.indexOf('setAgent(agent: OwnedAgentHandle | null)'));
    const nullBranch = teardown.slice(0, teardown.indexOf('// 替换所有会话'));
    expect(nullBranch).toContain('Session.setAgentFactory(this.panelId, null)');
    expect(nullBranch).toContain('Session.clearPanelAgents(this.panelId)');
    // 会话存在性脱离装配：列表与消息 store 不清（显示不依赖句柄）
    expect(nullBranch).not.toContain('sessions: []');
    expect(nullBranch).not.toContain('disposePanelMessages');
  });
});
