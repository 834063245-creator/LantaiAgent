// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 标题栏触发范围 守护（2026-09-14 事故立法 —— 用户三报「拖动目次带最上方还是会挪
// 窗口」，并直接点出「问题是出在标题栏的触发范围上」）。
//
// 实机取证链（`WindowFromPoint` + 对归属窗口发 `WM_NCHITTEST`；两次被前台其它窗口
// 污染后重测，最终结论）：
//   ① 拖动区 = WebView2 宿主把页面 `-webkit-app-region` **光栅化的一叠薄子窗**
//      （实测 44 个 `Chrome_WidgetWin_0`：y 0-12/12-14/…/56-58/58-63/63-88），
//      每个无条件回 `HTCAPTION`；
//   ② 这叠**只在宿主初始化那一刻按当时的页面算一次、永不重算**：启动落在首页 →
//      按首页 `.sh-head`（~88px 高）算 → 进画布视图后既多出 88px 幽灵标题栏
//      （在那段里拖画布/目次带＝挪窗口），又按首页布局吃掉书眉按钮（实机：真点
//      缩放钮无反应）。改 `--bar-h` 不动它、删 app-region 也不消（删了反倒让窗口钮
//      一起被 caption 吃掉——两轮验证均已回退）；
//   ③ 页面侧的 `no-drag` 挖除只对拖动元素的**后代**生效，对兄弟元素无效。
//
// 修法（本文件钉住的契约）：
//   - **页面不再声明任何 app-region**（首页 + 画布都不声明 → 根本不产生行窗）；
//   - 标题栏交互由元素自己判定：`src/app/window-drag.ts`（单一真源，画布顶部浮件
//     与首页顶栏共用）接 pointerdown → Tauri 原生 `start_dragging` / 双击 →
//     `toggle_maximize`；
//   - 壳层兜底：`src-tauri/src/window_drag_band.rs` 把万一出现的 `HTCAPTION` 一律
//     降为 `HTCLIENT`（其纯函数 `clamp_caption_hit` 带 Rust 用例）。
//
// 2026-09-17 标题栏拆除批：画布视图的书眉布局行退役（画布铺满整窗，顶缘 = 屏缘），
// 窗口拖动热区从「整条 56px 书眉」收成**顶部浮件本身**（.pp-chrome，非交互件 =
// `画布` 二字与件间空白）；首页顶栏（.sh-head）保留。
//
// 2026-09-18 双击回归根治：双击判据从 DOM `dblclick` 移进 `pointerdown` 自数
// （同点位 + 450ms 窗口内的第二下）——`pointerdown` 一响就把窗口交给 OS 模态
// 移动循环，mouseup 不再进页面，`dblclick` 在 WebView2 上一次都不产生。
// `onDoubleClick` 保留为「页面收得到 dblclick 的平台」的去重兜底，故两个标题栏
// **两条接线都仍在册**（见下用例）。行为考：`tests/titlebar-gesture.test.ts`。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const TAURI_SRC = join(__dirname, '..', '..', 'src-tauri', 'src');
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');
const CSS_FILES = [
  ['paper-shell/PaperPanel.css', read(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css')],
  ['canvas-nav/spine-rack.css', read(SRC, 'plugins', 'builtin', 'canvas-nav', 'spine-rack.css')],
  ['canvas-nav/session-sidebar.css', read(SRC, 'plugins', 'builtin', 'canvas-nav', 'session-sidebar.css')],
  ['paper-minimap/minimap.css', read(SRC, 'plugins', 'builtin', 'paper-minimap', 'minimap.css')],
  ['app/foundation.css', read(SRC, 'app', 'foundation.css')],
  ['sessions-home/home.css', read(SRC, 'plugins', 'builtin', 'sessions-home', 'home.css')],
  ['app/shell.css', read(SRC, 'app', 'shell.css')],
] as const;

/** 去掉 CSS 注释后的声明面（注释里讲历史不算声明）。 */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('标题栏触发范围：页面不声明 app-region，命中范围由元素自己判定', () => {
  it('全仓样式不得有任何 app-region 声明（声明即产生「只在启动时算一次」的行窗）', () => {
    for (const [name, css] of CSS_FILES) {
      expect(
        declarations(css),
        `${name} 仍含 app-region 声明——WebView2 会按启动那一刻的页面光栅化出行窗`,
      ).not.toContain('app-region');
    }
  });

  it('两个标题栏（画布顶部浮件 + 首页顶栏）都接共享实现', () => {
    const panel = read(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx');
    const home = read(SRC, 'plugins', 'builtin', 'sessions-home', 'SessionsHome.tsx');
    expect(panel).toContain('onPointerDown={onTopbarPointerDown}');
    expect(panel).toContain('onDoubleClick={onTopbarDoubleClick}');
    expect(home).toContain('onPointerDown={onTopbarPointerDown}');
    expect(home).toContain('onDoubleClick={onTopbarDoubleClick}');
    // 旧实现（Linux-only 兜底 + 手写 IPC）已收编，不得两处各写一份
    expect(home).not.toContain('plugin:window|start_dragging');
  });

  it('画布视图的书眉布局行已退役：画布铺满整窗（顶缘 = 屏缘），热区收进顶部浮件', () => {
    const panel = read(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx');
    const css = read(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css');
    // 书眉 = 56px 布局行 ⇒ 画布顶缘被推离窗口顶，边缘滚动的「指针甩到屏顶」落空
    expect(panel).not.toContain('"pp-topbar"'); // 注释里的历史沿革不算声明
    expect(declarations(css)).not.toContain('pp-topbar');
    // 浮件是覆盖件（.pp-canvas 的兄弟）——悬停判据据「画布本体」量，故不滚：
    // 结构上必须仍是 .pp-root 的直接子元素，而不是塞进 .pp-canvas 里
    const chromeAt = panel.indexOf('className="pp-chrome"');
    expect(chromeAt).toBeGreaterThan(-1);
    const canvasAt = panel.indexOf('className={`pp-canvas');
    expect(canvasAt).toBeGreaterThan(-1);
    expect(canvasAt).toBeLessThan(chromeAt); // 浮件渲染在画布之后（同级、覆盖其上）
    expect(panel.slice(canvasAt, chromeAt)).not.toContain('pp-chrome');
  });

  it('共享实现走 Tauri 原生通道，且交互件豁免', () => {
    const helper = read(SRC, 'app', 'window-drag.ts');
    expect(helper).toContain("invoke('plugin:window|start_dragging'");
    expect(helper).toContain("invoke('plugin:window|toggle_maximize'");
    expect(helper).toContain("closest('button, input, kbd, a, select, textarea");
    expect(helper).toContain('.wc-btns');
    expect(helper).toContain('.sl-root');
    // 双击判据在 pointerdown 里自数（2026-09-18）——只认 dblclick 的写法在 WebView2
    // 上一次都不响（OS 模态拖动循环吃掉 mouseup），行为考见 titlebar-gesture.test.ts
    expect(helper).toContain('DOUBLE_CLICK_MS');
    expect(helper).toContain('lastPointerDownDoubleClickAt');
    // 画布书眉是产物域 → 经宿主桥（三处同步：host.ts / host.aliased.ts / host-modules faceDeps）
    expect(read(SRC, 'plugins', 'builtin', 'paper-shell', 'host.ts')).toContain('onTopbarPointerDown');
    expect(read(SRC, 'plugins', 'builtin', 'paper-shell', 'host.aliased.ts')).toContain(
      'export const onTopbarPointerDown = impl.onTopbarPointerDown;',
    );
  });

  it('壳层兜底在位：caption 一律降为 client（含 Rust 用例）', () => {
    const band = read(TAURI_SRC, 'window_drag_band.rs');
    expect(band).toContain('clamp_caption_hit');
    expect(band).toContain('HTCLIENT as i32');
    expect(band).toContain('caption_neutralized_everywhere');
    expect(band).toContain('other_hits_untouched');
  });
});
