// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件应用窗视口层组件测试（app shell 件 A · S3）：
//   a) 开窗渲染内容（iframe 载体：src = 窗口定义 entryUrl；sandbox 隔离属性）；
//   b) 关窗回收实例（✕ → 设施 close → 注册表清窗）；
//   c) 三模式切换（floating 落位 / dock 进停靠栏 / fullscreen 盖满）；
//   d) 与画布底座共存不抢 pan（帧内指针事件 stopPropagation——画布 pan
//      监听在其自身元素上，此处钉帧内事件不冒泡到 document 的防线）；
//   e) 窗口内容不炸宿主：iframe 独立 document（sandbox opaque origin，
//      结构性隔离）+ 崩溃面 PluginBoundary 包帧体；
//   f) 书眉拖拽（mousedown → document mousemove 写回坐标并夹持 → mouseup 收）。
// 管理面 g（启动器/任务栏走产物流）待用户设计定稿后另批——此处不施工。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginWindowsHost } from '../src/app/plugin-windows/PluginWindowsHost';
import { resetMcpGovernorForTests } from '../src/plugins/mcp-bridge';
import { closePluginWindow, openPluginWindow } from '../src/plugins/window-facility';
import { usePluginWindowStore } from '../src/state/plugin-window-store';

const ORIGIN = 'http://127.0.0.1:14570/plugins';

const DEFS = {
  'acme/notes': {
    pluginName: 'acme/notes',
    entryUrl: ORIGIN + '/acme/notes/app/index.html',
    kind: 'asset',
    mode: 'floating',
    title: '便签',
  },
  'acme/board': {
    pluginName: 'acme/board',
    entryUrl: ORIGIN + '/acme/board/board.html',
    kind: 'asset',
    mode: 'dock',
    title: '看板',
  },
  'acme/plot': {
    pluginName: 'acme/plot',
    entryUrl: ORIGIN + '/acme/plot/plot.html',
    kind: 'asset',
    mode: 'fullscreen',
    title: '大图',
  },
  // 入口二态（契约 v28）：环回远端页（活预览服务形态）
  'acme/preview': {
    pluginName: 'acme/preview',
    entryUrl: 'http://127.0.0.1:26315/',
    kind: 'remote',
    mode: 'floating',
    title: '活预览',
  },
} as const;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  usePluginWindowStore.getState().resetPluginWindowsForTests();
  resetMcpGovernorForTests();
  for (const def of Object.values(DEFS)) {
    usePluginWindowStore.getState().registerAppDef(def);
  }
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

function mountHost(): void {
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(createElement(PluginWindowsHost));
  });
}

describe('S3 视口层：a) 开窗渲染 / b) 关窗回收 / e) 隔离属性', () => {
  it('无开窗零渲染；开窗后 iframe 载体渲染（src = entryUrl，sandbox 不给 same-origin）', () => {
    mountHost();
    expect(document.body.querySelector('.pw-frame')).toBeNull(); // 零渲染
    act(() => {
      openPluginWindow('acme/notes');
    });
    const iframe = document.body.querySelector<HTMLIFrameElement>('.pw-iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe(ORIGIN + '/acme/notes/app/index.html');
    // opaque origin 隔离：sandbox 无 allow-same-origin（窗内容拿不到宿主桥）
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals');
    // 书眉：标题 + 插件名（机读注记）
    expect(document.body.querySelector('.pw-title')?.textContent).toBe('便签');
    expect(document.body.querySelector('.pw-title-plugin')?.textContent).toBe('acme/notes');
  });

  it('入口二态：remote（环回远端页）src 原样 + sandbox 给 allow-same-origin（同源 SSE 才通）', () => {
    mountHost();
    act(() => {
      openPluginWindow('acme/preview');
    });
    const iframe = document.body.querySelector<HTMLIFrameElement>('.pw-iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toBe('http://127.0.0.1:26315/');
    // 远端文档保住自己 origin（跨源文档加 allow-same-origin 不泄父页 DOM），
    // 但它是远端页 ⇒ 不绑宿主桥（帧侧 remote 分支直接跳过 bindBridgeWindow）
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals allow-same-origin');
    expect(document.body.querySelector('.pw-title')?.textContent).toBe('活预览');
  });

  it('✕ 关窗 → 设施 close → 注册表清窗（帧卸载）', () => {
    mountHost();
    act(() => {
      openPluginWindow('acme/notes');
    });
    expect(document.body.querySelector('.pw-frame')).not.toBeNull();
    const btn = document.body.querySelector<HTMLButtonElement>('.pw-close');
    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(usePluginWindowStore.getState().windows).toHaveLength(0);
    expect(document.body.querySelector('.pw-frame')).toBeNull();
    // 设施直关同效（另一扇）
    act(() => {
      openPluginWindow('acme/notes');
      closePluginWindow('acme/notes#2');
    });
    expect(document.body.querySelector('.pw-frame')).toBeNull();
  });
});

describe('S3 视口层：c) 三模式布局', () => {
  it('floating 定位落座 / dock 进停靠栏 / fullscreen 盖满类', () => {
    mountHost();
    act(() => {
      openPluginWindow('acme/notes');
      openPluginWindow('acme/board');
      openPluginWindow('acme/plot');
    });
    const floating = document.body.querySelector<HTMLElement>('.pw-frame-floating');
    expect(floating).not.toBeNull();
    expect(floating?.style.left).not.toBe('');
    const dockHost = document.body.querySelector('.pw-dock');
    expect(dockHost?.querySelector('.pw-frame-dock')).not.toBeNull();
    const fullscreen = document.body.querySelector('.pw-frame-fullscreen');
    expect(fullscreen).not.toBeNull();
    // 模式切换：floating → dock（设施面）
    act(() => {
      const w = usePluginWindowStore.getState().windows.find((x) => x.pluginName === 'acme/notes');
      if (w) usePluginWindowStore.getState().setWindowMode(w.windowId, 'dock');
    });
    expect(document.body.querySelector('.pw-frame-floating')).toBeNull();
    expect(document.body.querySelectorAll('.pw-frame-dock')).toHaveLength(2);
  });
});

describe('S3 视口层：d) 不抢画布 pan（帧内指针事件不冒泡）+ f) 书眉拖拽', () => {
  it('帧内 mousedown 不冒泡到 document（画布 pan 防线——pan 监听不在帧的祖先链上）', () => {
    mountHost();
    act(() => {
      openPluginWindow('acme/notes');
    });
    const docSpy = vi.fn();
    document.addEventListener('mousedown', docSpy);
    const frame = document.body.querySelector<HTMLElement>('.pw-frame-floating');
    frame?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(docSpy).not.toHaveBeenCalled(); // stopPropagation 防线
    document.removeEventListener('mousedown', docSpy);
  });

  it('书眉拖拽：mousedown → document mousemove 写回坐标（夹持）→ mouseup 收手', () => {
    mountHost();
    act(() => {
      openPluginWindow('acme/notes');
    });
    const before = usePluginWindowStore.getState().windows[0];
    const titlebar = document.body.querySelector<HTMLElement>('.pw-titlebar');
    // 按下书眉（焦点顺带抬升）
    act(() => {
      titlebar?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: before.x + 40, clientY: before.y + 12 }),
      );
    });
    const afterFocus = usePluginWindowStore.getState().windows[0];
    expect(afterFocus.z).toBeGreaterThan(before.z);
    // 拖动：位移写回（off = 按下点 - 窗位；新位 = mouse - off）
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 300 }));
    });
    const afterMove = usePluginWindowStore.getState().windows[0];
    expect(afterMove.x).toBe(400 - 40); // 360
    expect(afterMove.y).toBe(300 - 12); // 288
    // 收手：后续 move 不再写回
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 800, clientY: 600 }));
    });
    expect(usePluginWindowStore.getState().windows[0].x).toBe(360);
  });
});
