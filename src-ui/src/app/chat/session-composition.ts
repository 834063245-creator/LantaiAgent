// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷级组合选择（S6 P1c）——「每卷一份组合」的**选择入口**（装配面之外的唯一写路径）。
//
// 真源三层，互不写对方的账（组合层交接铁律「两个真源别混」）：
//   - 全局默认：`settings.composition.preset` → `preset-store.selected`（既有；
//     本模块只读它，卷级选择**不碰** settings）；
//   - 卷级选择：`agentSessionState` 的卷登记（**运行时真源**）+ 卷文件 `presetId`
//     （**落盘投影**——写入口在 chat-session 的 save，读回登记见 P0）；
//   - 解析产物：`composition-store`（全局）+ 会话作用域注册表（每卷，workspace 工厂建）。
//
// 写路径语义（用户动作 = 在**空白卷**上拨组合）：
//   ① 校验：`sessionSelectionError(presetId)`（比 selectionError 严一档：未知 id
//      也拒）——不可用即**拒绝**并说明原因（沿 F1b：「选了却静默回退」比「拒绝并
//      说明原因」更坏）；
//   ② 空白闸：本卷跑过一轮即拒绝（组合面是**字节契约**：跑起来后换面 = 前缀缓存
//      与已声明能力面不一致）；控件面按同一把尺子禁用，这里是二道闸；
//   ③ 拆句柄（若在场）：`agentSessionState.removeAgent` —— ⚠ 它会把**卷登记一并
//      清掉**（agent-session-state 的 removeAgent 语义），故顺序必须「先拆后登记」；
//   ④ 登记卷级选择（运行时真源）；
//   ⑤ 生效：句柄在场且本卷活跃 → 立即重建（工厂按新登记装配）；句柄缺席（新卷的
//      常态）→ 下次 `ensureSessionAgent`（拟文/切卷）自然用新登记。
//
// 空白判据单点 = `isSessionBlank`：控件锁与写路径二道闸**共用同一把尺子**——两处
// 各判会漂移成「控件可点、一拨就被写路径拒绝」的鬼状态。
//
// ⚡ 静态面纪律（2026-09-15 实测两次踩坑，务必保持）：
//   `state/composition-store` 在**模块体**里就调 `factoryComposition()`，而
//   `state/preset-store` 在**模块体**里就调 `builtinPresets()`——两条模块体求值都
//   落在同一个环上：`composition/presets → roster → shell-rows → src/shell/rows/*`
//   而 `rows/chat` 又静态 import 本模块的宿主 `app/chat/chat-core`。于是本模块只要
//   **静态**可达 store 侧，环即闭合，症状是
//   `Cannot access 'BUILTIN_PRESETS' / '__vite_ssr_import_N__' before initialization`
//   （同一族错误 2026-09-14 在卷持久化层炸过一次，连坐 46 个测试文件）。
//   故：**静态面只准依赖 chat-core 已经静态依赖的三个模块**（见下方 import），
//   凡 store / composition 解析面（usePresetStore / sessionSelectionError）一律在
//   调用点 `await import(...)`（动态 import 不进静态图）。守卫：
//   tests/composition-import-cycle.test.ts 钉静态面白名单。
//
// 落位依据（为何在 app/chat/ 而不是 ui/）：ui/ 是**冻结残余目录**（终态 manifest
// 逐项点数，新文件属封口违规——守卫 tests/eventbus-zero-and-ui-split.test.ts）；
// 新编排件按约定落 app/**，本模块与宿主 chat-core 同目录。

import { agentSessionState } from '../../agent/agent-session-state';
import { ensureSessionAgent, type SessionContext } from '../../ui/chat-session';
import { getChatStore, msgStoreFor } from '../../ui/chat-store';

/** 本卷组合选择的结果（拒绝必带原因——错误不静默）。 */
export type SessionPresetChange = { ok: true } | { ok: false; reason: string };

/** 本卷组合身份（读到面上给控件/标签用）。 */
export interface SessionCompositionInfo {
  /** 生效组合 id：有卷级记录 = 记录值；无记录 = 全局默认。 */
  presetId: string;
  /** 来源：'session' = 卷级记录（本卷自己的选择）；'global' = 跟随全局默认。 */
  source: 'session' | 'global';
  /** 卷级记录不可用原因（null = 可用，或本卷无记录）。记录仍在——它是「本卷的
   *  组合意图」，修好该 preset 后重开仍回到它（装配面同时给可见提示）。 */
  error: string | null;
}

/** 本卷是否空白（未跑过一轮）——**控件锁与写路径二道闸的唯一判据**。
 *  尺子与侧栏卷计数同款（msgStore 的消息数；空卷 = 无内容可丢 = 可安全重装配）。 */
export function isSessionBlank(storeId: string, sessionId: number): boolean {
  return msgStoreFor(storeId, sessionId).getState().messages.length === 0;
}

/** 本卷组合身份 + 来源（只读面；不写任何状态）。异步 = 解析面动态 import
 *  （见文件头「静态面纪律」——静态可达 store 侧即成环）。 */
export async function sessionCompositionInfo(storeId: string, sessionId: number): Promise<SessionCompositionInfo> {
  const recorded = agentSessionState.getRecordedPresetId(storeId, sessionId);
  const { usePresetStore } = await import('../../state/preset-store');
  if (recorded === null) {
    return { presetId: usePresetStore.getState().selected, source: 'global', error: null };
  }
  const { isPresetKnown, selectionError } = await import('../../composition/preset-assembly');
  const error = isPresetKnown(recorded) ? selectionError(recorded) : `组合「${recorded}」不在册（已被删除或改名）`;
  return { presetId: recorded, source: 'session', error };
}

/** 卷级选择（UI 芯片 / 程序入口共用）。语义见文件头；返回拒绝原因供控件显示。 */
export async function selectSessionPreset(
  ctx: SessionContext,
  sessionId: number,
  presetId: string,
): Promise<SessionPresetChange> {
  const storeId = ctx.storeId;

  // ① 校验：不在册 / 不可解析 = 拒绝（原因进 preset-store.error 供面板显示）
  const { sessionSelectionError } = await import('../../composition/preset-assembly');
  const err = sessionSelectionError(presetId);
  if (err !== null) return { ok: false, reason: err };

  // ② 空白闸：跑过一轮的卷不给换组合（字节契约面；控件面已禁用，这里是二道闸）
  if (!isSessionBlank(storeId, sessionId)) {
    return { ok: false, reason: '本卷已跑过一轮——组合决定模型看到的工具与提示面，不能中途换（另起一卷再选）' };
  }

  // ③ 先拆句柄：拆的同时会清掉卷登记，故必须在登记之前
  const hadHandle = agentSessionState.getAgent(storeId, sessionId) !== null;
  if (hadHandle) agentSessionState.removeAgent(storeId, sessionId);

  // ④ 登记卷级选择（运行时真源）
  agentSessionState.setRecordedPresetId(storeId, sessionId, presetId);

  // ⑤ 立即生效：只有「句柄在场 + 本卷活跃」才需要当场重建——ensureSessionAgent
  //    作用于活跃卷。句柄缺席（新卷常态）由下次装配自然吃到新登记。
  if (hadHandle) {
    const st = getChatStore(storeId).sess.getState();
    const activeSid = st.sessions[st.activeIdx]?.id ?? null;
    if (sessionId === activeSid) {
      const rebuilt = await ensureSessionAgent(ctx);
      if (!rebuilt) return { ok: false, reason: '组合已记录，但本卷 Agent 未重建成功（重开该卷或再次拟文即可）' };
    }
  }
  return { ok: true };
}
