// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tests for transient reminder system — verifies that per-turn injections
// (bg notifications, discoveries, memory updates) are NOT
// persisted in this.session, keeping the session history clean for stable
// cache prefixes across all LLM providers.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock bridge.rpc — used by drain_bg_notifications and agentInvoke
const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import type { Agent } from '../src/agent/agent';
import { ToolRegistry } from '../src/agent/tool';
import type { Provider } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

// ── Helpers ──

function makeMockProvider(): Provider {
  return {
    name: () => 'mock',
    async *stream() {
      yield { type: 5 as any }; // Done
    },
    prewarm() {},
    async fetchModels() {
      return [];
    },
  };
}

function makeAgent(): Agent {
  const prov = makeMockProvider();
  const tools = new ToolRegistry();
  return createTestAgent(prov, tools, 'You are a test agent.', {
    contextWindow: 100000,
    compactRatio: 0.5,
  });
}

// Access private fields via cast
function asAny(agent: Agent): any {
  return agent as any;
}

// ── Tests ──

describe('Transient reminders', () => {
  let agent: Agent;

  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('');
    agent = makeAgent();
  });

  it('getSession() does not contain transient reminders', () => {
    const a = asAny(agent);
    // Simulate what runLoop does: push to transient instead of session
    a._transientReminders.push('<system-reminder>bg notification</system-reminder>');
    a._transientReminders.push('<system-reminder>discovery</system-reminder>');

    const session = agent.getSession();
    const reminderMsgs = session.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<system-reminder>'),
    );
    expect(reminderMsgs).toHaveLength(0);
  });

  it('newSession() clears transient reminders', () => {
    const a = asAny(agent);
    a._transientReminders.push('<system-reminder>old</system-reminder>');
    expect(a._transientReminders).toHaveLength(1);

    agent.newSession();

    expect(a._transientReminders).toHaveLength(0);
  });

  it('_applyPendingMemoryUpdates pushes to transient, not session', () => {
    const a = asAny(agent);
    a._pendingMemoryUpdates = ['memory: updated fact'];
    a._applyPendingMemoryUpdates();

    expect(a._transientReminders).toHaveLength(1);
    expect(a._transientReminders[0]).toContain('memory: updated fact');
    expect(a._transientReminders[0]).toContain('<system-reminder>');

    // Session should not have the memory reminder
    const session = agent.getSession();
    expect(session.some((m) => m.content?.includes('memory: updated fact'))).toBe(false);
  });

  it('_applyPendingMemoryUpdates does nothing when no pending updates', () => {
    const a = asAny(agent);
    a._applyPendingMemoryUpdates();
    expect(a._transientReminders).toHaveLength(0);
  });

  it('tokenCountWithEstimation includes transient reminders', () => {
    const a = asAny(agent);
    // Push a real message to session
    agent.getSession().push({ role: 'user', content: 'hello world' });
    const baseTokens = a.tokenCountWithEstimation();

    // Add transient reminder
    a._transientReminders.push('<system-reminder>extra context</system-reminder>');
    const withTransient = a.tokenCountWithEstimation();

    expect(withTransient).toBeGreaterThan(baseTokens);
  });

  it('extractRecentContext does not include transient reminders', () => {
    const a = asAny(agent);
    // Add a real message to session
    agent.getSession().push({ role: 'user', content: 'real user message' });
    agent.getSession().push({ role: 'assistant', content: 'real response' });

    // Add transient reminders (simulating what runLoop does)
    a._transientReminders.push('<system-reminder>should not appear in fork context</system-reminder>');

    const context = agent.extractRecentContext(12);
    expect(context).not.toContain('should not appear in fork context');
    expect(context).toContain('real user message');
  });

  it('session stays clean across multiple simulated turns', () => {
    const a = asAny(agent);

    // Simulate 5 turns of injections
    for (let i = 0; i < 5; i++) {
      // Simulate runLoop top: clear transient (step > 0)
      if (i > 0) a._transientReminders = [];
      // Simulate injections
      a._transientReminders.push(`<system-reminder>bg notes turn ${i}</system-reminder>`);
      a._transientReminders.push(`<system-reminder>discovery turn ${i}</system-reminder>`);
      // Simulate a real user message + assistant response
      agent.getSession().push({ role: 'user', content: `user message ${i}` });
      agent.getSession().push({ role: 'assistant', content: `response ${i}` });
    }

    // After 5 turns, session should only have system + 10 messages (5 user + 5 assistant)
    const session = agent.getSession();
    const reminderMsgs = session.filter(
      (m) => typeof m.content === 'string' && m.content.includes('<system-reminder>'),
    );
    expect(reminderMsgs).toHaveLength(0);
    // system + 5 user + 5 assistant = 11
    expect(session).toHaveLength(11);
  });
});
