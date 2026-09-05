// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tests for AgentSessionState — the store that replaced the four
// module-level Maps in chat-session.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentSessionStateApi, createAgentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';

// ── Mock OwnedAgentHandle — minimal shape for testing ──
function mockAgent(cascadeAbort: () => void = () => {}): any {
  return { cascadeAbort, dispose: () => {} };
}

function mockExec(running = false): any {
  let _running = running;
  return {
    isRunning: _running,
    isBusy: _running,
    stop: () => {
      _running = false;
    },
  };
}

describe('AgentSessionState', () => {
  let state: AgentSessionStateApi;

  beforeEach(() => {
    state = createAgentSessionState();
  });

  // ═══════════════════════════════════════════════════════════════
  // Agent handles
  // ═══════════════════════════════════════════════════════════════

  describe('agent handles', () => {
    it('setAgent / getAgent round-trip', () => {
      const agent = mockAgent();
      state.setAgent('panel-1', 1, agent);
      expect(state.getAgent('panel-1', 1)).toBe(agent);
    });

    it('getAgent returns null for unknown session', () => {
      expect(state.getAgent('panel-1', 999)).toBeNull();
    });

    it('removeAgent deletes the handle', () => {
      const agent = mockAgent();
      state.setAgent('panel-1', 1, agent);
      state.removeAgent('panel-1', 1);
      expect(state.getAgent('panel-1', 1)).toBeNull();
    });

    it('composite key isolates panels with same session ID', () => {
      const agentA = mockAgent();
      const agentB = mockAgent();
      state.setAgent('panel-A', 1, agentA);
      state.setAgent('panel-B', 1, agentB);
      expect(state.getAgent('panel-A', 1)).toBe(agentA);
      expect(state.getAgent('panel-B', 1)).toBe(agentB);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Exec state
  // ═══════════════════════════════════════════════════════════════

  describe('exec state', () => {
    it('getOrCreateExec creates on first access', () => {
      const es = state.getOrCreateExec('panel-1', 1);
      expect(es).toBeDefined();
      expect(es.isRunning).toBe(false);
    });

    it('getOrCreateExec returns same instance on second access', () => {
      const es1 = state.getOrCreateExec('panel-1', 1);
      const es2 = state.getOrCreateExec('panel-1', 1);
      expect(es1).toBe(es2);
    });

    it('getExec returns null for unknown session', () => {
      expect(state.getExec('panel-1', 999)).toBeNull();
    });

    it('removeExec cascade-aborts agent and stops exec', () => {
      let aborted = false;
      const agent = mockAgent(() => {
        aborted = true;
      });
      state.setAgent('panel-1', 1, agent);
      state.setExec('panel-1', 1, mockExec(true) as any);
      state.removeExec('panel-1', 1);
      expect(aborted).toBe(true);
      expect(state.getExec('panel-1', 1)).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Agent factory
  // ═══════════════════════════════════════════════════════════════

  describe('agent factory', () => {
    it('setAgentFactory / getAgentFactory round-trip', async () => {
      const factory = async () => mockAgent() as any;
      state.setAgentFactory('panel-1', factory);
      expect(state.getAgentFactory('panel-1')).toBe(factory);
    });

    it('getAgentFactory returns null when not set', () => {
      expect(state.getAgentFactory('unknown')).toBeNull();
    });

    it('setAgentFactory(null) removes the factory', () => {
      const factory = async () => mockAgent() as any;
      state.setAgentFactory('panel-1', factory);
      state.setAgentFactory('panel-1', null);
      expect(state.getAgentFactory('panel-1')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Turn pairs
  // ═══════════════════════════════════════════════════════════════

  describe('turn pairs', () => {
    it('getTurnPairs returns empty array on first access', () => {
      expect(state.getTurnPairs('panel-1', 1)).toEqual([]);
    });

    it('getTurnPairs returns same array reference (mutatable)', () => {
      const tp = state.getTurnPairs('panel-1', 1);
      tp.push({ userText: 'hello', uiMsgId: 'm1', userBubble: null, assistantBubble: null });
      expect(state.getTurnPairs('panel-1', 1)).toHaveLength(1);
    });

    it('setTurnPairs replaces the array', () => {
      const pairs = [{ userText: 'test', uiMsgId: 'm2', userBubble: null, assistantBubble: null }];
      state.setTurnPairs('panel-1', 1, pairs);
      expect(state.getTurnPairs('panel-1', 1)).toBe(pairs);
    });

    it('panels are isolated', () => {
      state.getTurnPairs('panel-A', 1).push({ userText: 'A', uiMsgId: 'mA', userBubble: null, assistantBubble: null });
      state.getTurnPairs('panel-B', 1).push({ userText: 'B', uiMsgId: 'mB', userBubble: null, assistantBubble: null });
      expect(state.getTurnPairs('panel-A', 1)).toHaveLength(1);
      expect(state.getTurnPairs('panel-A', 1)[0].userText).toBe('A');
      expect(state.getTurnPairs('panel-B', 1)[0].userText).toBe('B');
    });

    it('sessions are isolated (concurrent turns never cross)', () => {
      state.getTurnPairs('panel-1', 1).push({ userText: 's1', uiMsgId: 'm1', userBubble: null, assistantBubble: null });
      state.getTurnPairs('panel-1', 2).push({ userText: 's2', uiMsgId: 'm2', userBubble: null, assistantBubble: null });
      expect(state.getTurnPairs('panel-1', 1)).toHaveLength(1);
      expect(state.getTurnPairs('panel-1', 1)[0].userText).toBe('s1');
      expect(state.getTurnPairs('panel-1', 2)[0].userText).toBe('s2');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // clearPanelState
  // ═══════════════════════════════════════════════════════════════

  describe('clearPanelState', () => {
    it('removes all agent handles and exec states for a panel', () => {
      state.setAgent('panel-1', 1, mockAgent());
      state.setAgent('panel-1', 2, mockAgent());
      state.setAgent('panel-2', 1, mockAgent());
      state.getOrCreateExec('panel-1', 1);
      state.getOrCreateExec('panel-1', 2);
      state.getOrCreateExec('panel-2', 1);

      state.clearPanelState('panel-1');

      expect(state.getAgent('panel-1', 1)).toBeNull();
      expect(state.getAgent('panel-1', 2)).toBeNull();
      expect(state.getExec('panel-1', 1)).toBeNull();
      expect(state.getExec('panel-1', 2)).toBeNull();
      // panel-2 untouched
      expect(state.getAgent('panel-2', 1)).not.toBeNull();
      expect(state.getExec('panel-2', 1)).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 句柄所有权 — dispose 语义
  // ═══════════════════════════════════════════════════════════════

  describe('handle ownership (dispose)', () => {
    it('removeAgent disposes the handle before deleting', () => {
      const agent = mockAgent();
      agent.dispose = vi.fn();
      state.setAgent('panel-1', 1, agent);
      state.removeAgent('panel-1', 1);
      expect(agent.dispose).toHaveBeenCalledTimes(1);
      expect(state.getAgent('panel-1', 1)).toBeNull();
    });

    it('setAgent overwriting a different handle disposes the old one', () => {
      const oldAgent = mockAgent();
      oldAgent.dispose = vi.fn();
      const newAgent = mockAgent();
      newAgent.dispose = vi.fn();
      state.setAgent('panel-1', 1, oldAgent);
      state.setAgent('panel-1', 1, newAgent);
      expect(oldAgent.dispose).toHaveBeenCalledTimes(1);
      expect(newAgent.dispose).not.toHaveBeenCalled();
      expect(state.getAgent('panel-1', 1)).toBe(newAgent);
    });

    it('setAgent with the same handle object does NOT dispose it', () => {
      const agent = mockAgent();
      agent.dispose = vi.fn();
      state.setAgent('panel-1', 1, agent);
      state.setAgent('panel-1', 1, agent);
      expect(agent.dispose).not.toHaveBeenCalled();
      expect(state.getAgent('panel-1', 1)).toBe(agent);
    });

    it('clearPanelState disposes all handles of that panel only', () => {
      const a1 = mockAgent();
      a1.dispose = vi.fn();
      const a2 = mockAgent();
      a2.dispose = vi.fn();
      const b1 = mockAgent();
      b1.dispose = vi.fn();
      state.setAgent('panel-1', 1, a1);
      state.setAgent('panel-1', 2, a2);
      state.setAgent('panel-2', 1, b1);
      state.clearPanelState('panel-1');
      expect(a1.dispose).toHaveBeenCalledTimes(1);
      expect(a2.dispose).toHaveBeenCalledTimes(1);
      expect(b1.dispose).not.toHaveBeenCalled();
    });

    it('removeAgent on unknown session is a no-op', () => {
      expect(() => state.removeAgent('panel-1', 999)).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Subscription / version
  // ═══════════════════════════════════════════════════════════════

  describe('subscription', () => {
    it('subscribe fires on state mutation', () => {
      let fired = 0;
      state.subscribe(() => {
        fired++;
      });
      state.setAgent('panel-1', 1, mockAgent());
      expect(fired).toBe(1);
    });

    it('version increments on mutation', () => {
      const v0 = state.version;
      state.setAgent('panel-1', 1, mockAgent());
      expect(state.version).toBeGreaterThan(v0);
    });

    it('unsubscribe stops notifications', () => {
      let fired = 0;
      const unsub = state.subscribe(() => {
        fired++;
      });
      state.setAgent('panel-1', 1, mockAgent());
      const firedAfterFirst = fired;
      unsub();
      state.setAgent('panel-1', 2, mockAgent());
      expect(fired).toBe(firedAfterFirst);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // subscribeExecAll — 运行态同步原语（2026-09-06 运行态割裂根治）
  // ═══════════════════════════════════════════════════════════════

  describe('subscribeExecAll', () => {
    it('订阅即初始触发一次（消费者免自调初始同步）', () => {
      let fired = 0;
      const unsub = state.subscribeExecAll('panel-1', () => {
        fired++;
      });
      expect(fired).toBe(1);
      unsub();
    });

    it('既有实例起停触发（exec.onChange 面）', () => {
      const es = state.getOrCreateExec('panel-1', 1);
      let fired = 0;
      const unsub = state.subscribeExecAll('panel-1', () => {
        fired++;
      });
      fired = 0; // 挖掉初始触发
      es.start();
      expect(fired).toBe(1);
      es.done();
      expect(fired).toBe(2);
      unsub();
    });

    it('迟到实例可见（回归钉——割裂病根）：订阅后才 getOrCreateExec 出生 的实例，其 start() 必须触发', () => {
      let fired = 0;
      const unsub = state.subscribeExecAll('panel-1', () => {
        fired++;
      });
      fired = 0;
      // 惰性水合/拟文路径：实例在订阅之后才出生（捕获式订阅在此永聋）
      const late = state.getOrCreateExec('panel-1', 7);
      expect(fired).toBe(1); // 实例表变更（版本 bump）→ 重挂 + 重算
      late.start();
      expect(fired).toBe(2); // ← 旧「挂载时刻挂一次 onChange」形态在此必失灵
      unsub();
    });

    it('实例更换可见：setExec 换新实例后新实例起停触发、退场实例不再触发', () => {
      const old = createExecState();
      state.setExec('panel-1', 1, old);
      let fired = 0;
      const unsub = state.subscribeExecAll('panel-1', () => {
        fired++;
      });
      fired = 0;
      const fresh = createExecState();
      state.setExec('panel-1', 1, fresh); // 切卷惰性水合 setExec 换实例
      expect(fired).toBe(1); // 重挂 + 重算
      fresh.start();
      expect(fired).toBe(2); // 新实例起停可见
      const before = fired;
      old.start(); // 旧实例已退场——不再触发
      expect(fired).toBe(before);
      unsub();
    });

    it('removeExec 触发重算（后台停卷/删卷路径）', () => {
      state.getOrCreateExec('panel-1', 1);
      let fired = 0;
      const unsub = state.subscribeExecAll('panel-1', () => {
        fired++;
      });
      fired = 0;
      state.removeExec('panel-1', 1);
      // 恰两次：临终实例 stop() 的 onChange 通知 + 版本 bump 重挂重算。
      // 钉精确值顺带钉「无重挂死循环」——超 2 即 rehang 递归。
      expect(fired).toBe(2);
      unsub();
    });

    it('面板隔离：他面板 exec 起停不触发本面板订阅', () => {
      const other = state.getOrCreateExec('panel-2', 1);
      let fired = 0;
      const unsub = state.subscribeExecAll('panel-1', () => {
        fired++;
      });
      fired = 0;
      other.start();
      other.done();
      expect(fired).toBe(0);
      unsub();
    });

    it('退订后不再触发（含此后迟到的实例）', () => {
      let fired = 0;
      const unsub = state.subscribeExecAll('panel-1', () => {
        fired++;
      });
      fired = 0;
      unsub();
      const es = state.getOrCreateExec('panel-1', 1);
      es.start();
      expect(fired).toBe(0);
    });
  });
});
