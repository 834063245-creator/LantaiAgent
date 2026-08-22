// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ── 星图共享类型（P4 拆解：graph.ts 与各渲染模块的公共契约）──

export interface GraphNode {
  id: string;
  name: string;
  type?: string;
  kind?: string;
  location?: string;
  properties?: Record<string, unknown>;
  /** 引擎序列化节点携带的 level-0 社区 id。 */
  community_id?: number | string;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** 引擎序列化边携带的耦合深度。 */
  coupling_depth?: number;
  /** 引擎序列化边携带的方向。 */
  direction?: string;
}
export interface GraphJSON {
  nodes: GraphNode[] | Record<string, GraphNode>;
  edges: GraphEdge[] | Record<string, GraphEdge>;
  meta?: Record<string, unknown>;
  /** 扁平社区 — 引擎序列化图携带。 */
  communities?: CommunityData[];
  /** 层级社区 — 引擎序列化图携带。 */
  hierarchical_communities?: CommunityData[];
}

export interface EdgeData {
  s: number;
  t: number;
  couplingDepth: number;
  edgeType: string;
  direction: string;
  crossFile: boolean;
  /** Resolver couldn't uniquely identify target — heuristic match, may need manual review. */
  ambiguous: boolean;
}
export interface CommunityData {
  id: string;
  label: string;
  node_ids: string[];
  level?: number;
  parent_id?: string | null;
}

// ponytail: diff payload from watcher — added/removed/changed nodes and edges
export interface GraphDiffJson {
  added_nodes: GraphNode[];
  removed_nodes: Array<{ id: string; name: string; type?: string }>;
  modified_nodes: Array<{ node_id: string; name: string; old_kind: string; new_kind: string }>;
  added_edges: GraphEdge[];
  removed_edges: Array<{ id: string; source: string; target: string }>;
}

/** V5 拆除（2026-08-22）后星图渲染面退役（C13 sweep）：本类型降级为兼容形状。
 *  运行时恒持 null（shell/runtime.ts、workspace.ts、chat-core），保留历史调用成员
 *  签名使活代码的守卫分支（if (starGraph) ...）类型面继续成立。
 *  若未来重建渲染层，应在新模块重新定义完整类并替换本形状，勿在本体上堆方法。 */
export interface StarGraph {
  /** 自动补全 / 搜索的可见节点名来源。 */
  getNodeNames(): string[];
  /** 图谱定位符号；返回是否命中。 */
  focusNode(query: string): boolean;
}
