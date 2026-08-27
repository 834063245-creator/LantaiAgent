// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// graph 分析后端能力注册表（平台化 Phase 2 · D11，2026-08-27）——ctx.graph seam。
//
// 裁定（D11）：engine 分析查询（hologram_call 动态工具族：symbols/neighbors/
// impact/preflight/cycles/…）从前端直派生为可替换 seam——默认 provider =
// 现有 engine RPC 薄包装（agent/graph-provider.ts，invoke 经 hologram_call）；
// 替代 provider 可以是远程分析后端、MCP 图服务等。
//
// 范围注记（施工⑦）：dataflow_save / dataflow_query 是 .lantai/dataflow 落盘
// RPC，非 engine 分析查询——保持直连不动（见 event-feature-map 同款注记纪律）。
//
// 注册纪律：ContributionRegistry 单一内核复用；disposer 经 ctx.effect 登记。

import { type Context, Service } from '../cordis';
import { seamDisabled } from './seam-resolution';
import { ContributionRegistry } from './services';

/** graph provider：一个「图分析后端」。tool = engine 分析工具名（动态 schema 面），
 *  args = 模型可见参数。返回值 = engine 原始产物（string 或已解析 JSON 值）。 */
export interface GraphProvider {
  /** 注册表寻址 id（稳定行标识）。 */
  id: string;
  invoke(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export class GraphService extends Service {
  private registry = new ContributionRegistry<GraphProvider>('graph');

  constructor(ctx: Context) {
    super(ctx, 'graph');
    setActiveGraph(this);
  }

  register(def: GraphProvider): () => void {
    return this.registry.register(def);
  }

  get(id: string): GraphProvider | undefined {
    return this.registry.get(id);
  }

  list(): GraphProvider[] {
    return this.registry.list();
  }
}

// ── 消费读取面（模块级可变态归属 CONVENTIONS §1.10 第 3 类）──

let _activeGraph: GraphService | null = null;

function setActiveGraph(svc: GraphService): void {
  _activeGraph = svc;
}

/** 注册表原始清单（寻址行源——factoryComposition 的 `seam/graph` 域快照收编本
 *  清单；被组合禁用的行仍在此处，patch 才能重新启用）。 */
export function registeredGraphProviders(): GraphProvider[] {
  return _activeGraph?.list() ?? [];
}

/** 当前 graph provider 贡献（无服务/无注册 = 空集——holoExec 的「后注册胜」扫描源）。
 *  裁剪面（平台化 Phase 3）：组合 `seam/graph` 域禁用的 provider id 从视图剔除。 */
export function activeGraphProviders(): GraphProvider[] {
  const disabled = seamDisabled('graph');
  return registeredGraphProviders().filter((p) => !disabled.has(p.id));
}

/** graph 分析消费单点（hologram 域 holoExec 唯一入口；无注册响亮报错）。 */
export function graphExecute(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const providers = activeGraphProviders();
  const provider = providers[providers.length - 1];
  if (!provider) {
    return Promise.reject(
      new Error('GRAPH_PROVIDER: 无已注册图分析 provider——请确认 graph 通道装配（生产 = loadBuiltinPlugins）'),
    );
  }
  return provider.invoke(tool, args);
}

// ── ctx 通道声明 ──

declare module '../cordis/context' {
  interface Context {
    /** 图分析后端注册表（平台化 Phase 2 · D11）——默认 provider =
     *  builtin/rust-graph（agent/graph-provider.ts）；消费面 = hologram 域 holoExec。 */
    graph: GraphService;
  }
}

/** graph service 挂载插件（loader 第一方表；先于 builtin graph provider 插件）。 */
export const graphServicePlugin = {
  name: 'hologram/graph-service',
  apply(ctx: Context) {
    new GraphService(ctx);
  },
};
