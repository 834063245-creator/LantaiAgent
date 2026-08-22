// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-cold-start）：冷启动决策。
// 自 main.ts 机械迁移（S2-4）；workspace-flip 批 1/3（纯会话优先 + 打开流
// 两段化）；V5 拆除（2026-08-22）——星图渲染分支退役（旧「有缓存图→
// 星图视图」不再成立：纸壳是唯一主界面，boot 收尾无条件开纸面板）。
//
// 现职责只剩两件：
//   1. 有缓存项目 → switchWorkspace(skipAnalysis) 恢复工作区数据面
//      （Agent 工具的图谱预热 + 会话续开）；
//   2. 无缓存 → setupPlaceholderAgent（零目录通用会话）。
// 视图不再由此行决定——主视图落点统一在 bootShell 收尾（开纸面板）。

import { isMockMode } from '../../bridge';
import { typedJsonRpc } from '../../rpc-contract';
import type { CachedGraphMeta } from '../../workspace';
import { pushStatus, type ShellRefs, setLoading } from '../runtime';
import { setupPlaceholderAgent, workspaceFlow } from './workspace';

/** 冷启动缓存载荷 — 分页 meta（P0-2）或旧格式全量图（兼容）。 */
interface CachedGraphPayload {
  paged?: boolean;
  meta?: { node_count?: number; source_root?: string; [key: string]: unknown };
  nodes?: unknown;
  edges?: unknown;
}

export async function bootColdStart(_refs: ShellRefs): Promise<void> {
  try {
    let graph: CachedGraphPayload | null = null;
    try {
      graph = await typedJsonRpc<CachedGraphPayload>('load_graph_json', {});
    } catch {
      // 无缓存图谱
    }
    if (!graph) {
      setLoading(false);
      // 在无工作区上下文下设置 agent（仅通用聊天）
      await setupPlaceholderAgent();
      return;
    }

    // P0-2 分页化：load_graph_json 返回 meta-only（paged）或旧格式全量图（兼容）。
    const nodes = graph.nodes;
    const nodeCount = graph.paged
      ? graph.meta?.node_count || 0
      : Array.isArray(nodes)
        ? nodes.length
        : Object.keys((nodes as Record<string, unknown>) || {}).length;
    if (nodeCount > 0) {
      const root: string = graph.meta?.source_root || '';
      if (!root) {
        // 图谱存在但无路径 — 无工作区上下文，占位 agent 兜底
        pushStatus('⚠️ 缓存图谱已加载，但工作区路径丢失 — 请重新绑定目录');
        setLoading(false);
        await setupPlaceholderAgent();
        return;
      }

      // 使用统一的 switchWorkspace 恢复缓存工作区（数据面：图谱预热 + 会话）
      console.log('[init] cold start: switching to cached workspace', root);
      await workspaceFlow.switchWorkspace(root, {
        skipAnalysis: true,
        cachedGraph: graph as CachedGraphMeta,
      });
      console.log('[init] cold start: switchWorkspace done');
      pushStatus(isMockMode() ? '🎨 Mock 模式 — 所见即所得，秒级刷新' : '已恢复上次案卷');
      // 引擎预热通过 runCheck → engine_init（SQLite 缓存）完成。不要在此处触发
      // analyze_project — 它会与 runCheck 的分析回退竞争并阻塞工作区切换。
      return;
    }
  } catch {
    /* 无缓存 */
  }

  // 无缓存图谱 — 占位 Agent（零目录通用会话；主视图由 bootShell 收尾直落纸）
  setLoading(false);
  await setupPlaceholderAgent();
}
