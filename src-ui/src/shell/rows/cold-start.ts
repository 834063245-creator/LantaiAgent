// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-cold-start）：冷启动决策。
// 自 main.ts 机械迁移（S2-4）；workspace-flip 批 1/3（纯会话优先 + 打开流
// 两段化）；V5 拆除（2026-08-22）——星图渲染分支退役（旧「有缓存图→
// 星图视图」不再成立）。
// workspace-session-ownership-rework（2026-08-27）：setupPlaceholderAgent
// 退役——零目录/占位工作区移除，无恢复信号 = 直接落案卷首页（不装配 Agent，
// 用户从首页选/建工作区）。
//
// 现职责只剩一件：
//   有恢复信号（引擎开 = 缓存图 source_root；引擎关 = .last_project）→
//   switchWorkspace 恢复工作区数据面（Agent 工具的图谱预热 + 会话续开）；
//   无恢复信号 → 落点首页（不再装配占位 Agent）。
// 视图不再由此行决定——启动落点恒为案卷首页（bootShell 不再开纸面板，
// 2026-08-22 用户拍板；纸面板由用户的新建/续开动作唤起）。

import { isMockMode } from '../../bridge';
import { typedJsonRpc } from '../../rpc-contract';
import { graphEngineEnabled, loadSettings } from '../../settings';
import type { CachedGraphMeta } from '../../workspace';
import { pushStatus, type ShellRefs, setLoading } from '../runtime';
import { workspaceFlow } from './workspace';

/** 冷启动缓存载荷 — 分页 meta（P0-2）或旧格式全量图（兼容）。 */
interface CachedGraphPayload {
  paged?: boolean;
  meta?: { node_count?: number; source_root?: string; [key: string]: unknown };
  nodes?: unknown;
  edges?: unknown;
}

export async function bootColdStart(_refs: ShellRefs): Promise<void> {
  try {
    // 引擎开关（2026-08-22）：关闭时恢复信号不依赖缓存图——load_graph_json
    // 的引擎路径会顺手 engine_init（ensure_engine_graph），关图冷启动绝不能碰。
    // 「最近工作区」记忆 = .last_project（workspace_activate 每次绑定都写，
    // 与图谱引擎无关）——经 get_last_project RPC 读取。
    if (!graphEngineEnabled(loadSettings())) {
      setLoading(false);
      let lastDir: string | null = null;
      try {
        lastDir = await typedJsonRpc<string | null>('get_last_project', {});
      } catch {
        /* 无后端通道（浏览器 mock）→ 落点首页 */
      }
      if (lastDir) {
        console.log('[init] cold start (engine off): restoring last workspace', lastDir);
        await workspaceFlow.switchWorkspace(lastDir, { skipAnalysis: true });
        pushStatus('已恢复上次案卷（图谱引擎已停用）');
      }
      // 无恢复信号 → 落点案卷首页（不装配 Agent，用户从首页选/建工作区）
      return;
    }
    let graph: CachedGraphPayload | null = null;
    try {
      graph = await typedJsonRpc<CachedGraphPayload>('load_graph_json', {});
    } catch {
      // 无缓存图谱
    }
    if (!graph) {
      // 无缓存图谱 → 落点案卷首页（无工作区上下文不装配 Agent）
      setLoading(false);
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
        // 图谱存在但无路径 — 无工作区上下文，落点首页（不装配占位 Agent）
        pushStatus('⚠️ 缓存图谱已加载，但工作区路径丢失 — 请重新绑定目录');
        setLoading(false);
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

  // 无缓存图谱 / 无恢复信号 — 落点案卷首页（不装配 Agent）
  setLoading(false);
}
