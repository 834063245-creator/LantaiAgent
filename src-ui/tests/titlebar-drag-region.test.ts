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
//   - 标题栏交互由元素自己判定：`src/app/window-drag.ts`（单一真源，书眉与首页共用）
//     接 pointerdown → Tauri 原生 `start_dragging` / 双击 → `toggle_maximize`；
//   - 壳层兜底：`src-tauri/src/window_drag_band.rs` 把万一出现的 `HTCAPTION` 一律
//     降为 `HTCLIENT`（其纯函数 `clamp_caption_hit` 带 Rust 用例）。

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

  it('两个标题栏（画布书眉 + 首页顶栏）都接共享实现', () => {
    const panel = read(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx');
    const home = read(SRC, 'app', 'SessionsHome.tsx');
    expect(panel).toContain('onPointerDown={onTopbarPointerDown}');
    expect(panel).toContain('onDoubleClick={onTopbarDoubleClick}');
    expect(home).toContain('onPointerDown={onTopbarPointerDown}');
    expect(home).toContain('onDoubleClick={onTopbarDoubleClick}');
    // 旧实现（Linux-only 兜底 + 手写 IPC）已收编，不得两处各写一份
    expect(home).not.toContain('plugin:window|start_dragging');
  });

  it('共享实现走 Tauri 原生通道，且交互件豁免', () => {
    const helper = read(SRC, 'app', 'window-drag.ts');
    expect(helper).toContain("invoke('plugin:window|start_dragging'");
    expect(helper).toContain("invoke('plugin:window|toggle_maximize'");
    expect(helper).toContain("closest('button, input, kbd, a, select, textarea");
    expect(helper).toContain('.wc-btns');
    expect(helper).toContain('.sl-root');
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
