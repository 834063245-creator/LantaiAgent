// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 兰台（Lantai）主入口（S2-4 终态：薄引导）
// 引导职责只剩装配：CSS → cordis 内核 → React 壳 → bootShell（壳行表
// 化执行，见 composition/shell-rows.ts；行实现落 src/shell/rows/*）。
// 历史注：三模式星图 minimal/standard/full 独立实例切换重建（v3）；
// Workspace 抽象统一工作区状态（v4.1）；壳行化（S2，2026-08-20）；
// V5 拆除（2026-08-22）——星图 canvas/旧 chrome CSS 随观测台退役，
// 图谱走后台预热 + Agent 工具面（graphData 数据面保留）。

import './app/fonts';
import './app/tokens.css';
import './app/foundation.css';
import './app/shell.css';
import './app/chat/prompt-shelf.css';
import './app/panels/dock-panels/settings-panel.css';
import './app/panels/dock-panels/model-selector.css';
import './app/panels/dock-panels/provider-settings.css';
import './app/panels/PaperPanel.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { initCordisKernel } from './cordis/boot';
import { loadBuiltinPlugins, loadExternalPlugins } from './plugins/loader';
import { bootShell } from './shell/boot';

// ── Cordis 内核引导（cordis-migration P0：根 Context 先于 React 壳与壳行）──
// ── 插件内核（WO-S0B）：第一方插件表装载（组合层四 service + 块渲染器 + 纸壳面板）──
const pluginKernelRoot = loadBuiltinPlugins(initCordisKernel());

// ── React 壳引导（纸壳唯一界面：SessionsHome / DockPanel / 命令面板）──
const appRoot = document.getElementById('app-root');
if (!appRoot) throw new Error('app-root 挂载点不存在——index.html 被破坏');
createRoot(appRoot).render(createElement(App));

// ── 外部插件装载（WO-S0B）：异步不阻塞首帧；结果只进 plugin-store，不炸应用 ──
void loadExternalPlugins(pluginKernelRoot);

// ── 壳引导（S2）：引导三件套 + 组合 patch + 壳行按表序执行 +
//    冷启动收尾（含纸面板直落）。flowDeps 缺省 = 出厂 workspace 流。──
void bootShell();
