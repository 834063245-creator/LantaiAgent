// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// quote-flight — **引用那一下的因果**（docs/plans/card-quote-plan.md §6.1）。
//
// 方案 §6.1 把点引用拆成五帧：卡本体 scale 1→0.99「让开」→ 夹签在卡中心生成 →
// 沿二次贝塞尔飞向槽 → 槽展开让位 → 卡本体回 1。**动效不是装饰，是因果可视化**：
// 每一帧都得有起点和终点，禁止凭空生灭（§0.3/§6.4）。
//
// 为什么是命令式浮层而不是 React 状态：飞行是一枚**没有归属**的临时纸片——它不参与
// 布局、不进坞的高度流水、不订阅任何 store（槽是槽、飞行是飞行）。这里只做三件事：
//   ① 量起点（卡中心）与终点（坞里夹签轨的中心）；
//   ② 造一枚跟卡同样大小的浮层，沿弧线飞过去；
//   ③ 落地即摘除（连元素带动画，一个都不留）。
//
// 降级（§6.4）：prefers-reduced-motion: reduce ⇒ 不飞（槽里的出现动画自己承担 120ms 淡入）。
// 量不到终点（坞没渲染 / 夹签轨还没出现）⇒ 整段跳过：**没有终点的位移不许发生**。

/** 控制点上抬（方案 §6.1 帧 3：控制点上抬 40px——弧线要「抛」出去，不是贴地滑）。 */
const ARC_LIFT = 40;

/** 时长与曲线**不在本文件定**（§15：曲线只有 tokens.css 里那两条，时长走 token）。
 *  飞一次 = 一次位移，量级与「纸被推开」同档 ⇒ 读 `--m-sheet` 与 `--m-ease-out`。
 *  读不到（测试域 / 未挂 tokens）才回落到方案 §6.1 的 260ms 与出相曲线。 */
function motionTokens(): { duration: number; easing: string } {
  const fallback = { duration: 260, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' };
  if (typeof document === 'undefined' || !document.documentElement) return fallback;
  const cs = getComputedStyle(document.documentElement);
  const raw = cs.getPropertyValue('--m-sheet').trim(); // 形如 "0.26s cubic-bezier(...)"
  const secs = /^([\d.]+)s\b/.exec(raw);
  const easing = cs.getPropertyValue('--m-ease-out').trim();
  return {
    duration: secs ? Math.round(Number(secs[1]) * 1000) : fallback.duration,
    easing: easing || fallback.easing,
  };
}

/** 起点：那张卡现在在哪（视口坐标）；量不到就返回 null（调用方跳过整段）。
 *  定位键 = **块 id**（`data-block-id`，纸壳每块恒有）——不为一次飞行去新增 DOM 属性。 */
function startRectOf(blockId: string): DOMRect | null {
  const el = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
  return el ? el.getBoundingClientRect() : null;
}

/** 终点：坞里那条夹签轨的最后一枚（刚进槽的那一枚）。
 *  这一枚的渲染与本次调用同属一次提交之后，故允许「下一帧再量」一次。 */
async function endRectOf(): Promise<DOMRect | null> {
  const pick = (): DOMRect | null => {
    const rail = document.querySelector<HTMLElement>('.pp-card-rail');
    if (!rail) return null;
    const items = rail.querySelectorAll<HTMLElement>('.pp-quote-wrap');
    const target = items[items.length - 1] ?? rail;
    return target.getBoundingClientRect();
  };
  const first = pick();
  if (first) return first;
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  return pick();
}

/** 飞一枚夹签（同步返回；动画跑完自己摘除元素）。
 *  `blockId` = 起点那张卡的块 id；`quoteKey` = 趋势里那枚夹签的去重键（量终点用）。 */
export function flyQuoteGhost(blockId: string): void {
  if (typeof document === 'undefined') return;
  // §6.4 降级：减少动效 ⇒ 不飞（槽里那枚的落位淡入已经是可见回执）
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const from = startRectOf(blockId);
  if (!from) return; // 起点都量不到 = 没有因果可画
  void endRectOf().then((to) => {
    if (!to) return; // 没有终点的位移不许发生
    const ghost = document.createElement('div');
    ghost.className = 'pp-quote-fly';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.left = `${from.left}px`;
    ghost.style.top = `${from.top}px`;
    ghost.style.width = `${from.width}px`;
    ghost.style.height = `${from.height}px`;
    document.body.appendChild(ghost);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const { duration, easing } = motionTokens();
    const anim = ghost.animate(
      [
        { transform: 'translate(0px, 0px) scale(1)', opacity: 0.9, offset: 0 },
        {
          transform: `translate(${dx * 0.55}px, ${dy * 0.55 - ARC_LIFT}px) scale(0.8)`,
          opacity: 1,
          offset: 0.55,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0.35, offset: 1 },
      ],
      { duration, easing, fill: 'forwards' },
    );
    anim.onfinish = () => ghost.remove();
    anim.oncancel = () => ghost.remove();
  });
}
