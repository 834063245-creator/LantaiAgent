// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 2（hologram/shell-graph）：StarGraph 构造 + WebGL 兜底 +
// AgentVisualizer + GraphInteraction + setDockStarGraph。
// 自 main.ts 96-110（构造）+ 588-595（可视层）机械合并——两段在原
// init() 里隔着 chat 构造，但 graph 段零依赖 chat 段（仅 starGraph），
// 合并行内先构造后接线，语义等价；refs.starGraph 写入供后续行消费。

import { StarGraph } from '../../scene/graph';
import { GraphInteraction } from '../../scene/graph-interaction';
import { setDockStarGraph } from '../../state/dock-config';
import { AgentVisualizer } from '../../ui/agent-visualizer';
import { graphEl, type ShellRefs } from '../runtime';

export function bootGraph(refs: ShellRefs): void {
  // WebGL2 不可用时（旧 WebKitGTK / GPU 被驱动拉黑）构造会抛——
  // 兜底成提示层，保住 React shell 与其余 UI，不再整窗黑屏
  refs.starGraph = null;
  try {
    refs.starGraph = new StarGraph(graphEl);
  } catch (err) {
    console.error('[init] StarGraph 初始化失败（WebGL2 不可用）:', err);
    const tip = document.createElement('div');
    tip.className = 'gl-fallback';
    tip.textContent = '3D 星图初始化失败：当前 WebView 不支持 WebGL2，请升级 WebKitGTK（≥ 2.40）后重启应用';
    graphEl.appendChild(tip);
  }

  // Agent 可视化器（starGraph 缺席 → null，chat 行的 trail 接线判空消费）
  refs.agentViz = refs.starGraph ? new AgentVisualizer(refs.starGraph) : null;

  // 图交互（ponytail：副作用构造函数，scene 信号 store 监听器）
  const _graphInteraction = new GraphInteraction();

  // Dock 面板外部依赖注入（组件已收编进 App 树，这里只写配置槽）
  if (refs.starGraph) setDockStarGraph(refs.starGraph);
}
