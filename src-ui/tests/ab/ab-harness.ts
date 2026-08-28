import type { Agent } from '../../src/agent/agent';
import {
  createGraphContext,
  createGraphContextHook,
  createGraphPreflightHook,
  HookRegistry,
  PreflightHookRegistry,
} from '../../src/agent/hooks';
import { buildSystemPrompt } from '../../src/agent/runtime/agent-builder';
import type { Provider } from '../../src/provider/types';
import { ChunkType } from '../../src/provider/types';
import { createTestAgent } from '../helpers/agent';
import type { TrialGraphData } from './ab-graph';
import { buildTrialRegistry } from './ab-tools';

export interface TrialAgent {
  agent: Agent;
  tokensUsed: () => number;
}

export function countTokens(provider: Provider): { provider: Provider; used: () => number } {
  let total = 0;
  const wrapped: Provider = {
    name: () => provider.name(),
    stream: async function* (signal, req) {
      for await (const chunk of provider.stream(signal, req)) {
        if (chunk.type === ChunkType.Usage && chunk.usage) {
          total += chunk.usage.total_tokens ?? 0;
        }
        yield chunk;
      }
    },
  };
  return { provider: wrapped, used: () => total };
}

export function buildTrialAgent(
  worktree: string,
  graph: TrialGraphData,
  arm: 'on' | 'off',
  provider: Provider,
): TrialAgent {
  // Phase 1.5：GraphContext = file_nodes 按需索引 —— fetcher 就地从
  // trial 图数据按文件分组（与引擎 file_nodes 同口径的模拟实现）。
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const g = graph as unknown as {
    nodes: Array<{ id: string; name?: string; kind?: string; location?: string }>;
    edges: Array<{ source: string; target: string }>;
  };
  for (const e of g.edges) {
    fanOut.set(e.source, (fanOut.get(e.source) || 0) + 1);
    fanIn.set(e.target, (fanIn.get(e.target) || 0) + 1);
  }
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const fetchFileNodes = async (file: string) => {
    const norm = file.replace(/\\/g, '/').toLowerCase();
    return g.nodes
      .filter((n) => (n.location || '').replace(/\\/g, '/').toLowerCase().startsWith(norm))
      .map((n) => ({
        id: n.id,
        name: nodeById.get(n.id)?.name ?? n.name ?? n.id,
        kind: n.kind ?? '',
        fanIn: fanIn.get(n.id) || 0,
        fanOut: fanOut.get(n.id) || 0,
      }));
  };
  const ctx = createGraphContext(fetchFileNodes);
  const registry = buildTrialRegistry(worktree, graph);

  const hooks = new HookRegistry();
  const preflightHooks = new PreflightHookRegistry();
  if (arm === 'on') {
    hooks.register(createGraphContextHook(ctx));
    preflightHooks.register(createGraphPreflightHook(ctx));
  }

  const systemPrompt = buildSystemPrompt(graph as any, worktree, '', '', '', 'DeepSeek');
  const agent = createTestAgent(provider, registry, systemPrompt, {
    agentId: `ab-${arm}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    contextWindow: 131072,
    temperature: 0.2,
  });
  agent.setHooks(hooks);
  agent.setPreflightHooks(preflightHooks);
  return { agent };
}
