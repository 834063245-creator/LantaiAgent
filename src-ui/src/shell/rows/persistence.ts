// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 9（hologram/shell-persistence）：轮次完成持久化 + agent-config
// 热切换订阅 + 退出收尾（三口一链，见文件末尾）。
// 自 main.ts 649-657 + 776-816 机械迁移（两段相邻语义：会话生命周期接线）。

import { agentSessionState } from '../../agent/agent-session-state';
import { log } from '../../agent/logger';
import { flushAllSessionLogs, flushSessionLog } from '../../app/chat/session-log-store';
import { watchWindowClose } from '../../bridge';
import { loadSettings } from '../../settings';
import { useAgentConfigStore } from '../../state/agent-config-store';
import { useExitGuardStore } from '../../state/exit-guard-store';
import { useTurnDoneStore } from '../../state/turn-done-store';
import { getWorkspaceEpoch, isCurrentEpoch } from '../../workspace-scope';
import type { ShellRefs } from '../runtime';
import { pushStatus } from '../runtime';

/** 正在运行的卷数（关窗拦截判据，2026-09-19）。真源 = 运行态唯一读面（v43：
 *  运行账上的活记录）——与纸面呼吸线 / 创作坞后台指示同源，不再各自取账本实例。
 *  ⚠ 已知边界（landmine L5，未拆）：异步子 Agent / 后台任务在父轮收尾后仍活着时
 *  不算「在跑」——「本卷在跑」是否该含活体后台工作属产品语义，待拍板。 */
function countRunningSessions(): number {
  let running = 0;
  agentSessionState.forEachAgentEntry((storeId) => {
    running += agentSessionState.runningSessions(storeId).length;
  });
  return running;
}

export function bootPersistence(refs: ShellRefs): void {
  // ═══════════════════════════════════════════════════════════════
  // 触发点 A —— 模型请求前检查点（P0·2026-09-15 存盘审计 M1）
  //
  // 病灶：全部落盘触发点都在「轮次结束之后」——一轮从用户输入到流收尾之间
  // 磁盘上零痕迹。实测代价：2026-09-15 一轮 1h47m（2333 次工具调用）全丢。
  //
  // 语义时刻来源：`docs/session-checkpoint-design.md` §3.1 触发点 A（该设计件
  // 定稿但从未接线）。接线方式 = loop 监听面 `request/start`（D4 监听面，
  // 载荷含 agentId）——**不改 agent-loop 契约文件**，不新增服务与 RPC。
  //
  // 失败语义 = fail-open + 可见（设计件 §3.3）：检查点失败不阻断请求，
  // 但必须留痕；下一个请求自动重试。
  // ═══════════════════════════════════════════════════════════════

  /** 在途检查点（每卷至多一条）：在途即跳过——合并突发，下一请求/轮末再落盘。 */
  const _checkpointInFlight = new Set<string>();
  /** 已挂检查点的句柄（key = storeId:sessionId:agentId——句柄换新要重挂）。 */
  const _checkpointHooked = new Set<string>();

  function checkpointBeforeRequest(refs: ShellRefs, storeId: string, sessionId: number): void {
    const panel = refs.chatPanel;
    // 工作区代际守卫（同 hydrateSessionAgentVisible 家族）：迟到的请求事件不得
    // 把旧工作区的卷写进新工作区目录（切区后 sess store 已清，双保险）。
    const epoch = getWorkspaceEpoch();
    if (!panel) return;
    const key = `${storeId}:${sessionId}`;
    if (_checkpointInFlight.has(key)) return;
    _checkpointInFlight.add(key);
    // 检查点 = **排空事件日志队列**（换轨 Phase 1）：增量写让这一步只有几十字节
    // 到几 KB，所以可以挂在每个模型请求前（DSH `llm/stream` 前的 flush 同义）。
    // 副作用：此前那句「落一次全量快照（1–2MB）」的旧实现退役——快照现在是投影
    // 缓存，只在轮末/退出写。
    const logInstance = agentSessionState.getAgent(storeId, sessionId)?.sessionLog ?? null;
    void flushSessionLog(logInstance)
      .then(() => {
        if (!isCurrentEpoch(epoch)) return;
      })
      .catch((e: unknown) => {
        log.warn('persistence', `请求前检查点排空失败：案卷 ${sessionId}`, { error: String(e) });
      })
      .finally(() => {
        _checkpointInFlight.delete(key);
      });
  }

  /** 给每个在册 Agent 句柄挂 `request/start` 监听（句柄换新自动重挂）。 */
  function hookSessionCheckpoints(refs: ShellRefs): void {
    agentSessionState.forEachAgentEntry((storeId, sessionId, handle) => {
      const key = `${storeId}:${sessionId}:${handle.id}`;
      if (_checkpointHooked.has(key)) return;
      const onLoopEvent = handle.onLoopEvent;
      if (typeof onLoopEvent !== 'function') return; // 能力位缺席 = 无监听面（降级不炸）
      _checkpointHooked.add(key);
      onLoopEvent.call(handle, 'request/start', () => {
        checkpointBeforeRequest(refs, storeId, sessionId);
      });
    });
  }

  hookSessionCheckpoints(refs);
  // 句柄登记/注销都会 bump（setAgent/removeAgent/clearPanelState）——新句柄在此挂上
  agentSessionState.subscribe(() => hookSessionCheckpoints(refs));

  // ── 轮次完成通知（P1 总线归零：chat:turn-done → state/turn-done-store 信号）──
  // L2（session-ledger）：谁跑完存谁——doneSid = 后台卷 → 该卷全量快照
  // （saveSessionById，F3 窗口期闭合）；doneSid = 活跃卷/缺席 → 防抖全量
  // （scheduleAutoSave → saveActiveSession，工作区会话根唯一存储路径）。
  // workspace-session-ownership-rework（2026-08-27）：NDJSON 增量
  // （appendLastMessage/session_append）已拆除——只写不读孤儿路径退役。
  useTurnDoneStore.subscribe((s, prev) => {
    if (s.turnDoneTick === prev.turnDoneTick) return;
    const ws = refs.workspace;
    const chatPanel = refs.chatPanel;
    if (!ws || !chatPanel) return;
    const doneSid = s.lastDoneSid;
    if (doneSid != null) {
      const activeSid = chatPanel.activeSessionId;
      if (doneSid !== activeSid) {
        // 后台卷跑完：立即全量落盘自己的卷（不等切回）
        // Phase D（错误不静默，2026-08-28 会话管理专项）：后台卷落盘失败此前
        // 静默吞掉（catch{}）——该卷最近一轮会丢且用户无感知。这里可见化。
        chatPanel.saveSessionById(doneSid).catch((e) => {
          console.error(`[persistence] 后台卷 ${doneSid} 落盘失败:`, e);
          pushStatus(`⚠️ 案卷 ${doneSid} 保存失败——重启可能丢失最近一轮`);
        });
        return;
      }
    }
    // 防抖全量落盘（工作区会话根）
    chatPanel.scheduleAutoSave(ws.path);
  });

  // Agent 配置变更统一入口：设置面板/模型切换/模式按钮只发信号
  // （P1b：agent-config-store 订阅，替代 bus 'agent:config-changed' 事件），
  // workspace.applyAgentConfig 热切换处理（不重建，会话/上下文全保留）。
  // 单槽统一（2026-08-24）：refs.workspace 是唯一工作区注册表（占位工作区
  // path='' 也是槽内普通条目）——路由坍缩为单分支，占位影子实例的三分支
  // 猜测退役。
  useAgentConfigStore.subscribe((state, prev) => {
    if (state.seq === prev.seq || !state.reason) return;
    const reason = state.reason;
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
    const ws = refs.workspace;
    const chatPanel = refs.chatPanel;
    if (ws && chatPanel) {
      // 方案甲（2026-08-27）：会话级信号携带 sessionId → 只热切换该会话
      void ws.applyAgentConfig(chatPanel, reason, state.sessionId ?? undefined).catch((err) => {
        // Phase D（错误不静默）：热切换失败可见——状态条呈现，不只进 console
        console.error('[agent-config] hot-switch failed:', err);
        pushStatus(`⚠️ 配置热切换失败: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      // chat 行被禁用的涟漪（设计件 §2.8 降级面）+ 错误不静默
      console.warn('[agent-config] workspace/chatPanel 缺席，丢弃信号:', reason);
    }
  });
  refs.chatPanel?.setOnOpenSettings(() => {
    // 动态 import 解耦：dock-store 经 actions 行已入依赖图，此处在
    // 用户点击时才取，避免行间模块级循环。
    void import('../../state/dock-store').then(({ useDockStore }) => useDockStore.getState().openPanel('settings'));
  });

  // ═══════════════════════════════════════════════════════════════
  // 退出收尾（P0 重写·2026-09-15 存盘审计）
  //
  // 旧实现只有 `window.addEventListener('beforeunload', …)`，内含三处致命：
  //   ① beforeunload 在 WebView2/Tauri 关窗时**不触发**（上游 WebView2Feedback
  //      #3217 / tauri#2996）——钩子整个不执行；
  //   ② 钩子内 `scheduleAutoSave` 只是「clear 再 setTimeout(500ms)」——把待落盘
  //      **推迟到窗口消失之后**（M7）；
  //   ③ `saveAllSessions().catch(() => {})` 是未 await 的 fire-and-forget 且静默
  //      吞错；Rust 侧 `WindowEvent::Destroyed` → `process::exit(0)` 会腰斩在途写。
  // 实测代价：2026-09-15 一轮 1h47m 的工作（2333 次工具调用）磁盘上零痕迹。
  //
  // 新实现 = 一条 flush 三个入口（不是三条轨道）：
  //   ① 权威：Tauri 关窗请求 → preventDefault → await flush → destroy
  //   ② 兜底：pagehide / visibilitychange(hidden)——系统关机、注销、休眠（此时
  //      窗口未必收到 close-requested）
  //   ③ 保留：beforeunload（浏览器 dev / 导航卸载面）
  // 三者幂等去重（_flushInFlight）；关窗路径用 _closing 关闭其余入口（destroy 后
  // 再发起 RPC 只会得到一串无意义失败）。
  // ═══════════════════════════════════════════════════════════════

  /** 退出 flush 预算（硬顶）：超过即放弃等待并可见报错——否则关窗永挂。
   *  会话写是逐卷全量快照（本机实测 MB 级、单卷 10–30ms），2500ms 覆盖十余卷；
   *  画布三件是纯元数据，给 1000ms 即可（两支串行 = 关窗最坏 ~3.5s 后必 destroy）。 */
  const EXIT_FLUSH_BUDGET_MS = 2500;
  const EXIT_CANVAS_BUDGET_MS = 1000;

  let _closing = false;
  let _flushInFlight: Promise<void> | null = null;

  const withBudget = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });

  async function doFlush(refs: ShellRefs, trigger: string): Promise<void> {
    const ws = refs.workspace;
    if (!ws) return;
    const panel = refs.chatPanel;
    if (panel) {
      // ① 事件日志排空（换轨 Phase 1）：增量写 ⇒ 退出收尾成本 = 未落盘增量
      //    （几十字节~几 KB/卷），不再写 N 卷 MB 级快照。
      try {
        const drained = await withBudget(flushAllSessionLogs(), EXIT_FLUSH_BUDGET_MS, '事件日志排空');
        if (drained.failed > 0) {
          pushStatus(`⚠️ 退出时 ${drained.failed} 卷事件日志未排空——重启可能丢失最后一条`);
        }
      } catch (e) {
        log.error('persistence', `退出排空事件日志失败（${trigger}）`, { error: String(e) });
      }
      try {
        const report = await withBudget(panel.flushSessionsForExit(), EXIT_FLUSH_BUDGET_MS, '会话退出落盘');
        // 错误不静默（CONVENTIONS §1.7）：非 saved 的卷逐条报出——空卷是常态
        // （不吵），「有内容但没落盘」才是事故面。
        const serious = report.anomalies.filter(
          (a) => a.outcome === 'failed' || a.outcome === 'skipped-no-handle' || a.outcome === 'skipped-no-workspace',
        );
        if (serious.length > 0) {
          log.warn('persistence', `退出落盘异常（${trigger}）`, {
            saved: report.saved,
            anomalies: serious.map((a) => `${a.sid}:${a.outcome}`),
          });
          pushStatus(`⚠️ 退出时 ${serious.length} 卷未落盘——重启可能丢失最近一轮`);
        } else {
          log.info('persistence', `退出落盘完成（${trigger}）`, {
            saved: report.saved,
            total: report.total,
            cancelledDebounce: report.cancelledDebounce === true,
          });
        }
      } catch (e) {
        log.error('persistence', `退出落盘失败（${trigger}）`, { error: String(e) });
        console.error('[persistence] 退出落盘失败:', e);
      }
    }
    try {
      const canvasSave: Promise<void> = panel ? panel.saveCanvasState(ws.path) : Promise.resolve();
      await withBudget(canvasSave, EXIT_CANVAS_BUDGET_MS, '画布落盘');
    } catch (e) {
      log.error('persistence', `退出画布落盘失败（${trigger}）`, { error: String(e) });
    }
    try {
      ws.subAgentPool.stopAll();
    } catch {
      /* 子 Agent 停止失败不阻断退出（best-effort） */
    }
    try {
      void ws.runtime?.flushAllBoards();
    } catch {
      /* board flush 是 fire-and-forget（各自有防抖 + 独立可见面） */
    }
  }

  /** 单飞去重入口（三入口共用）。 */
  function flushForExit(refs: ShellRefs, trigger: string): Promise<void> {
    if (_flushInFlight) return _flushInFlight;
    const p = doFlush(refs, trigger).finally(() => {
      _flushInFlight = null;
    });
    _flushInFlight = p;
    return p;
  }

  // ① 权威入口：Tauri 关窗请求。preventDefault → flush → destroy（destroy 后
  //    Rust 侧 Destroyed 照常 drain + exit；窗口不会因为异常而永久卡住）。
  //    2026-09-19 用户拍板：有会话正在跑时先拦一次（升起 ExitConfirmDialog）——
  //    回首页有确认，而紧挨着它的 ✕ 没有，等于手一抖就把在跑的一轮掐死；
  //    空闲时不拦（会话与画布本来就会自动落盘，弹层只是多一次点击）。
  //    系统关机不走本路（tao 0.35.3 显式不处理 WM_QUERYENDSESSION，
  //    event_loop.rs 有注释）——弹层不会阻塞关机；关机仍由 ② 兜底入口接。
  void watchWindowClose((ev) => {
    // 一律先摘默认关闭：本次要么由 proceed 收尾，要么交弹层决定（取消 = 窗口留着）。
    ev.preventDefault();
    const proceed = () => {
      _closing = true;
      void flushForExit(refs, 'close-requested').finally(() => {
        void ev.destroy().catch((e: unknown) => {
          log.error('persistence', '关窗 destroy 失败', { error: String(e) });
        });
      });
    };
    // 弹层已在场（连点 ✕ / 键位与按钮并发）：本次请求并入那一次，不重复升起、
    // 也不越过用户直接 proceed。
    if (useExitGuardStore.getState().pending) return;
    const running = countRunningSessions();
    if (running > 0) {
      useExitGuardStore.getState().requestExit(running, proceed);
      return;
    }
    proceed();
  });

  // ② 兜底：页面隐藏（系统关机/注销/休眠时窗口未必收到 close-requested；
  //    WebView2 也不保证 beforeunload）。关窗路径已在跑 → 跳过。
  window.addEventListener('pagehide', () => {
    if (_closing) return;
    void flushForExit(refs, 'pagehide');
  });
  document.addEventListener('visibilitychange', () => {
    if (_closing || document.visibilityState !== 'hidden') return;
    void flushForExit(refs, 'hidden');
  });

  // ③ 保留：beforeunload（浏览器 dev / 导航卸载面——此时无法 await，尽力而为）。
  window.addEventListener('beforeunload', () => {
    if (_closing) return;
    void flushForExit(refs, 'beforeunload');
  });
}
