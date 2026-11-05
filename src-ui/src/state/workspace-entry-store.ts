// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-entry-store — 进入工作区的「展卷」态（2026-11-05 入口 UX 批）。
//
// 为什么需要（病灶）：进入工作区 = 绑定 + 物化（Agent 装配 + 会话/画布恢复），
// 本机实测 3~5s（ui.log：workspace_activate → agent created ≈ 3.1s，卷体解析只占
// ~100ms）。旧 UX 把这段时间藏在首页的 isBusy 守卫后面——点击被**丢弃**、只换一行
// 放在版心末尾（可能滚出视口）的 11px 状态字；画布那边则先闪旧区纸面、再挂一张
// 空案头（还带着可点的输入条）。三处叠起来就是「割裂」。
//
// 定案（2026-11-05 用户拍板「按绑定/物化两段 + 展卷页落地到第 2 刀」）：
//   · 导航先发生——点击工作区立刻开纸面，纸壳渲染展卷页；
//   · 等待归纸面——本 store 是展卷页的唯一数据源（阶段 / 工作区名 / 起始时刻 / 失败原因）；
//   · 首页不再有任何 busy 守卫（它永远可点）。
//
// 单一权威：写入方 = shell/rows/workspace.ts 的 switchWorkspace（进入唯一入口）；
// 读取方 = paper-shell 的 PaperEntryGate / EnteringSheet。写者唯一 ⇒ 无跨区串扰。
import { create } from 'zustand';

/** 展卷三段（与 switchWorkspace 的三处 await 一一对应——阶段由流程推进，不由计时器猜）。 */
export type WorkspaceEntryPhase = 'binding' | 'assembling' | 'restoring';

export interface WorkspaceEntryState {
  /** 正在进入的工作区路径（null = 不在进入流程中）。 */
  target: string | null;
  /** 展卷页标题用的显示名（路径末段——登记名只有首页有，进入流只拿得到路径）。 */
  name: string;
  phase: WorkspaceEntryPhase;
  /** 起始时刻（最短停留判定 + 展卷页走秒；Date.now）。 */
  startedAt: number;
  /** 失败原因（null = 未失败；非 null 时展卷页转失败态，等待重试/回案头）。 */
  error: string | null;
}

const IDLE: WorkspaceEntryState = { target: null, name: '', phase: 'binding', startedAt: 0, error: null };

export const useWorkspaceEntryStore = create<WorkspaceEntryState>(() => ({ ...IDLE }));

/** 路径末段（工作区显示名的兜底——与首页 wsDisplayName 同规矩）。 */
export function entryDisplayName(path: string): string {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const last = norm.split('/').filter(Boolean).pop();
  return last ?? norm;
}

/** 开始进入某工作区（同步——必须在第一个 await 之前调用，展卷页才接得住）。
 *  name = 首页给的登记名（点的是「星云小说」，展卷页不能翻牌成目录名）；缺省 = 路径末段。 */
export function beginWorkspaceEntry(path: string, name?: string): void {
  useWorkspaceEntryStore.setState({
    target: path,
    name: name?.trim() || entryDisplayName(path),
    phase: 'binding',
    startedAt: Date.now(),
    error: null,
  });
}

/** 推进阶段（只前进——回退会让展卷页闪回上一段）。 */
export function setWorkspaceEntryPhase(phase: WorkspaceEntryPhase): void {
  useWorkspaceEntryStore.setState((s) => (s.target == null ? s : { phase }));
}

/** 失败落定（展卷页转失败态：具名原因 + 重试 / 回案头）。 */
export function failWorkspaceEntry(message: string): void {
  useWorkspaceEntryStore.setState((s) => (s.target == null ? s : { error: message }));
}

/** 收掉展卷态（成功落纸 / 回案头——调用方负责先摘掉纸面关闭守卫）。 */
export function clearWorkspaceEntry(): void {
  useWorkspaceEntryStore.setState({ ...IDLE });
}
