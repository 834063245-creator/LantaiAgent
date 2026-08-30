// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/focus-flight — 焦点飞行调度状态机（2026-08-31 视口乱飞修复）。
//
// 病史：书脊/侧边栏定位、新建会话、展开磁盘卷都会 requestFocus(sessionId) →
// pendingFocusId。PaperPanel 两个响应：请求到来飞一次；regions 引用变化再
// 检查补飞（expand 在途卷落定后补飞）。病灶在补飞：regions 随视口每帧换
// 引用，动画在途时补飞把 rAF 动画 cancel+重播 → 动画永不完 → pending 永不
// 清 → 自锁。实机症状 = 点书脊定位/新建会话时视口乱飞。
//
// 本模块 = 「动画在途不重播」的纯决策：同目标在途 → rejected（regions 每帧
// 打扰被吞掉）；异目标/glide 跳转在途 → superseded（用户明确点了别处，允许
// 取代在途动画）；空闲 → started。PaperPanel 持有唯一实例：动画启动处
// begin、完成/中断处 end。零 DOM 零依赖，用户操作序列可直测。

export type FocusFlightVerdict = 'started' | 'superseded' | 'rejected';

export interface FocusFlightScheduler {
  /** 当前是否有飞行在途（rAF 未收尾）——补飞等打扰源的决策面。 */
  isActive(): boolean;
  /** 当前飞行目标（小地图 glide 跳转 = null）。 */
  targetSessionId(): string | null;
  /** 请求启动一次飞行。空闲 → started；同目标在途 → rejected；异目标在途 → superseded。 */
  begin(sessionId: string | null): FocusFlightVerdict;
  /** 飞行完成/中断：active → idle。 */
  end(): void;
  /** 测试复位。 */
  reset(): void;
}

export function createFocusFlightScheduler(): FocusFlightScheduler {
  let active = false;
  let target: string | null = null;
  return {
    isActive: () => active,
    targetSessionId: () => target,
    begin(sessionId) {
      if (active) {
        if (target === sessionId) return 'rejected';
        target = sessionId; // 新飞行取代旧飞行：目标同步为新卷
        return 'superseded';
      }
      active = true;
      target = sessionId;
      return 'started';
    },
    end() {
      active = false;
      target = null;
    },
    reset() {
      active = false;
      target = null;
    },
  };
}
