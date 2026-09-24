// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// bundled-engine-store — 随包图谱引擎的**接线回执**（2026-09-16 用户实机报缺陷后补）。
//
// 病灶（用户报「打包好的 exe 里好像引擎根本没挂上，开关在哪呢」）：
//   ① 开关藏在「设置 → MCP」页的最底部（在用户级 server 列表与新建表单之后），
//      从页首扫下去看不见 ⇒ **可发现性**问题；
//   ② 接线结果（wired / reason）此前只进 `console.log/warn`——用户看不到，
//      于是「引擎到底挂上没有」既无法证实也无法证伪 ⇒ **无回执**问题。
//   ③ 实机取证（CDP 只读探针，2026-09-16）：打包 app 里 `engine_bundled_info`
//      返回 `available: true`（引擎就在 lantai.exe 同级），而
//      `lantai.bundledEngine.enabled` 为 `null` ⇒ 开关从未被拨过——问题确认在
//      「看不见／没回执」，不在探测链路。
//
// 本 store 承载回执：写入点唯一 = `workspace.ts` 工作区激活时的接线调用；
// 读取点 = 设置面板「随包图谱引擎」区块（与探测态、开关态同屏）。
//
// 归属（CONVENTIONS §1.10 第 3 类）：进程级单例 store，与 dock-store /
// composition-store 同族。跨组件业务状态走 store，**不复活事件总线**。

import { create } from 'zustand';

/** 回执态：`idle` = 本进程还没打开过工作区。 */
export type BundledEngineWiringStatus = 'idle' | 'off' | 'wired' | 'failed';

export interface BundledEngineReceipt {
  status: BundledEngineWiringStatus;
  /** 回执归属的工作区根（`off`/`failed` 也填——用户要知道是哪个工作区）。 */
  workspacePath: string | null;
  /** 未接线原因（开关未启用时 null——那是用户意图，不是异常）。 */
  reason: string | null;
  /** 在册的引擎工具数（仅 wired 态有值；null = 未接线）。
   *
   *  2026-09-24 用户实机报「接线显示正常、进程也起了，Agent 手里却没工具」——
   *  旧回执把「行注册成功」当接线成功，与用户真正在意的判据（工具到手）脱节。
   *  现在 wired ⟺ 工具面非空，本字段是那句话的证据。 */
  toolCount: number | null;
  /** 回执时间（ms）；null = 无回执。 */
  at: number | null;
}

const INITIAL: BundledEngineReceipt = { status: 'idle', workspacePath: null, reason: null, toolCount: null, at: null };

interface BundledEngineStore extends BundledEngineReceipt {
  /** 写回执（`workspace.ts` 专用；UI 只读）。 */
  report(receipt: {
    status: BundledEngineWiringStatus;
    workspacePath: string;
    reason?: string | null;
    toolCount?: number | null;
  }): void;
  /** 测试复位。 */
  reset(): void;
}

export const useBundledEngineStore = create<BundledEngineStore>((set) => ({
  ...INITIAL,
  report: ({ status, workspacePath, reason, toolCount }) =>
    set({ status, workspacePath, reason: reason ?? null, toolCount: toolCount ?? null, at: Date.now() }),
  reset: () => set({ ...INITIAL }),
}));

/** 回执 → 人类可读一行（设置面板与状态栏共用一份措辞，避免两处措辞漂移）。 */
export function describeReceipt(receipt: BundledEngineReceipt, enabled: boolean): string {
  switch (receipt.status) {
    case 'idle':
      return '本进程尚未打开过工作区——打开一个工作区后这里会显示接线结果';
    case 'wired': {
      // 工具数写进回执：这才是「Agent 手上有没有图谱工具」的直接读数
      const n = receipt.toolCount ?? 0;
      return `本工作区已接线：${receipt.workspacePath ?? ''}（${n} 个引擎工具在册）`;
    }
    case 'failed':
      return `本工作区未接线：${receipt.reason ?? '原因未知'}`;
    default:
      // off：区分「开关关着」与「开关已拨但本工作区还没重开」——后者是用户最容易
      // 误判为"没生效"的态（默认关 + 生效时机是下次打开工作区）。
      return enabled
        ? '开关已启用，但本工作区尚未接线——重开工作区后生效'
        : '本工作区未接线：开关未启用（拨上后重开工作区生效）';
  }
}
