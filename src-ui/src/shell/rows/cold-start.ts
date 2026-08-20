// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 12（hologram/shell-cold-start）：冷启动决策 + 欢迎屏按钮 +
// 画布焦点释放。自 main.ts 机械迁移（S2-4）。
// 行禁用涟漪（§2.8）：永远欢迎屏（开项目动作仍可用——actions 行独立）。

import { useShellStore } from '../../app/shell-store';
import { isMockMode } from '../../bridge';
import { typedRpc } from '../../rpc-contract';
import type { GraphJSON } from '../../scene/graph-types';
import type { CachedGraphMeta } from '../../workspace';
import { pushStatus, type ShellRefs, setLoading, shellRefs } from '../runtime';
import { setupPlaceholderAgent, workspaceFlow } from './workspace';

/** 冷启动缓存载荷 — 分页 meta（P0-2）或旧格式全量图（兼容）。 */
interface CachedGraphPayload {
  paged?: boolean;
  meta?: { node_count?: number; source_root?: string; [key: string]: unknown };
  nodes?: unknown;
  edges?: unknown;
}

export async function bootColdStart(_refs: ShellRefs): Promise<void> {
  // 打开文件夹按钮（工具栏动作已入 actions 注册表，此处仅欢迎屏按钮）
  document.getElementById('btn-welcome-open')?.addEventListener('click', () => workspaceFlow.switchWorkspace());

  // ponytail: 点 graph 画布时释放输入框焦点，Three.js canvas 不会自动抢焦点
  document.getElementById('graph')?.addEventListener('pointerdown', () => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
  });

  // ═══════════════════════════════════════════════════════════════
  // 冷启动 — 恢复缓存的项目或显示欢迎界面
  // ═══════════════════════════════════════════════════════════════
  try {
    let graph: CachedGraphPayload | null = null;
    try {
      const json = await typedRpc('load_graph_json', {});
      graph = JSON.parse(json) as CachedGraphPayload;
    } catch {
      // 无缓存图谱
    }
    if (!graph) {
      useShellStore.getState().setView('welcome');
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
        // 图谱存在但无路径 — 无工作区渲染
        shellRefs.starGraph?.render(graph as GraphJSON);
        pushStatus('⚠️ 缓存图谱已加载，但工作区路径丢失 — 请重新打开项目');
        useShellStore.getState().setProjectPath('');
        setLoading(false);
        await setupPlaceholderAgent();
        return;
      }

      // 使用统一的 switchWorkspace 加载缓存图谱
      console.log('[init] cold start: switching to cached workspace', root);
      await workspaceFlow.switchWorkspace(root, {
        skipAnalysis: true,
        cachedGraph: graph as CachedGraphMeta,
      });
      console.log('[init] cold start: switchWorkspace done');
      pushStatus(isMockMode() ? '🎨 Mock 模式 — 所见即所得，秒级刷新' : '已加载缓存图谱');
      // 引擎预热通过 runCheck → engine_init（SQLite 缓存）完成。不要在此处触发
      // analyze_project — 它会与 runCheck 的分析回退竞争并阻塞工作区切换。
      return;
    }
  } catch {
    /* 无缓存 */
  }

  // 无缓存图谱 — 显示欢迎界面
  useShellStore.getState().setView('welcome');
  setLoading(false);
  await setupPlaceholderAgent();
}
