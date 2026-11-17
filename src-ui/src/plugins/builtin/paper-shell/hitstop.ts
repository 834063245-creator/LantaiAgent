// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// hitstop — **冻帧**：一次命中（落纸 / 落印 / 合卷 / 化卷）在命中帧上把整屏动效
// 冻住 30~40ms，再放开。这是动作反馈里「打击感」的核心机制，也是兰台此前完全没有的一档。
//
// 病灶（2026-11-16 判「粗糙」之后追查）：兰台的动作**只有「动」没有「停」**。
// 化卷那一拍已经有三段错峰（纸让位 / 字退 / 坞升起），但没有一处愿意为「命中」
// 留一帧不动——于是所有动作都是一路滑到底，读起来像「渐隐渐现」，不像「打中了」。
// 游戏里的手感八成在**后摇**，而冻帧是后摇的起点：先停住，再有余震。
//
// ── 机制（2026-11-17 实测选型）──
// 用 `document.getAnimations()` 把**全屏**每条动画/过渡都 pause，窗满再 play。
// 三个实测依据（Chromium 1180x900，本机）：
//   ① **CSSAnimation 与 CSSTransition 一视同仁**：实测 2 条（1 keyframes + 1 transition）
//      一并被 pause 且位置纹丝不动（frozen.keyframesMoved = frozen.transitionMoved = 2.49px，
//      那是 pause 前最后一帧的余量，不是漏网）；
//   ② **停顿延迟 1 帧**（pauseFramesToStop = 1）——pause 当帧就静止，不残留惯性；
//      恢复也是 1 帧（resumeFramesToStart = 1），不产生「滞后再补帧」的加速感；
//   ③ **代价可接受**：300 条动画时 getAnimations + 全量 pause + 全量 play
//      一次 2.13ms（单帧预算 16.7ms 的 12.8%）。而冻帧窗**只在进窗/出窗各做一次**，
//      不是每帧都做——窗内浏览器自己就不推进。
//
// ── 为什么不用「给所有动画加 animation-play-state」──
// `.pp-root * { animation-play-state: paused }` 听起来更便宜，但**打不到过渡**
// （transition 没有 play-state），而兰台一半的动效是过渡。getAnimations 是唯一
// 同时覆盖两者的 API。
//
// ── 三条纪律 ──
//   ① **输入永不停**：冻帧只停「动效」，不停键盘/指针。用户在这一窗里打字、
//      滚动、点按钮都照常生效——CSS 动画被暂停不影响 DOM 事件。
//      （这是与游戏的不同：游戏冻的是世界，兰台冻的只是「这一拍的过场」。）
//   ② **可重入**：冻帧窗内再命中一次，窗顺延而不是叠加（`bump` 语义）。
//   ③ **reduced-motion 短路**：动效敏感用户的冻帧 = 0，直接不开窗
//      （同 §15 约束律：JS 帧动画自觉读 matchMedia，CSS 的豁免管不到这里）。

/** 冻帧窗长（ms）。用户 2026-11-16 判「动作反馈」方向时定的量级：30~40ms。
 *
 *  **为什么是 34 而不是整数 30/40**：实测单帧 16.7ms（60Hz），34ms ≈ 2 帧——
 *  一帧读作「没卡」，三帧（50ms）读作「卡了」。2 帧正好落在「停了一下但没坏」的
 *  窗口中央。120Hz 屏上它是 4 帧，仍在该窗口内。 */
export const HITSTOP_MS = 34;

/** 动效敏感短路（与 use-paper-focus.ts 同款判据，否则冻帧会成为漏网之鱼）。 */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface Hitstop {
  /** 起一拍冻帧。重入 = 顺延窗口（不叠加）。返回实际窗长（短路 = 0）。 */
  hit(durationMs?: number): number;
  /** 当前是否在冻帧窗内。 */
  active(): boolean;
  /** 立即收起（组件卸载时用——不许把整屏动画永远冻着）。 */
  release(): void;
  /** 已多少次真开窗（测试/诊断用）。 */
  count(): number;
}

/**
 * 建一个冻帧器。**每个纸壳实例一个**（住在槽主人的 ref 里）——它是整屏级的，
 * 不该是模块级单例（多窗口/多画布会互相冻）。
 */
export function createHitstop(): Hitstop {
  let until = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 本窗冻住的那批动画（出窗时只放它们，不管窗内新起的——新起的根本没被冻过）。 */
  let frozen: Animation[] = [];
  let opened = 0;

  const release = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    until = 0;
    /* 先清空再放：**幂等靠这一行**——不清的话第二次 release 会把同一批动画再 play
     * 一遍（`play()` 对正在跑的动画无害，但窗内**已经播完**的会被重新起跑，
     * 那是一次看得见的跳帧）。 */
    const list = frozen;
    frozen = [];
    for (const a of list) {
      /* `play()` 对「本来就在 running」的动画是幂等的；对已经结束的（窗内播完）
       * 也不再改变状态。但要用 try 兜住「元素已卸载 ⇒ 动画被取消」的情形。 */
      try {
        a.play();
      } catch {
        /* 元素已卸载：动画随元素消失，无需恢复 */
      }
    }
  };

  const hit = (durationMs = HITSTOP_MS) => {
    if (prefersReducedMotion()) return 0;
    if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return 0;

    /* 重入 = 顺延：窗内的动画**已经冻着**，不要再 pause 一遍（那会把「已经停住的」
     * 再记一次进 frozen，出窗时放两遍——虽然 try 兜住了，但账不干净）。 */
    const now = Date.now();
    const wasActive = now < until;
    until = now + durationMs;

    if (!wasActive) {
      const all = document.getAnimations();
      const paused: Animation[] = [];
      for (const a of all) {
        if (a.playState === 'running') {
          try {
            a.pause();
            paused.push(a);
          } catch {
            /* 不可暂停的动画（已结束/idle）跳过 */
          }
        }
      }
      frozen = paused;
      opened += 1;
    }

    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      release();
    }, durationMs);

    return durationMs;
  };

  return {
    hit,
    active: () => Date.now() < until,
    release,
    count: () => opened,
  };
}
