// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-workspace）：workspace 流函数族 —
// switchWorkspace / escLayer。
// 自 main.ts 机械迁移（S2-4）；workspace-flip 批 3（打开流两段化）。
// workspace-session-ownership-rework（2026-08-27）：setupPlaceholderAgent 退役——
// 零目录会话/占位工作区已随「会话物理归属工作区」移除，无项目不装配 Agent。
//
// V5 拆除（2026-08-22，纸壳唯一主界面）：星图渲染面退役——switchWorkspace
// 不再构造/等待 StarGraph 渲染，图谱数据面（graphData 分页装载 + graph-
// updated 监听 + runCheck）照旧服务 Agent 工具与简报注入；doSearch /
// reanalyze / toggleDiff（星图交互族）随观测台退役。
//
// 行禁用涟漪（§2.8）：boot 不跑 = flowDeps 未产出 = actions 行跳过注册、
// 冷启动行调 switchWorkspace 一致地失败（直接 import 本模块调用会炸——
// 禁用即不可用，文档声明）。

import { log } from '../../agent/logger';
import { withTimeout } from '../../lifecycle/timeout';
import { typedRpc } from '../../rpc-contract';
import { useDockStore } from '../../state/dock-store';
import { bumpWorkspaceSwitched } from '../../state/workspace-switch-store';
import { useAgentPanelStore } from '../../ui/agent-panel-store';
import type { CachedGraphMeta, Workspace } from '../../workspace';
import { pushStatus, type ShellRefs, setLoading, shellRefs } from '../runtime';

// 惰性取 Workspace 模块（值面）——防组合层环：roster → shell-rows →
// 本模块 → workspace.ts → composition-store/roster。类型 import 擦除无环；
// 值（Workspace 类 / isSamePath / loadGraphPages）在运行时首次调用取
// （模块系统缓存，零重复装载）。工作区函数族全部运行时触发（UI 动作/
// 冷启动），惰性装载无时序代价。
async function wsMod(): Promise<typeof import('../../workspace')> {
  return import('../../workspace');
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
// switchWorkspace — 统一入口
// ═══════════════════════════════════════════════════════════════

async function switchWorkspace(
  path?: string,
  opts?: { skipAnalysis?: boolean; cachedGraph?: CachedGraphMeta },
): Promise<void> {
  const { workspace, wsMachine } = shellRefs;
  const chatPanel = shellRefs.chatPanel;
  if (!chatPanel) {
    // chat 壳行被禁用的涟漪（设计件 §2.8）：无面板承接会话，无法开项目
    pushStatus('会话核心未初始化，无法绑定目录');
    return;
  }
  if (wsMachine.isBusy) {
    pushStatus('正在切换工作区，请稍候…');
    return;
  }
  wsMachine.transition('switching');
  try {
    const { Workspace: WorkspaceCls, isSamePath } = await wsMod();
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

    // 在可能缓慢的 deactivate() await 之前标记加载态。
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

    // 创建新工作区 — 立即传入回调，使 Workspace.open（分析 + 数据装载）期间
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
      ws = await WorkspaceCls.open(folder, null, chatPanel, opts, { onStatusChange, onLoadingChange });
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
      pushStatus('⚠️ 后台分析未完成 — 缓存图谱可用，重新绑定目录可重试');
    };

    shellRefs.workspace = ws;
    wsMachine.transition(ws._health === 'degraded' ? 'degraded' : 'active');

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
    bumpWorkspaceSwitched(); // P1 总线归零：workspace:switched → state/workspace-switch-store

    try {
      await ws.setupAgent(chatPanel);
    } catch (e) {
      // Phase D（错误不静默）：装配失败必须可见——不只进 console（用户 DevTools
      // 常被屏蔽，状态条 + 诊断面板是唯一通道）
      console.error('[switchWorkspace] setupAgent failed:', e);
      const msg = e instanceof Error ? e.message : String(e);
      pushStatus(`⚠️ Agent 装配失败: ${msg}`);
      useAgentPanelStore.getState().setDiag({ text: `❌ Agent 装配失败 — ${msg}`, ready: false });
    }

    chatPanel.setProjectPath(folder);
    // 会话根目录确保创建（2026-08-28 会话管理专项）：{ws}/.lantai/sessions/ 是
    // 会话唯一存储位。首启工作区目录缺席时 list_directory 报「不是有效目录」，
    // 恢复/剪枝/发号对账全走错误兜底路径；这里 await 建目录（create_dir_all
    // 幂等），使随后的 autoRestoreLastSession 读路径确定性（编号对账可靠）。
    // 建目录失败不阻断进工作区——写路径仍会按需创建父目录，失败 console 可见。
    try {
      await typedRpc('create_directory', { path: `${folder.replace(/[\\/]+$/, '')}/.lantai/sessions` });
    } catch (e) {
      console.warn('[switchWorkspace] 会话根目录创建失败:', folder, e);
    }
    // 会话统一 U2：恢复改为 await——跨工作区续开（首页点他区卷 → switch →
    // loadSessionFromDisk）需要恢复落定后再摊开目标卷，否则恢复的整表 setState
    // 会与续开的 append 交错（续开的卷被恢复态覆写）。
    await chatPanel.autoRestoreLastSession(folder).catch((e) => {
      console.error('[switchWorkspace] autoRestoreLastSession failed:', e);
      pushStatus(`⚠️ 会话恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    });
    // Stage-5：进工作区恢复画布——摊开集合 + 各自位置 + 活跃会话（拍板 11：
    // 展开 = 永远展开，重启恢复；Q-B 在画布语义下不再适用）。
    await chatPanel.restoreCanvasSpread(folder).catch((e) => {
      console.error('[switchWorkspace] restoreCanvasSpread failed:', e);
      pushStatus(`⚠️ 画布布局恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (ws._graphEngineOn) {
      ws.runCheck();
      await typedRpc('workspace_start_watcher', {}).catch(() => {});
    } else {
      // 引擎开关关闭（2026-08-22）：不跑初始简报、不启文件 watcher——
      // watcher 的增量分析链（engine_try_incremental）会在后台把引擎拉起来。
      pushStatus('图谱引擎已停用——跳过简报与文件监视');
    }
  } finally {
    // 确保状态机未卡在 'switching' 状态
    if (wsMachine.state === 'switching') {
      wsMachine.forceState(
        shellRefs.workspace?._health === 'degraded' ? 'degraded' : shellRefs.workspace ? 'active' : 'idle',
      );
    }
  }
}

// ── Esc 逐层关闭（快捷键经 useGlobalKeys → actions 分发到此）──

function escLayer(): void {
  const dock = useDockStore.getState();
  // 视觉栈序（V5 拆除后）：settings 浮层（z:401）盖纸壳（z:280）——
  // 高层先关；纸关 = 回案卷首页换卷/续开。
  // closePanel 自带关闭守卫（dock-store 2026-08 UI 大清扫）：settings 有未保存
  // 改动时守卫弹确认并拦截本次 Esc——Esc 不再静默丢设置。
  if (dock.isOpen('settings')) dock.closePanel('settings');
  else if (dock.isOpen('paper')) dock.closePanel('paper');
}

/** 导出面：冷启动行 + actions 行消费的 workspace 流函数族。 */
export const workspaceFlow = {
  switchWorkspace,
  escLayer,
};

/** 壳行 boot：workspace 流本身就是模块级函数族——boot 无接线动作，
 *  仅暴露 flow 导出（编排器经 deps 注入给 actions 行 / 冷启动行）。
 *  模块 import 即行生效（纯函数定义无副作用），boot 保留为空操作以
 *  占住表序（行禁用语义 = 模块仍被 import，flow 调用一致地失败）。 */
export function bootWorkspace(_refs: ShellRefs): void {
  // 无副作用接线（见上注释）
}
