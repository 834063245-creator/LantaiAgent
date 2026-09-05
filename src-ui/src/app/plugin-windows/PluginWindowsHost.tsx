// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件应用窗视口层（app shell 四件套 · 件 A，S3）——窗口注册表的渲染宿主。
// 三模式布局：floating（画布上浮动窗——body portal 定位，避 transform 包含块
// ——ToastHost 同款纪律）/ dock（右侧停靠栏）/ fullscreen（盖满视口）。
// 与画布底座共存（计划测试 d）：pan 只在画布自身/.pp-world 上触发（panningRef
// 纪律），本层是 body portal 兄弟层天然不触发；帧内指针事件一律
// stopPropagation 加固防线。无开窗时零渲染。

import { createPortal } from 'react-dom';
import { usePluginWindowStore } from '../../state/plugin-window-store';
import { PluginWindowFrame } from './PluginWindowFrame';

export function PluginWindowsHost() {
  const windows = usePluginWindowStore((s) => s.windows);
  const defs = usePluginWindowStore((s) => s.defs);
  if (windows.length === 0) return null;
  const floating = windows.filter((w) => w.mode === 'floating');
  const docked = windows.filter((w) => w.mode === 'dock');
  const fullscreen = windows.filter((w) => w.mode === 'fullscreen');
  return createPortal(
    <>
      {floating.map((w) =>
        defs[w.pluginName] ? <PluginWindowFrame key={w.windowId} instance={w} def={defs[w.pluginName]} /> : null,
      )}
      {docked.length > 0 ? (
        <div className="pw-dock">
          {docked.map((w) =>
            defs[w.pluginName] ? <PluginWindowFrame key={w.windowId} instance={w} def={defs[w.pluginName]} /> : null,
          )}
        </div>
      ) : null}
      {fullscreen.map((w) =>
        defs[w.pluginName] ? <PluginWindowFrame key={w.windowId} instance={w} def={defs[w.pluginName]} /> : null,
      )}
    </>,
    document.body,
  );
}
