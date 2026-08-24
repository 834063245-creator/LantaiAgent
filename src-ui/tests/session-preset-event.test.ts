// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-1b 会话 preset/selected 事件测试 — CR（baseline-change-request.md，
// 用户 2026-08-20 批准「批准全项」）的验收钉面：
//   1. 首事件：Agent 构造必发首条 preset/selected（创建时点事实）；
//   2. newest-wins 重建：改选追加 → 重建用后选；
//   3. reset 语义：改选 → newSession → 重建用**当前默认**（重读默认值，
//      不继承被清掉那个会话的改选——设计件 §2.4 三轮复审裁定）；
//   4. deriveMessages 不消费此 kind（模型可见面零变化）；
//   5. 旧日志兼容：无该事件的会话 → resolveSessionPreset = undefined
//      （调用方以 standard 缺省）；
//   6. replay 兼容：含该事件的快照可重建。

import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent';
import { SessionLog } from '../src/agent/session-log';
import { ToolRegistry } from '../src/agent/tool';
import { usePresetStore } from '../src/state/preset-store';
import { scriptedProvider } from './convergence/helpers/fixtures';

function makeAgent(): Agent {
  return new Agent(scriptedProvider([]), new ToolRegistry(), 'sys', { agentId: 's41b-agent' });
}

describe('S4-1b preset/selected 首事件（CR 批准实施）', () => {
  it('构造必发首条 preset/selected（创建时点事实 = 当前选择态）', () => {
    usePresetStore.setState({ selected: 'standard' });
    const agent = makeAgent();
    const events = agent.getSessionLog().events();
    expect(events[0]?.kind).toBe('session/reset'); // init
    expect(events[1]?.kind).toBe('preset/selected'); // 首事件紧随 init
    expect((events[1]?.data as { presetId: string } | undefined)?.presetId).toBe('standard');
  });

  it('minimal 选择下的构造 → 首事件记 minimal', () => {
    usePresetStore.getState().select('minimal');
    const agent = makeAgent();
    const events = agent.getSessionLog().events();
    expect((events[1]?.data as { presetId: string } | undefined)?.presetId).toBe('minimal');
    usePresetStore.getState().select('standard'); // 还原
  });

  it('改选 → newest-wins 重建用后选', () => {
    const agent = makeAgent();
    agent.selectPreset('minimal');
    expect(agent.sessionPresetId).toBe('minimal');
    const events = agent.getSessionLog().events();
    const presetEvents = events.filter((e) => e.kind === 'preset/selected');
    expect(presetEvents.length).toBe(2); // 首事件 + 改选
    expect((presetEvents[1]?.data as { presetId: string } | undefined)?.presetId).toBe('minimal');
  });

  it('reset 语义：改选 → newSession → 重建用当前默认（不继承改选）', () => {
    usePresetStore.setState({ selected: 'standard' });
    const agent = makeAgent();
    agent.selectPreset('minimal'); // 会话中途改选（事件已追加）
    expect(agent.sessionPresetId).toBe('minimal');
    // newSession（reset）——当前默认仍是 standard → 重发 standard
    agent.newSession();
    expect(agent.sessionPresetId).toBe('standard');
    // 事件序：init → preset(minimal) → reset → preset(standard)
    const kinds = agent
      .getSessionLog()
      .events()
      .map((e) => e.kind);
    const lastPresetIdx = kinds.lastIndexOf('preset/selected');
    const lastResetIdx = kinds.lastIndexOf('session/reset');
    expect(lastPresetIdx).toBeGreaterThan(lastResetIdx); // reset 后有新 preset 事件
    expect((agent.getSessionLog().events()[lastPresetIdx]?.data as { presetId: string } | undefined)?.presetId).toBe(
      'standard',
    );
  });

  it('deriveMessages 不消费此 kind（模型可见面零变化）', () => {
    const agent = makeAgent();
    agent.selectPreset('minimal');
    agent.selectPreset('standard');
    const log = agent.getSessionLog();
    // 投影 = session 数组（首事件不进消息投影——只多 system 头）
    expect(log.deriveMessages()).toEqual(agent.getSession());
    expect(agent.getSession().length).toBe(1); // 仅 system
  });

  it('旧日志兼容：无该事件 → resolveSessionPreset = undefined（缺省语义）', () => {
    const log = new SessionLog();
    log.append('user/message', { message: { role: 'user', content: 'x' } });
    expect(log.resolveSessionPreset()).toBeUndefined();
  });

  it('replay 兼容：含该事件的快照可重建 + resolveSessionPreset 生效', () => {
    const log = new SessionLog();
    log.append('session/reset', { messages: [{ role: 'system', content: 's' }], reason: 'init' });
    log.append('preset/selected', { presetId: 'minimal' });
    const snap = log.snapshot();
    const restored = SessionLog.replay(snap);
    expect(restored.resolveSessionPreset()).toBe('minimal');
    expect(restored.deriveMessages()).toEqual([{ role: 'system', content: 's' }]);
  });

  it('SESSION_EVENT_KINDS 含 preset/selected（封闭集合扩展——CR (a) 项）', async () => {
    const { SESSION_EVENT_KINDS } = await import('../src/agent/session-log');
    expect(SESSION_EVENT_KINDS).toContain('preset/selected');
    expect(Object.isFrozen(SESSION_EVENT_KINDS)).toBe(true);
  });
});
