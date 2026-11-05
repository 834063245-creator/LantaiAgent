// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-workspace）：workspace 流函数族 —
// switchWorkspace / abortWorkspaceEntry / retryWorkspaceEntry / escLayer / leaveToHome。
// 自 main.ts 机械迁移（S2-4）；workspace-flip 批 3（打开流两段化）。
// workspace-session-ownership-rework（2026-08-27）：setupPlaceholderAgent 退役——
// 零目录会话/占位工作区已随「会话物理归属工作区」移除，无项目不装配 Agent。
//
// V5 拆除（2026-08-22，纸壳唯一主界面）：星图渲染面退役——switchWorkspace
// 不再构造/等待 StarGraph 渲染。图谱全量退役（2026-09-09）：graphData 装载 /
// graph-updated 监听 / runCheck / workspace_start_watcher（通知泵）随引擎接线
// 整批移除——switch = 激活 + Agent 装配 + 会话/画布恢复，零引擎依赖。
//
// 2026-11-05 入口 UX 批（用户拍板「绑定/物化两段 + 展卷页，落地到第 2 刀」）：
//   病灶：冷启动在后台替用户物化上次工作区（约 3~5s），落到首页；用户从首页点进
//   来时撞上状态机 busy，点击被**丢弃**、只换一行状态字；画布那边先闪旧区纸面、
//   再挂一张空案头（输入条还可点）。三处叠成「割裂」。
//   定案：① 冷启动不再预开工作区（cold-start.ts 只留启动锚）；② 进入一律先导航
//   （openPanel + 展卷态在第一个 await 之前）——展卷页接管等待，点击永不被丢弃；
//   ③ 失败就地落定（具名原因 + 重试/回案头），不再只进状态栏。
//   首页读面（上卷）随之与「活动工作区」解耦：Rust 侧给已登记工作区的
//   `.lantai/**` 开了用户通道只读豁免（utils/path_resolve.rs::registered_workspace_read）。
//
// 行禁用涟漪（§2.8）：boot 不跑 = flowDeps 未产出 = actions 行跳过注册、
// 冷启动行不进入工作区（失败隔离）；直接 import 本模块调用一致地失败——
// 禁用即不可用，文档声明）。

import { useShellStore } from '../../app/shell-store';
import { withTimeout } from '../../lifecycle/timeout';
import { loadProjectProvidersDoc } from '../../provider/providers-store';
import { kernelCreateDirectory } from '../../rpc-contract';
import { useDockStore } from '../../state/dock-store';
import {
  beginWorkspaceEntry,
  clearWorkspaceEntry,
  failWorkspaceEntry,
  setWorkspaceEntryPhase,
  useWorkspaceEntryStore,
} from '../../state/workspace-entry-store';
import { bumpWorkspaceSwitched } from '../../state/workspace-switch-store';
import { useAgentPanelStore } from '../../ui/agent-panel-store';
import type { Workspace } from '../../workspace';
import { pushStatus, type ShellRefs, setLoading, shellRefs } from '../runtime';

// 惰性取 Workspace 模块（值面）——防组合层环：roster → shell-rows →
// 本模块 → workspace.ts → composition-store/roster。类型 import 擦除无环；
// 值（Workspace 类 / isSamePath）在运行时首次调用取（模块系统缓存，零重复
// 装载）。工作区函数族全部运行时触发（UI 动作），惰性装载无时序代价。
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
// switchWorkspace — 进入工作区的唯一入口（绑定 → 装配 → 展卷）
// ═══════════════════════════════════════════════════════════════

/** 展卷页最短停留（ms）——秒开时不让展卷页闪一帧（与 `--m-sheet` 同量级）。 */
const ENTRY_MIN_MS = 320;

/** ——进入工作区（2026-11-05 入口 UX 批，见文件头注）——
 *  三段与展卷页的三行一一对应：
 *    绑定（Workspace.open = workspace_activate）→ 装配（setupAgent）
 *    → 展卷（会话根 + 会话恢复 + 画布摊开集）。
 *  三处行为差（拍板项）：
 *    ① 导航先发生：openPanel + beginWorkspaceEntry 在第一个 await 之前——首页点击
 *      永不被丢弃（旧版 busy 时 return + 一行状态字）；
 *    ② 失败就地落定：异常 → failWorkspaceEntry(具名原因)，展卷页给「重试/回案头」，
 *      调用方不再需要 catch（旧版 Workspace.open 抛错只 pushStatus + rethrow）；
 *    ③ 同区已在案直接返回（不重装）——与旧版一致。
 *  opts.name = 展卷页标题用的**登记名**（首页行/上卷有登记名；缺省 = 路径末段）。 */
async function switchWorkspace(path?: string, opts?: { name?: string }): Promise<void> {
  const { workspace, wsMachine } = shellRefs;
  const chatPanel = shellRefs.chatPanel;
  if (!chatPanel) {
    // chat 壳行被禁用的涟漪（设计件 §2.8）：无面板承接会话，无法开项目
    pushStatus('会话核心未初始化，无法绑定目录');
    return;
  }
  // 并发守卫：展卷页盖住首页/纸面，正常路径点不到第二次；这条只挡程序性重入。
  if (wsMachine.isBusy) return;
  wsMachine.transition('switching');
  const startedAt = Date.now();
  const dock = useDockStore.getState();
  try {
    const { Workspace: WorkspaceCls, isSamePath } = await wsMod();
    const folder = path || (await pickFolder());
    if (!folder) {
      wsMachine.forceState('idle');
      return;
    }

    // 导航先发生：命令面板「打开工作区…」与首页入口都落到纸面（同区已在案时
    // 只是打开纸面——下面早退，不重装）。此后的等待由纸壳展卷页承接。
    dock.openPanel('paper');

    if (workspace?.active && isSamePath(workspace.path, folder)) {
      pushStatus('已在当前工作区');
      wsMachine.forceState('active');
      return;
    }

    beginWorkspaceEntry(folder, opts?.name);
    // 展卷期间的关闭守卫归展卷页所有（EnteringSheet 挂载即注册、卸载即摘——
    // 这里注册会被 PaperPanel 卸载时的 cleanup 一并摘掉，见该文件注）。
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

    // ── ① 绑定（Workspace.open 期间的状态更新可见：onStatusChange 已挂）──
    const onStatusChange = (msg: string) => {
      pushStatus(msg);
    };
    const onLoadingChange = (loading: boolean) => {
      setLoading(loading, loading ? folder : undefined);
    };
    // 绑定失败由外层 catch 交展卷页（目录丢失 / 后端桥断是最常见的失败面）。
    const ws: Workspace = await WorkspaceCls.open(folder, { onStatusChange, onLoadingChange });
    ws.onStatusChange = onStatusChange;
    ws.onLoadingChange = onLoadingChange;

    shellRefs.workspace = ws;
    // #2 修复（2026-09-02）+ 竞态根治（2026-11-05）：'switching' 持有到整个进入流程
    // 结束（含恢复）——期间任何程序性重入都被入口守卫拦下；展卷页是它唯一可见面。
    bumpWorkspaceSwitched(); // P1 总线归零：workspace:switched → state/workspace-switch-store

    // 项目级 provider 覆盖（2026-09-24 配方改文件批）：`{ws}/.lantai/providers.yml`
    // 同 id 整节覆盖用户级——必须在 setupAgent **之前**装（Agent 装配读的就是
    // 生效行表）。无该文件 = 常态；装载失败不阻断开卷（可见于状态条 + console）。
    try {
      await loadProjectProvidersDoc(folder);
    } catch (e) {
      console.warn('[switchWorkspace] 项目 provider 覆盖装载失败（继续开卷）:', e);
    }

    // ── ② 装配 ──
    setWorkspaceEntryPhase('assembling');
    try {
      await ws.setupAgent(chatPanel);
    } catch (e) {
      // Phase D（错误不静默）：装配失败必须可见——不只进 console（用户 DevTools
      // 常被屏蔽，状态条 + 诊断面板是唯一通道）。装配失败不阻断展卷（会话/画布
      // 仍可恢复，下一次配置变更会补装配）。
      console.error('[switchWorkspace] setupAgent failed:', e);
      const msg = e instanceof Error ? e.message : String(e);
      pushStatus(`⚠️ Agent 装配失败: ${msg}`);
      useAgentPanelStore.getState().setDiag({ text: `❌ Agent 装配失败 — ${msg}`, ready: false });
    }

    chatPanel.setProjectPath(folder);

    // ── ③ 展卷（会话根 + 会话 + 画布摊开集）──
    setWorkspaceEntryPhase('restoring');
    // 会话根目录确保创建（2026-08-28 会话管理专项）：{ws}/.lantai/sessions/ 是
    // 会话唯一存储位。首启工作区目录缺席时 list_directory 报「不是有效目录」，
    // 恢复/剪枝/发号对账全走错误兜底路径；这里 await 建目录（create_dir_all
    // 幂等），使随后的 autoRestoreLastSession 读路径确定性（编号对账可靠）。
    // 建目录失败不阻断进工作区——写路径仍会按需创建父目录，失败 console 可见。
    // 超时护栏（2026-09-09 事故立法）：恢复链上的 RPC 一律有界——后端无响应
    // 时无界 await 会把状态机永锁 'switching'。
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
    // 展开 = 永远展开，重启恢复）。
    await withTimeout(chatPanel.restoreCanvasSpread(folder), 60_000).catch((e) => {
      console.error('[switchWorkspace] restoreCanvasSpread failed:', e);
      pushStatus(`⚠️ 画布布局恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    });

    setLoading(false);
    pushStatus('✨ 工作区已就绪');
    if (wsMachine.canTransition('active')) wsMachine.transition('active');
    else wsMachine.forceState('active');

    // 落纸：最短停留（防秒开闪烁）→ 清展卷态（同一 tick：展卷页卸载、画布接管，
    // 关闭守卫随之从展卷页交回 PaperPanel；先清态会让画布在退场前闪一帧）。
    const held = Date.now() - startedAt;
    if (held < ENTRY_MIN_MS) await new Promise((resolve) => setTimeout(resolve, ENTRY_MIN_MS - held));
    clearWorkspaceEntry();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[switchWorkspace] 开卷失败:', err);
    pushStatus(`⚠️ 打开工作区失败: ${msg}`);
    setLoading(false);
    // 失败不保留半开工作区：同区早退会把半开态当成「已在案」，重试必须全新 open。
    if (shellRefs.workspace) {
      try {
        await shellRefs.workspace.forceClearState();
      } catch (e) {
        console.warn('[switchWorkspace] 失败回收 fiber 异常:', e);
      }
      shellRefs.workspace = null;
      useShellStore.getState().setProjectPath('');
    }
    failWorkspaceEntry(msg);
    wsMachine.forceState('idle');
  } finally {
    // 兜底：不得卡 'switching'（正常路径已在 try 内落 'active'）。
    if (wsMachine.state === 'switching') {
      wsMachine.forceState(shellRefs.workspace ? 'active' : 'idle');
    }
  }
}

/** 展卷页的出口（回案头）：在途 = 全套强制回收（stuckRecover）；已落定 =
 *  直接关面板回首页。两者都先摘守卫（本函数是用户显式动作，等同面板确认强关）。 */
export async function abortWorkspaceEntry(): Promise<void> {
  const { wsMachine } = shellRefs;
  useDockStore.getState().unregisterCloseGuard('paper');
  if (wsMachine.isBusy) {
    await stuckRecover();
  } else {
    await leaveToHome();
  }
  clearWorkspaceEntry();
}

/** 展卷页的失败重试：同目标重开（先清掉半开的工作区——否则同区早退不物化）。 */
export function retryWorkspaceEntry(): void {
  const target = useWorkspaceEntryStore.getState().target;
  if (!target) return;
  void (async () => {
    const { workspace } = shellRefs;
    if (workspace) {
      try {
        await workspace.forceClearState();
      } catch (e) {
        console.warn('[retryWorkspaceEntry] 清半开工作区失败:', e);
      }
      shellRefs.workspace = null;
      useShellStore.getState().setProjectPath('');
    }
    await switchWorkspace(target, { name: useWorkspaceEntryStore.getState().name });
  })();
}

// ── 离开工作区回首页（2026-09-08 生命周期修复：回首页 = 真关工作区）──
// 历史语义：关纸面板只翻 dock-store 布尔，工作区实例（Agent/fiber）继续
// 常驻后台——视图层与运行时层脱节。用户拍板：回首页必须真正 deactivate
//（停 Agent/fiber），使从首页再进入必然重建实例。

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
  // 展卷态残留（失败页直接回案头 / 卡死路径）——一并收掉，杜绝「半张展卷页」。
  clearWorkspaceEntry();
  // projectPath 单一权威 = shell-store（chat-core.setProjectPath 同源）
  useShellStore.getState().setProjectPath('');
  useDockStore.getState().unregisterCloseGuard('paper');
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
// 实机事故：冷启动恢复链在会话/画布恢复段挂死 → 状态机永停 'switching' →
// 首页 onEnterWorkspace 的 isBusy 守卫拦截一切点击（弹
// 「工作区正在恢复中，请稍候…」），用户被锁在所有工作区外面且无任何逃生
// 口。2026-11-05 入口 UX 批后：首页不再有守卫（导航先发生），逃生口搬到
// 纸壳展卷页（超过阈值亮「回案头」）——回收语义不变。

/** 强制回收卡死的切区。非 busy = no-op（防误触）。
 *  语义 = leaveToHome 全套清理（deactivate 5s 超时兜底 + 状态机复位 idle +
 *  清 projectPath + 关 paper）+ 加载态/展卷态复位。
 *  先摘 paper 关闭守卫：卡死路径的关面板不该被「回首页？」确认弹层二次
 *  拦截（PaperPanel.forceLeave 同款次序）。在途切区若事后自行苏醒，其尾部
 *  transition 会因非法转移抛错（届时 state 已非 'switching'，finally 的
 *  forceState 分支不触发）——只留 console 噪音；卡死后的用户逃生权
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
  clearWorkspaceEntry();
  pushStatus('已强制回收卡死的恢复——可重新进入工作区');
}

/** 导出面：actions 行 + 纸壳展卷页消费的 workspace 流函数族。 */
export const workspaceFlow = {
  switchWorkspace,
  escLayer,
  leaveToHome,
  stuckRecover,
  abortWorkspaceEntry,
  retryWorkspaceEntry,
};

/** 壳行 boot：workspace 流本身就是模块级函数族——boot 无接线动作，
 *  仅暴露 flow 导出（编排器经 deps 注入给 actions 行）。工作区进入由
 *  首页/命令在用户动作时触发（冷启动行不再预开——2026-11-05）。
 *  模块 import 即行生效（纯函数定义无副作用），boot 保留为空操作以
 *  占住表序（行禁用语义 = 模块仍被 import，flow 调用一致地失败）。 */
export function bootWorkspace(_refs: ShellRefs): void {
  // 无副作用接线（见上注释）
}
