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
import { useShellStore } from '../../app/shell-store';
import { withTimeout } from '../../lifecycle/timeout';
import { kernelCreateDirectory, typedRpc } from '../../rpc-contract';
import { useDockStore } from '../../state/dock-store';
import { bumpWorkspaceSwitched } from '../../state/workspace-switch-store';
import { useAgentPanelStore } from '../../ui/agent-panel-store';
import type { Workspace } from '../../workspace';
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

/** 系统目录选择器（首页「指定已有目录」路径与 switchWorkspace 缺省共用）。 */
export async function pickFolder(): Promise<string | null> {
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

/** opts.graphEngine（2026-08-31 per-workspace 引擎旗标）：true/false = 显式指定
 *  （新建工作区 sheet 的勾选，随 activate 写入注册表）；null/undefined = 不指定，
 *  Workspace.open 内部按注册表现值装配（无记录回退全局默认），注册表不被覆写。 */
async function switchWorkspace(path?: string, opts?: { graphEngine?: boolean | null }): Promise<void> {
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
        });
      } catch (e) {
        console.error('[switchWorkspace] deactivate error:', e);
        // #13 修复：await forceClearState——旧工作区的异步清理器（canvas flush
        // 等）在新工作区创建前 settle，防竞态
        await shellRefs.workspace?.forceClearState();
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
      ws = await WorkspaceCls.open(folder, null, chatPanel, {
        onStatusChange,
        onLoadingChange,
        graphEngine: opts?.graphEngine ?? null,
      });
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
    // 竞态根治（2026-09-02 实机事故）：状态机此前在 open() 返回后即转
    // 'active'——但 setupAgent + 摊开集恢复还在后面跑数秒。该窗口内 isBusy
    // = false，第二次点击（用户见画布空/慢再点一次）绕过 #4 守卫触发并发
    // switchWorkspace：后到的 activate 覆写前一个的根句柄 → 前一个的恢复
    // 全部越界被拒 + 双方 setupAgent 互拆 runtime/core → 画布/设置面板全死。
    // 修复：'switching' 持有到整个 switch 完成（含恢复），finally 兜底不变。

    // Phase 1.5：graphData = 聚合快照（不再有全量 nodes/edges 计数）
    const gd = ws.graphData;
    const nodeCount = gd?.node_count ?? 0;
    pushStatus(`✨ ${nodeCount} 节点已就绪`);
    log.info('main', 'project loaded', {
      nodes: nodeCount,
      edges: gd?.edge_count ?? 0,
    });
    // #2 修复（2026-09-02）：setLoading(false) 原在此处调用——但 setupAgent +
    // restoreCanvasSpread 尚未完成。用户看到 analyzing 已清除、认为工作区就绪，
    // 实际卷还在恢复。移到 restoreCanvasSpread 之后。这里保留 pushStatus 进度。
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
    // 豁免（session-persistence-seam-wiring-plan 表 1.1 #10）：工作区脚手架结构
    // op——壳行执行时序早于插件装载，不可依赖 seam；默认 provider save 走
    // kernelWriteFile 自带父目录自动创建兜底。
    // 超时护栏（2026-09-09 事故立法）：恢复链上的 RPC 一律有界——引擎缺席/
    // 后端无响应时无界 await 会把状态机永锁 'switching'（挂起的 await 不走
    // finally，兜底 forceState 也到不了），首页一切点击被 isBusy 守卫拦截。
    try {
      await withTimeout(kernelCreateDirectory(`${folder.replace(/[\\/]+$/, '')}/.lantai/sessions`), 5000);
    } catch (e) {
      console.warn('[switchWorkspace] 会话根目录创建失败:', folder, e);
    }
    // 会话统一 U2：恢复改为 await——跨工作区续开（首页点他区卷 → switch →
    // loadSessionFromDisk）需要恢复落定后再摊开目标卷，否则恢复的整表 setState
    // 会与续开的 append 交错（续开的卷被恢复态覆写）。
    await withTimeout(chatPanel.autoRestoreLastSession(folder), 60_000).catch((e) => {
      console.error('[switchWorkspace] autoRestoreLastSession failed:', e);
      pushStatus(`⚠️ 会话恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    });
    // Stage-5：进工作区恢复画布——摊开集合 + 各自位置 + 活跃会话（拍板 11：
    // 展开 = 永远展开，重启恢复；Q-B 在画布语义下不再适用）。
    await withTimeout(chatPanel.restoreCanvasSpread(folder), 60_000).catch((e) => {
      console.error('[switchWorkspace] restoreCanvasSpread failed:', e);
      pushStatus(`⚠️ 画布布局恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    });
    // #2 修复：恢复完成后才清除加载态——用户在此前不能进入纸面板（analyzing
    // 状态仍在，onEnterWorkspace 的 wsMachine.isBusy 守卫也拦截）
    setLoading(false);
    if (ws._graphEngineOn) {
      ws.runCheck();
      await withTimeout(typedRpc('workspace_start_watcher', {}), 10_000).catch((e) => {
        // 原 `.catch(() => {})` 全静默——无界 await + 静默吞错正是卡死无感的
        // 双成因；watcher 起不来只是增量分析缺席，工作区本身可用（可见降级）。
        console.warn('[switchWorkspace] workspace_start_watcher 失败/超时——本次无增量分析:', e);
        pushStatus('⚠️ 文件监视未启动——本次进入无增量分析（可继续用，重进工作区可重试）');
      });
    } else {
      // 引擎开关关闭（2026-08-22）：不跑初始简报、不启文件 watcher——
      // watcher 的增量分析链（engine_try_incremental）会在后台把引擎拉起来。
      pushStatus('图谱引擎已停用——跳过简报与文件监视');
    }
    // 竞态根治：全部恢复落定后才离开 'switching'（isBusy 期间二次点击
    // 被 switchWorkspace 入口 + #4 守卫拦截）。switching → active/degraded
    // 均为合法转移。
    wsMachine.transition(ws._health === 'degraded' ? 'degraded' : 'active');
  } finally {
    // 兜底：异常路径（open 抛错已 forceState('idle')）外不得卡 'switching'
    if (wsMachine.state === 'switching') {
      wsMachine.forceState(
        shellRefs.workspace?._health === 'degraded' ? 'degraded' : shellRefs.workspace ? 'active' : 'idle',
      );
    }
  }
}

// ── 离开工作区回首页（2026-09-08 生命周期修复：回首页 = 真关工作区）──
// 历史语义：关纸面板只翻 dock-store 布尔，工作区实例（watcher/引擎/Agent/
// fiber）继续常驻后台——视图层与运行时层脱节。用户拍板：回首页必须真正
// deactivate（停 watcher/引擎/Agent），使从首页再进入必然重建实例重读
// 图谱旗标（图谱开关"下次进入生效"变成真承诺）。

/** 真关当前工作区并回首页。无活动工作区 = 直接关面板（无副作用）。
 *  调用方（PaperPanel 确认弹层）先经关闭守卫弹确认再调本函数——
 *  本函数不再二次确认。deactivate 带 5s 超时兜底（switchWorkspace 同款）。 */
export async function leaveToHome(): Promise<void> {
  const { workspace, wsMachine, chatPanel } = shellRefs;
  if (workspace?.active && chatPanel) {
    // 进入 deactivating——期间 isBusy=true，防用户在 deactivate 途中点进别的
    // 工作区（switchWorkspace 入口的 isBusy 守卫拦截）触发并发切区竞态。
    if (wsMachine.canTransition('deactivating')) wsMachine.transition('deactivating');
    try {
      await withTimeout(workspace.deactivate(chatPanel), 5000, () => {
        console.warn('[leaveToHome] deactivate timed out, forcing clear');
      });
    } catch (e) {
      console.error('[leaveToHome] deactivate error:', e);
      await shellRefs.workspace?.forceClearState();
    }
    shellRefs.workspace = null;
    wsMachine.forceState('idle');
  }
  // projectPath 单一权威 = shell-store（chat-core.setProjectPath 同源）
  useShellStore.getState().setProjectPath('');
  useDockStore.getState().closePanel('paper');
  pushStatus('已回首页——工作区已关闭');
}

// ── Esc 逐层关闭（快捷键经 useGlobalKeys → actions 分发到此）──

function escLayer(): void {
  const dock = useDockStore.getState();
  // 视觉栈序（V5 拆除后）：settings 浮层（z:401）盖纸壳（z:280）——
  // 高层先关。
  // 2026-09-08 用户拍板：ESC 不再关 paper（纸关 = 回首页 = 真关工作区，
  // 有副作用——防误触，回首页只走显式按钮/命令并经确认）。
  // closePanel 自带关闭守卫（dock-store 2026-08 UI 大清扫）：settings 有未保存
  // 改动时守卫弹确认并拦截本次 Esc——Esc 不再静默丢设置。
  if (dock.isOpen('settings')) dock.closePanel('settings');
}

// ── 卡死逃生口（2026-09-09 事故立法：首页「点不进工作区」根因收口）──
// 实机事故：引擎二进制缺席 → 冷启动恢复链在会话/画布恢复段挂死 → 状态机
// 永停 'switching' → 首页 onEnterWorkspace 的 isBusy 守卫拦截一切点击（弹
// 「工作区正在恢复中，请稍候…」），用户被锁在所有工作区外面且无任何逃生
// 口。尾部 await 已加 withTimeout 护栏（上方），但护栏防不住未知的挂点
// （Workspace.open 内部、未来新增的恢复步骤）——本口 = 最后一道人工逃生：
// 首页守卫发现 busy 超过 STUCK_SWITCH_MS 后向用户亮「强制重置」。

/** 强制回收卡死的切区。非 busy = no-op（防误触）。
 *  语义 = leaveToHome 全套清理（deactivate 5s 超时兜底 + 状态机复位 idle +
 *  清 projectPath + 关 paper）+ 加载态复位（leaveToHome 不动 analyzing——
 *  正常回首页时本就无加载态，卡死路径需要显式清）。
 *  先摘 paper 关闭守卫：卡死路径的关面板不该被「回首页？」确认弹层二次
 *  拦截（PaperPanel.forceLeave 同款次序）。在途切区若事后自行苏醒，其尾部
 *  transition 会因非法转移抛错（届时 state 已非 'switching'，finally 的
 *  forceState 分支不触发）——只留 console 噪音；卡死 60s 后的用户逃生权
 *  优先于那个理论上还活着的在途任务。 */
export async function stuckRecover(): Promise<void> {
  const { wsMachine } = shellRefs;
  if (!wsMachine.isBusy) return;
  console.warn('[stuckRecover] 切区卡死', wsMachine.state, `${wsMachine.busyMs}ms —— 强制回收`);
  useDockStore.getState().unregisterCloseGuard('paper');
  try {
    await leaveToHome();
  } finally {
    // leaveToHome 的状态机复位在其 `workspace?.active` 分支内——卡死冷启动路径
    // shellRefs.workspace 可能为 null（open 挂起中从未落位），该分支不进，
    // 机器就会永停 'switching'。逃生口必须无条件复位（本函数存在即证明卡死）。
    if (wsMachine.isBusy) wsMachine.forceState('idle');
    setLoading(false);
  }
  pushStatus('已强制回收卡死的恢复——可重新进入工作区');
}

/** 导出面：冷启动行 + actions 行消费的 workspace 流函数族。 */
export const workspaceFlow = {
  switchWorkspace,
  escLayer,
  leaveToHome,
  stuckRecover,
};

/** 壳行 boot：workspace 流本身就是模块级函数族——boot 无接线动作，
 *  仅暴露 flow 导出（编排器经 deps 注入给 actions 行 / 冷启动行）。
 *  模块 import 即行生效（纯函数定义无副作用），boot 保留为空操作以
 *  占住表序（行禁用语义 = 模块仍被 import，flow 调用一致地失败）。 */
export function bootWorkspace(_refs: ShellRefs): void {
  // 无副作用接线（见上注释）
}
