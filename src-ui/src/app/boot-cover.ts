// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// boot-cover — 冷启动封面的揭幕时机（2026-11-05 冷启动 UX 批）。
//
// 封面本体在 index.html（内联样式，首帧即纸；理由与两个空窗见该文件注）。
// 本模块只负责**何时揭幕**——三件事都齐了才收：
//   ① 首页真的画出来了（#app-root .sh-root——sessions-home 是磁盘产物，
//      装载是异步的，注册之前首页槽是空的）；
//   ② **首页的样式真的生效**（.sh-root 的 position 是 fixed；没有样式时是
//      static）——产物 CSS 是运行时注入的 <link>，不等到它就等于让用户看
//      一眼没排版的首页。判据刻意不写成「等全部样式表」：产物 CSS 共 11MB，
//      其中 paper-shell 自己的 4.6MB 与首页首帧无关，等它纯属拖慢启动。
//   ③ 字体就位（MiSans + Noto Mono；19MB/15MB，font-display: swap）——否则
//      揭幕后整页会再换一次字形。
// 另有最短停留（320ms，防秒开闪一帧）与总预算（2500ms，坏样式表不许把人锁在
// 封面上）；index.html 里另有 8s 的绝对兜底（主脚本没跑到这里的情形）。

/** 最短停留（ms）——与展卷页 ENTRY_MIN_MS 同量级。 */
const MIN_MS = 320;
/** 字体等待预算（ms）——超时就用回退字体揭幕（宁可换一次字形，也不干等）。 */
const FONT_BUDGET_MS = 1_200;
/** 总预算（ms）——样式表坏/首页缺席时不让封面成为新的白屏。 */
const REVEAL_BUDGET_MS = 2_500;
/** 揭幕淡出（ms）——与 index.html 的 #boot-cover.is-out transition 同值（= --m-sheet 0.26s；
 *  index.html 先于 tokens.css，用不了 var）。 */
export const BOOT_COVER_FADE_MS = 260;
/** 首页/样式轮询的帧上限（≈2s @60fps；后台窗 rAF 停摆时由总预算兜底）。 */
const MAX_FRAMES = 120;

/** 首页是否已「带样式」画出来：根节点存在 **且** home.css 真的生效。
 *  `.sh-root` 的 position: fixed 是首页版式的基座（home.css 第一条规则）；
 *  样式未到位时计算值是 static——这一条比数 <link> 更直接，也不会把旁的产品
 *  CSS 算进启动时间。 */
function homeStyled(): boolean {
  const root = document.querySelector<HTMLElement>('#app-root .sh-root');
  if (!root) return false;
  return getComputedStyle(root).position === 'fixed';
}

let dismissed = false;

/** 揭幕（幂等：揭幕路径可能重叠——首页就绪 / 恢复面 / 兜底）。 */
export function dismissBootCover(): void {
  if (dismissed) return;
  dismissed = true;
  const cover = document.getElementById('boot-cover');
  if (!cover) return;
  cover.classList.add('is-out');
  window.setTimeout(() => cover.remove(), BOOT_COVER_FADE_MS);
}

/** 首帧之后调用一次：等首页带样式画出来 + 字体（各有预算），再揭幕。 */
export function armBootCover(): void {
  if (typeof document === 'undefined') return;
  const cover = document.getElementById('boot-cover');
  if (!cover) return;

  const minWait = new Promise<void>((resolve) => setTimeout(resolve, MIN_MS));

  const homeReady = new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      resolve();
      return;
    }
    let frames = 0;
    const tick = () => {
      frames += 1;
      if (homeStyled() || frames >= MAX_FRAMES) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // 字体：显式 load（首页渲染也会触发同一请求，这里只是拿得到「完成」信号）。
  // 不支持 FontFaceSet 的环境（jsdom）直接放行。
  const fontsReady = (() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || typeof fonts.load !== 'function') return Promise.resolve();
    return Promise.race([
      Promise.allSettled([
        fonts.load('16px "MiSans"', '兰台'),
        fonts.load('13px "Noto Sans Mono CJK SC"', '0123'),
      ]).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, FONT_BUDGET_MS)),
    ]);
  })();

  const all = Promise.all<void>([minWait, homeReady, fontsReady]);
  void Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, REVEAL_BUDGET_MS))]).then(() =>
    dismissBootCover(),
  );
}
