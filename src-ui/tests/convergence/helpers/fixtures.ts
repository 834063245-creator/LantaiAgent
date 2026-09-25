// Convergence 测试基建 — 确定性夹具。
//
// 目标：同一份代码在任何机器、任何时间跑出字节相同的契约输出。
// 内容：录制型 ToolExecutor、标准工具注册表、合成门禁工具、脚本化 Provider。

import { buildToolRegistry } from '../../../src/agent/runtime/agent-builder';
import { registerTaskImplementation } from '../../../src/agent/task-impl';
import type { Tool, ToolExecutor, ToolRegistry } from '../../../src/agent/tool';
import { withFirstPartyCapabilityChannel } from '../../../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../../../src/composition/first-party-tools';
import type { BuiltinToolRow } from '../../../src/composition/tool-rows';
import type { SubAgentSpawner } from '../../../src/plugins/builtin/agent-domain/subagent-tools';
import { SubAgentPool } from '../../../src/plugins/builtin/subagent-in-process/coordinator';
import { taskImplementation } from '../../../src/plugins/builtin/task-domain/implementation';
import { TaskManager } from '../../../src/plugins/builtin/task-domain/task';
import type { Chunk, Provider, Usage } from '../../../src/provider/types';
import { ChunkType } from '../../../src/provider/types';
import type { ToolContribution } from './presets';

// ── task 域实现登记（批 9h-5，2026-09-26）──
//
// 病灶（§3.1 实测教训）：`capability-segments` 的 task-tools capability 在**每次装配**
// 经内核门面 `createTaskManager()` / `createTaskTools()` 取实现；而本夹具是
// **独立进程入口**（`scripts/gen-tool-contract-md.ts` 等直接 import 它，不经
// `tests/setup.ts`）⇒ 不登记就具名 fail-loud（`TASK_DOMAIN_UNAVAILABLE`）。
// 惰性登记（不在模块顶层）：静态顶层 import 会先于测试文件的 `vi.mock` 提升执行，
// 把内核模块预载进模块图——与 `tests/setup.ts` 的 beforeAll + 动态 import 同一条纪律。
let _taskDomainRegistered = false;
export function ensureTaskDomainRegistered(): void {
  if (_taskDomainRegistered) return;
  registerTaskImplementation(taskImplementation);
  _taskDomainRegistered = true;
}

// ── 录制型执行器：不触 Tauri，记录调用并返回空串 ──

export function recordingExec(log: Array<{ name: string; args: Record<string, unknown> }> = []): ToolExecutor {
  return async (name, args) => {
    log.push({ name, args });
    return '';
  };
}

// ── 标准注册表：真实 buildToolRegistry 生产路径 + 确定性依赖 ──
//
// 图谱退役（2026-09-09）后无引擎/图数据依赖——工具面 = 内置行表 + 通道
// 贡献 + 领域收敛（memory/skill 为可选依赖，不传入——生产同样可缺省）。
// P4 B①（2026-08-23）起 git/search 两族经 ctx.tools 第一方插件通道贡献——
// 夹具以 withFirstPartyToolChannel 复现生产装配（标准 = 内置行 + 第一方
// 插件贡献；测试环境不跑 main.ts 引导，通道腰在此补挂）。
// S4-4 甲（2026-08-23）：通道贡献行进组合解析域（factoryComposition 快照）
// ——buildToolRegistry 缺省装配 = 出厂组合（内置行 + 贡献行），toolRows
// 注入 = preset 解析产物（惰性 thunk 在通道腰内求值）。
// B⑤（2026-08-24）：minimal 的 state-hooks capability 行经 ctx.capabilities
// 通道注册——preset 解析（减法组合含 capabilities 域寻址）须在 capability
// 通道腰内求值，与工具通道腰同挂（withFirstPartyCapabilityChannel）。

export async function buildStandardRegistry(
  contributions: ToolContribution[] = [],
  toolRows?: BuiltinToolRow[] | (() => BuiltinToolRow[]),
): Promise<ToolRegistry> {
  ensureTaskDomainRegistered();
  const stubSpawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;
  return withFirstPartyToolChannel(() =>
    withFirstPartyCapabilityChannel(async () => {
      // S4-4 甲：toolRows 支持惰性 thunk——在通道腰内求值使解析域纳入
      // 当前第一方贡献行（minimal 的减法解析含当前贡献行 + state-hooks
      // capability 行；数组直传兼容）。
      const rows = typeof toolRows === 'function' ? toolRows() : toolRows;
      const reg = await buildToolRegistry({
        deps: {},
        taskManager: new TaskManager(),
        subAgentPool: new SubAgentPool(),
        subAgentSpawner: stubSpawner,
        // S4-1b：preset 的工具行（减法型 preset——minimal）；undefined = 出厂组合
        ...(rows ? { toolRows: rows } : {}),
      });
      // 行贡献按组合序（数组序）注册到内置面之后（S1-0 设计件 §2.3：
      // 显式参数，确定性按构造保证）。重名行由 ToolRegistry.register
      // 装载期拒绝（duplicate throw）——S1-3 的冲突拒绝语义已在此就位。
      for (const contribution of contributions) {
        reg.register(contribution.factory());
      }
      return reg;
    }),
  );
}

// ── 合成工具 — planGate / hook 管道快照用（形状对齐 tests/plan-gate.test.ts）──

export function fsDomainTool(executed: string[] = []): Tool {
  return {
    name: () => 'fs',
    description: () => 'fs domain',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    domain: () => 'fs',
    actions: () => ['read', 'write', 'edit', 'list'],
    readOnlyActions: () => ['read', 'list'],
    execute: async (args) => {
      executed.push(String((args as { action?: unknown }).action));
      return 'ok';
    },
  };
}

export function agentDomainTool(executed: string[] = []): Tool {
  return {
    name: () => 'agent',
    description: () => 'agent domain',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    domain: () => 'agent',
    actions: () => ['spawn', 'kill', 'inbox', 'list'],
    readOnlyActions: () => ['inbox', 'list'],
    execute: async (args) => {
      executed.push(String((args as { action?: unknown }).action));
      return 'ok';
    },
  };
}

export function readOnlyTool(executed: string[] = []): Tool {
  return {
    name: () => 'graph_summary',
    description: () => 'summary',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => {
      executed.push('graph_summary');
      return 'ok';
    },
  };
}

/** 可富化工具：post hook 命中时在结果尾部追加标记。 */
export function enrichableTool(): Tool {
  return {
    name: () => 'search_content',
    description: () => 'search',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => 'raw-result',
  };
}

/** 抛错工具：execute 恒抛 Error（错误路径快照用）。 */
export function throwingTool(): Tool {
  return {
    name: () => 'boom_tool',
    description: () => 'throws',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    execute: async () => {
      throw new Error('boom');
    },
  };
}

/** 进度工具：execute 期间发两次 onProgress。 */
export function progressTool(): Tool {
  return {
    name: () => 'slow_tool',
    description: () => 'progress',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async (_args, onProgress) => {
      onProgress?.('chunk-1');
      onProgress?.('chunk-2');
      return 'done';
    },
  };
}

/** preflight 目标工具：命中 GRAPH_PREFLIGHT 名单语义（edit_file）。 */
export function legacyEditTool(): Tool {
  return {
    name: () => 'edit_file',
    description: () => 'legacy edit',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    execute: async () => 'edited',
  };
}

// ── 脚本化 Provider — Phase 2/3 差分测试的确定性模型侧 ──

const USAGE: Usage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  cache_hit_tokens: 0,
  cache_miss_tokens: 10,
  reasoning_tokens: 0,
  cache_creation_tokens: 0,
  finish_reason: 'stop',
};

/** 按脚本逐轮出块的假 Provider：每轮 yield 同一组 chunk。
 *  无状态 — 并发/重放安全；输入敏感脚本请直接写自定义 generator。 */
export function scriptedProvider(script: Chunk[]): Provider {
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: async function* () {
      for (const c of script) yield c;
    },
  };
}

export { ChunkType, USAGE };
