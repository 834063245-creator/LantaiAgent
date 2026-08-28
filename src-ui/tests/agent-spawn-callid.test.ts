import { describe, expect, it } from 'vitest';
import { type AgentEvent, EventKind } from '../src/agent/agent-types';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';

// ── Helpers ──

function makeSpawnTool(onExecute: (args: Record<string, unknown>) => Promise<string>): Tool {
  return {
    name: () => 'agent_spawn',
    description: () => 'spawn sub-agent',
    parameters: () => ({
      type: 'object',
      properties: { description: { type: 'string' }, prompt: { type: 'string' } },
      required: ['description', 'prompt'],
    }),
    readOnly: () => false,
    execute: async (args) => onExecute(args),
  };
}

// ── Tests ──

describe('StreamingToolExecutor — agent_spawn _callId injection', () => {
  it('streaming path injects _callId into agent_spawn args', async () => {
    const receivedArgs: Record<string, unknown>[] = [];
    const tool = makeSpawnTool(async (args) => {
      receivedArgs.push({ ...args });
      return JSON.stringify({ task_id: 't1', status: 'started' });
    });
    const registry = new ToolRegistry();
    registry.register(tool);

    const events: AgentEvent[] = [];
    const sink = (ev: AgentEvent) => {
      events.push(ev);
    };

    const executor = new StreamingToolExecutor(registry, sink);
    executor.addTool({ id: 'call-42', name: 'agent_spawn', arguments: '{"description":"test","prompt":"hello"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);

    // The tool should receive _callId = call.id
    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0]._callId).toBe('call-42');
    expect(receivedArgs[0].description).toBe('test');
    expect(receivedArgs[0].prompt).toBe('hello');
  });

  it('streaming path does NOT inject _callId for non-agent_spawn tools', async () => {
    const receivedArgs: Record<string, unknown>[] = [];
    const tool: Tool = {
      name: () => 'read_file_content',
      description: () => 'read file',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: async (args) => {
        receivedArgs.push({ ...args });
        return 'content';
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const executor = new StreamingToolExecutor(registry, () => {});
    executor.addTool({ id: 'call-99', name: 'read_file_content', arguments: '{"filePath":"/test.txt"}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(receivedArgs).toHaveLength(1);
    expect(receivedArgs[0]._callId).toBeUndefined();
  });

  it('agent_spawn ToolDispatch event has correct call id', async () => {
    const tool = makeSpawnTool(async () => JSON.stringify({ task_id: 't2' }));
    const registry = new ToolRegistry();
    registry.register(tool);

    const events: AgentEvent[] = [];
    const sink = (ev: AgentEvent) => {
      events.push(ev);
    };

    const executor = new StreamingToolExecutor(registry, sink);
    executor.addTool({ id: 'call-7', name: 'agent_spawn', arguments: '{"description":"d","prompt":"p"}' });

    await executor.awaitRemaining();

    // Should have ToolDispatch + ToolResult events
    const dispatch = events.find((e) => e.kind === EventKind.ToolDispatch);
    expect(dispatch).toBeDefined();
    expect(dispatch?.tool?.id).toBe('call-7');
    expect(dispatch?.tool?.name).toBe('agent_spawn');
  });
});

// ── 2026-08 修复回归：_owner_id 注入（通知路由身份与隔离身份分离）──
// 修复前：bg job owner 绑定 _agent_id（worktree 隔离 id，主 Agent 为 null），
// 与 bus 注册 id（agent-/sub- 前缀）永不匹配 → 后台任务通知永远无人认领：
// 主 Agent 的通知 owner=None，隔离子 Agent 的通知投给 bus 上不存在的 id。
// 修复后：executor 同时注入 _agent_id（隔离）与 _owner_id（bus id），
// Rust 侧 owner 取 _owner_id 优先。
describe('StreamingToolExecutor — _owner_id injection (bg 通知路由身份)', () => {
  function makePassthroughTool(received: Record<string, unknown>[]): Tool {
    return {
      name: () => 'run_shell',
      description: () => 'shell',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => false,
      execute: async (args) => {
        received.push({ ...args });
        return 'ok';
      },
    };
  }

  it('injects both _agent_id (isolation) and _owner_id (bus id) when both provided', async () => {
    const received: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    registry.register(makePassthroughTool(received));

    // ctor: (tools, emit, agentId, signal, eventBus, ownerId)
    const executor = new StreamingToolExecutor(registry, () => {}, 'agent-123', null, null, 'sub-456');
    executor.addTool({ id: 'call-1', name: 'run_shell', arguments: '{"command":"echo hi"}' });
    await executor.awaitRemaining();

    expect(received).toHaveLength(1);
    expect(received[0]._agent_id).toBe('agent-123'); // worktree 隔离 id
    expect(received[0]._owner_id).toBe('sub-456'); // bus agent id — 通知路由
    expect(received[0].command).toBe('echo hi');
  });

  it('main agent (no isolation) still gets _owner_id — notifications routable', async () => {
    const received: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    registry.register(makePassthroughTool(received));

    // 主 Agent：agentId（隔离 id）为 null，ownerId = bus id
    const executor = new StreamingToolExecutor(registry, () => {}, null, null, null, 'agent-789');
    executor.addTool({ id: 'call-2', name: 'run_shell', arguments: '{"command":"echo main"}' });
    await executor.awaitRemaining();

    expect(received).toHaveLength(1);
    expect(received[0]._agent_id).toBeUndefined(); // 无隔离 — 不注入
    expect(received[0]._owner_id).toBe('agent-789'); // 通知路由身份在场
  });

  it('injects neither when ownerId is null (legacy callers)', async () => {
    const received: Record<string, unknown>[] = [];
    const registry = new ToolRegistry();
    registry.register(makePassthroughTool(received));

    const executor = new StreamingToolExecutor(registry, () => {});
    executor.addTool({ id: 'call-3', name: 'run_shell', arguments: '{"command":"echo legacy"}' });
    await executor.awaitRemaining();

    expect(received).toHaveLength(1);
    expect(received[0]._agent_id).toBeUndefined();
    expect(received[0]._owner_id).toBeUndefined();
  });
});
