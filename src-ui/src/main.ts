// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// HoloGram 主入口（S2-3 壳行化后）
// 引导职责只剩装配：CSS → 内核 → React 壳 → bootShell（行表化执行）。
// init() 主体已拆 12 壳行（composition/shell-rows.ts，行 1-10 落
// src/shell/rows/*）；workspace 流函数（行 11）与冷启动（行 12）S2-4 迁出。
// 三模式星图：minimal / standard / full — 独立实例，切换即重建
// v4.1: Workspace 抽象 — 所有工作区状态统一管理

import './app/fonts';
import './app/tokens.css';
import './app/foundation.css';
import './app/graph-chrome.css';
import './app/shell.css';
import './app/chat/chat.css';
import './app/panels/dock-panels/check-panel.css';
import './app/panels/dock-panels/constraints-panel.css';
import './app/panels/dock-panels/settings-panel.css';
import './app/panels/dock-panels/dataflow-panel.css';
import './app/panels/dock-panels/shared.css';
import './app/panels/dock-panels/model-selector.css';
import './app/panels/dock-panels/provider-settings.css';
import './app/panels/TasksPanel.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { log } from './agent/logger';
import { App } from './app/App';
import { useShellStore } from './app/shell-store';
import { isMockMode } from './bridge';
import { initCordisKernel } from './cordis/boot';
import { withTimeout } from './lifecycle/timeout';
import { loadBuiltinPlugins, loadExternalPlugins } from './plugins/loader';
import { typedRpc } from './rpc-contract';
import type { GraphEdge, GraphJSON, GraphNode } from './scene/graph-types';
import { bootShell } from './shell/boot';
import { FV, loadFileViewer, pushStatus, setLoading, shellRefs } from './shell/runtime';
import { useDockStore } from './state/dock-store';
import { bumpWorkspaceSwitched } from './state/workspace-switch-store';
import { type CachedGraphMeta, isSamePath, loadGraphPages, Workspace } from './workspace';

/** 冷启动缓存载荷 — 分页 meta（P0-2）或旧格式全量图（兼容）。 */
interface CachedGraphPayload {
  paged?: boolean;
  meta?: { node_count?: number; source_root?: string; [key: string]: unknown };
  nodes?: GraphNode[] | Record<string, GraphNode>;
  edges?: GraphEdge[] | Record<string, GraphEdge>;
}

// ── 文件夹选择器 ──

async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false, title: '选择工作区目录' });
    return result as string | null;
  } catch {
    return prompt('输入项目路径:');
  }
}
// ═══════════════════════════════════════════════════════════════
// switchWorkspace — 统一入口（行 11 内容，S2-4 迁 src/shell/rows/workspace.ts）
// ═══════════════════════════════════════════════════════════════

async function switchWorkspace(
  path?: string,
  opts?: { skipAnalysis?: boolean; cachedGraph?: CachedGraphMeta },
): Promise<void> {
  const { starGraph, workspace, wsMachine } = shellRefs;
  const chatPanel = shellRefs.chatPanel;
  if (!starGraph) {
    pushStatus('3D 渲染不可用（WebGL2 初始化失败），无法打开项目');
    return;
  }
  if (!chatPanel) {
    // chat 壳行被禁用的涟漪（设计件 §2.8）：无面板承接会话，无法开项目
    pushStatus('对话面板未初始化，无法打开项目');
    return;
  }
  if (wsMachine.isBusy) {
    pushStatus('正在切换工作区，请稍候…');
    return;
  }
  wsMachine.transition('switching');
  try {
    const folder = path || (await pickFolder());
    if (!folder) {
      wsMachine.forceState('idle');
      return;
    }

    if (workspace?.active && isSamePath(workspace.path, folder)) {
      pushStatus('已在当前工作区');
      wsMachine.forceState(workspace?._health === 'degraded' ? 'degraded' : 'active');
      return;
    }

    // 在可能缓慢的 deactivate() await 之前禁用打开按钮。
    setLoading(true, folder);

    // 停用旧工作区 — 设 5 秒超时以防卡死
    if (workspace) {
      try {
        await withTimeout(workspace.deactivate(chatPanel), 5000, () => {
          console.warn('[switchWorkspace] deactivate timed out, forcing clear');
          shellRefs.workspace?.forceClearState();
        });
      } catch (e) {
        console.error('[switchWorkspace] deactivate error:', e);
        shellRefs.workspace?.forceClearState();
      }
      shellRefs.workspace = null;
    }

    resetCheckPanelState();

    // 创建新工作区 — 立即传入回调，使 Workspace.open（分析 + 渲染）期间
    // 的进度事件推送可见的状态更新。
    const onStatusChange = (msg: string) => {
      pushStatus(msg);
    };
    const onLoadingChange = (loading: boolean) => {
      setLoading(loading, loading ? folder : undefined);
    };
    let ws: Workspace;
    try {
      console.log('[switchWorkspace] calling Workspace.open...');
      ws = await Workspace.open(folder, starGraph, chatPanel, opts, { onStatusChange, onLoadingChange });
      console.log('[switchWorkspace] Workspace.open returned');
    } catch (err) {
      console.error('[switchWorkspace] Workspace.open threw:', err);
      pushStatus(`分析失败: ${err}`);
      setLoading(false);
      wsMachine.forceState('idle');
      throw err;
    }
    ws.onStatusChange = onStatusChange;
    ws.onLoadingChange = onLoadingChange;

    // 接线分析失败回调，用于降级模式
    ws.onAnalysisFailed = (err) => {
      console.warn('[switchWorkspace] background analysis failed:', err);
      pushStatus('⚠️ 后台分析未完成 — 缓存图谱可用，点击重新分析重试');
    };

    shellRefs.workspace = ws;
    wsMachine.transition(ws._health === 'degraded' ? 'degraded' : 'active');
    await notifyAllPanels(ws);

    const gd = ws.graphData;
    const nodeCount = gd ? (Array.isArray(gd.nodes) ? gd.nodes.length : Object.keys(gd.nodes || {}).length) : 0;
    const genRaw = gd?.meta?.generated_at;
    const genTime =
      typeof genRaw === 'string' || typeof genRaw === 'number' ? new Date(genRaw).toLocaleTimeString() : '';
    pushStatus(`✨ ${nodeCount} 节点已就绪${genTime ? ` · ${genTime}` : ''}`);
    log.info('main', 'project loaded', {
      nodes: nodeCount,
      edges: gd ? (Array.isArray(gd.edges) ? gd.edges.length : Object.keys(gd.edges || {}).length) : 0,
    });
    setLoading(false);

    try {
      await ws.setupAgent(chatPanel);
    } catch (e) {
      console.error('[switchWorkspace] setupAgent failed:', e);
    }

    chatPanel.setProjectPath(folder);
    chatPanel.autoRestoreLastSession(folder).catch(() => {});
    ws.runCheck();
    await typedRpc('workspace_start_watcher', {}).catch(() => {});
  } finally {
    // 确保状态机未卡在 'switching' 状态
    if (wsMachine.state === 'switching') {
      wsMachine.forceState(
        shellRefs.workspace?._health === 'degraded' ? 'degraded' : shellRefs.workspace ? 'active' : 'idle',
      );
    }
  }
}

function resetCheckPanelState(): void {
  useDockStore.getState().setCheckResult({
    passed: true,
    timestamp: '',
    changed_files: [],
    total_changed_files: 0,
    l5_violations: [],
    l4_violations: [],
    l3_violations: [],
    l2_violations: [],
    passed_checks: [],
    blast_radius: 0,
    cross_community_edges: 0,
    new_cycles: 0,
    new_thread_conflicts: 0,
    api_signature_changes: 0,
  });
  useShellStore.getState().setViolations(0);
}

async function notifyAllPanels(ws: Workspace): Promise<void> {
  useShellStore.getState().setProjectPath(ws.path);
  useShellStore.getState().setView('graph');
  shellRefs.chatPanel?.setProjectPath(ws.path);
  await loadFileViewer();
  FV()?.get().setProjectPath(ws.path);
  bumpWorkspaceSwitched(); // P1 总线归零：workspace:switched → state/workspace-switch-store
}

// ── 简报 ──

async function runCheck(): Promise<void> {
  const ws = shellRefs.workspace;
  if (ws) await ws.runCheck();
}

// ── 搜索 ──

function doSearch(query: string): void {
  const q = query.trim();
  const sg = shellRefs.starGraph;
  if (!q || !sg) return;
  const found = sg.focusNode(q);
  if (!found) {
    pushStatus(`未找到 "${q}"`);
    setTimeout(() => {
      const st = useShellStore.getState();
      if (st.statusText === `未找到 "${q}"`) st.setStatusText('就绪');
    }, 2000);
  }
}

// ── 变更对比 ──

let _diffActive = false;
async function toggleDiff(): Promise<void> {
  const store = useShellStore.getState();
  const sg = shellRefs.starGraph;
  const ws = shellRefs.workspace;
  if (!sg) return;
  if (_diffActive) {
    sg.clearDiff();
    _diffActive = false;
    store.setDiffActive(false);
    pushStatus('已清除变更着色');
    return;
  }
  if (!ws?.path) {
    pushStatus('请先打开项目');
    return;
  }
  try {
    const beforePath = `${ws.path}/.hologram/baseline.json`;
    const diffJson = await typedRpc('hologram_call', { tool: 'graph_diff', args: { before_path: beforePath } });
    const diff = JSON.parse(diffJson);
    if (diff.is_empty) {
      pushStatus('已创建变更基线 · 再次分析后即可比较差异');
    } else {
      sg.showDiff(diff);
      _diffActive = true;
      store.setDiffActive(true);
      pushStatus(
        `+${diff.added_nodes?.length || 0} / -${diff.removed_nodes?.length || 0} / ~${diff.modified_nodes?.length || 0}`,
      );
    }
  } catch (err) {
    pushStatus(`变更分析失败: ${err}`);
  }
}

// ── Re-analyze — 原地重分析，不切换工作区 ──

async function reanalyze(): Promise<void> {
  const sg = shellRefs.starGraph;
  if (!sg) return;
  if (shellRefs.wsMachine.isBusy) {
    pushStatus('正在切换工作区，请稍候…');
    return;
  }
  const ws = shellRefs.workspace;
  if (!ws?.path) {
    pushStatus('请先打开项目');
    return;
  }
  useShellStore.getState().setAnalyzing('reanalyze');
  pushStatus('重新分析中…');
  try {
    console.log('[reanalyze] step 1: calling analyze_and_load', ws.path);
    const raw = await typedRpc('analyze_and_load', { path: ws.path, force: true });
    console.log('[reanalyze] step 2: analyze_and_load returned meta, length:', raw?.length);
    // 在漫长的 await 期间防止工作区切换。
    if (shellRefs.workspace !== ws) {
      console.log('[reanalyze] workspace switched during analysis — discarding result');
      pushStatus('工作区已切换，重分析已取消');
      return;
    }
    // P0-2 分页化：analyze_and_load 只回 meta，图数据逐页拉取重建。
    const meta = JSON.parse(raw) as CachedGraphMeta;
    ws.graphData = {
      meta: meta.meta || {},
      nodes: [],
      edges: [],
      communities: [],
      hierarchical_communities: [],
    };
    await loadGraphPages(ws, sg, meta);
    const nc = Array.isArray(ws.graphData.nodes)
      ? ws.graphData.nodes.length
      : Object.keys(ws.graphData.nodes || {}).length;
    console.log('[reanalyze] step 3: pages loaded, nodes:', nc);
    pushStatus(`✨ ${nc} 节点已就绪`);
    console.log('[reanalyze] step 4: done');
  } catch (e) {
    console.error('[reanalyze] FAILED:', e);
    pushStatus(`重分析失败: ${e}`);
  } finally {
    useShellStore.getState().setAnalyzing(null);
  }
}

// ── Esc 逐层关闭（快捷键经 useGlobalKeys → actions 分发到此）──

function escLayer(): void {
  const sg = shellRefs.starGraph;
  // 图内部 Escape 状态（原在 graph.ts keydown 中，现已统一）
  if (sg?.handleEscape()) return;
  // 全局 UI 层
  const dock = useDockStore.getState();
  if (sg?.isInsideGalaxy) sg.exitGalaxy();
  else if (dock.isOpen('check')) dock.closePanel('check');
  else if (dock.isOpen('constraints')) dock.closePanel('constraints');
  else if (shellRefs.chatPanel?.isOpen()) shellRefs.chatPanel.close();
  else if (FV()?.get().isOpen) FV()?.get().close();
  else sg?.clearAgentHighlight();
}

// ── 辅助：用占位工作区设置 agent（未加载项目）──
async function setupPlaceholderAgent(): Promise<void> {
  if (shellRefs.workspace) return;
  // 清除后端工作区绑定 — 防止上一个项目的 PermissionContext
  // 泄漏到占位工作区的 read_file / list_directory 调用中。
  await typedRpc('workspace_activate', { path: '' }).catch(() => {});
  const ws = Workspace.placeholder();
  ws.onStatusChange = (msg) => {
    pushStatus(msg);
  };
  const chatPanel = shellRefs.chatPanel;
  if (!chatPanel) {
    // chat 壳行被禁用的涟漪（设计件 §2.8）：无面板承接，占位 agent 不装配
    console.warn('[init] chatPanel 缺席，跳过占位 agent 装配');
    return;
  }
  try {
    await ws.setupAgent(chatPanel);
  } catch (e) {
    console.error('[init] setupAgent failed:', e);
  }
}

// ── 冷启动（行 12 内容，S2-4 迁 src/shell/rows/cold-start.ts）──

async function coldStart(): Promise<void> {
  // 打开文件夹按钮（工具栏动作已入 actions 注册表，此处仅欢迎屏按钮）
  document.getElementById('btn-welcome-open')?.addEventListener('click', () => switchWorkspace());

  // ponytail: 点 graph 画布时释放输入框焦点，Three.js canvas 不会自动抢焦点
  document.getElementById('graph')?.addEventListener('pointerdown', () => {
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
  });

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
    const nodeCount = graph.paged
      ? graph.meta?.node_count || 0
      : Array.isArray(graph.nodes)
        ? graph.nodes.length
        : Object.keys(graph.nodes || {}).length;
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
      await switchWorkspace(root, { skipAnalysis: true, cachedGraph: graph });
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

// ── 引导 ──

// ── Cordis 内核引导（cordis-migration P0：根 Context 先于 React 壳与 init）──
// ── 插件内核（WO-S0B）：第一方插件表装载（本阶段空占位，S3 起逐域填充）──
const pluginKernelRoot = loadBuiltinPlugins(initCordisKernel());

// ── React 壳引导（P1：CommandBar/DockRail/StatusBar/命令面板/快捷键浮层）──
createRoot(document.getElementById('app-root')!).render(createElement(App));

// ── 外部插件装载（WO-S0B）：异步不阻塞首帧；结果只进 plugin-store，不炸应用 ──
void loadExternalPlugins(pluginKernelRoot);

// ── 壳引导（S2-3）：行 1-10 按 shell-rows 表序执行（行表经
// composition-store 的 resolved 组合；失败单行隔离）+ 冷启动收尾（行 12
// 暂内联，S2-4 迁出）。flowDeps 过渡期指向本文件的 workspace 流函数——
// S2-4 后指向 src/shell/rows/workspace.ts 真源。 ──
void bootShell({
  switchWorkspace,
  reanalyze,
  toggleDiff,
  doSearch,
  escLayer,
  runCheck,
}).then(() => coldStart());
