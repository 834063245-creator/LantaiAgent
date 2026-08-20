// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 1（hologram/shell-platform）：平台标记 + no-bf 降级 + resize 热区。
// 自 main.ts 885-901 机械迁移（零逻辑变更；原模块级块改为 boot 函数体，
// 由编排器按表序调用——执行时机与「React render 前后」无耦合依赖）。

import { installResizeZones } from '../../ui/resize-zones';

export function bootPlatform(): void {
  // ── 平台标记 + 渲染能力检测：方便 CSS 针对平台/引擎能力做差异化处理 ──
  const ua = navigator.userAgent;
  const plat = ua.includes('Linux')
    ? 'linux'
    : ua.includes('Windows')
      ? 'windows'
      : ua.includes('Mac')
        ? 'macos'
        : 'unknown';
  document.documentElement.setAttribute('data-platform', plat);
  // WebKitGTK <2.46 / 软件渲染下 backdrop-filter 不可靠 — 全局降级为不透明玻璃（tokens.css html.no-bf）
  const bfOk = CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
  if (!bfOk) document.documentElement.classList.add('no-bf');
  // Linux 无边框窗口无 WM 边缘缩放 — 铺 Tauri 缩放热区（内部自检平台）
  installResizeZones();
}
