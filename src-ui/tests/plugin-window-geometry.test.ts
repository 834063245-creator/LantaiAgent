// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 浮动窗几何记忆（2026-11-23，v75 同批）：
//   ① 落盘 / 读回（按插件名分开，互不串味）；
//   ② 毒化容忍：坏 JSON / 坏形状 / 不认识的版本 / 非数值 → 当没有，不炸开窗；
//   ③ 读时夹进视口：换屏/改分辨率后窗还抓得回来（书眉可达、尺寸不超视口）；
//   ④ 优先级：用户落盘几何 > manifest.app.size > 缺省 460×360。
//
// 环境 = happy-dom：localStorage 是这套语义的承载物（node 环境下模块会静默
// 退化成「没有记忆」，那是给纯逻辑测试留的降级路径）。

import { beforeEach, describe, expect, it } from 'vitest';
import { resetMcpGovernorForTests } from '../src/plugins/mcp-bridge';
import { validateManifest } from '../src/plugins/types';
import { openPluginWindow } from '../src/plugins/window-facility';
import type { PluginWindowDef } from '../src/state/plugin-window-store';
import { usePluginWindowStore } from '../src/state/plugin-window-store';
import { loadWindowGeometry, resetWindowGeometryForTests, saveWindowGeometry } from '../src/state/window-geometry';
import {
  PLUGIN_WINDOW_DEFAULT_H,
  PLUGIN_WINDOW_DEFAULT_W,
  PLUGIN_WINDOW_MIN_H,
  PLUGIN_WINDOW_MIN_W,
} from '../src/state/window-metrics';

const ORIGIN = 'http://127.0.0.1:14570/plugins';

function defOf(pluginName: string, size?: { w: number; h: number }): PluginWindowDef {
  return {
    pluginName,
    entryUrl: ORIGIN + '/' + pluginName + '/app/index.html',
    kind: 'asset',
    mode: 'floating',
    title: '便签',
    documents: false,
    ...(size ? { size } : {}),
  };
}

function openFirst(pluginName: string): { x: number; y: number; w: number; h: number } {
  openPluginWindow(pluginName);
  const win = usePluginWindowStore.getState().windows[0];
  expect(win, '开窗失败——窗口定义没登记？').toBeDefined();
  return { x: win.x, y: win.y, w: win.w, h: win.h };
}

beforeEach(() => {
  resetWindowGeometryForTests();
  usePluginWindowStore.getState().resetPluginWindowsForTests();
  resetMcpGovernorForTests();
});

describe('窗口几何落盘：存取与毒化容忍', () => {
  it('按插件名存取（互不串味）；没记录 = null', () => {
    expect(loadWindowGeometry('acme/notes')).toBeNull();
    saveWindowGeometry('acme/notes', { x: 120, y: 80, w: 700, h: 500 });
    saveWindowGeometry('acme/board', { x: 200, y: 60, w: 900, h: 640 });
    expect(loadWindowGeometry('acme/notes')).toEqual({ x: 120, y: 80, w: 700, h: 500 });
    expect(loadWindowGeometry('acme/board')).toEqual({ x: 200, y: 60, w: 900, h: 640 });
  });

  it('坏 JSON / 坏形状 / 未知版本 / 非数值 → 当没有（开窗照常走缺省）', () => {
    localStorage.setItem('lantai.pluginWindowGeometry', '{坏掉的 json');
    expect(loadWindowGeometry('acme/notes')).toBeNull();
    localStorage.setItem(
      'lantai.pluginWindowGeometry',
      JSON.stringify({ v: 99, windows: { 'acme/notes': { x: 1, y: 2, w: 700, h: 500 } } }),
    );
    expect(loadWindowGeometry('acme/notes')).toBeNull();
    localStorage.setItem(
      'lantai.pluginWindowGeometry',
      JSON.stringify({ v: 1, windows: { 'acme/notes': { x: 'a', y: 2, w: 700, h: 500 } } }),
    );
    expect(loadWindowGeometry('acme/notes')).toBeNull();
    localStorage.setItem('lantai.pluginWindowGeometry', JSON.stringify({ v: 1, windows: '不是表' }));
    expect(loadWindowGeometry('acme/notes')).toBeNull();
  });

  it('读时夹进视口：超大/屏外几何回到「书眉可达 + 不超视口」', () => {
    saveWindowGeometry('acme/notes', { x: 5000, y: 5000, w: 5000, h: 5000 });
    const restored = loadWindowGeometry('acme/notes', { w: 1024, h: 768 });
    expect(restored).toEqual({ x: 904, y: 720, w: 1000, h: 744 }); // 1024-120 / 768-48 / 减 24
    // 视口比下限还小时保下限（宁可挂出去一点，也不能把窗挤没）
    const tiny = loadWindowGeometry('acme/notes', { w: 200, h: 200 });
    expect(tiny?.w).toBe(PLUGIN_WINDOW_MIN_W);
    expect(tiny?.h).toBe(PLUGIN_WINDOW_MIN_H);
  });
});

describe('窗口几何优先级：落盘 > manifest.app.size > 缺省', () => {
  it('没有落盘记录：manifest 声明的 size 是起手尺寸', () => {
    usePluginWindowStore.getState().registerAppDef(defOf('acme/notes', { w: 900, h: 700 }));
    expect(openFirst('acme/notes')).toMatchObject({ w: 900, h: 700 });
  });

  it('都没有：缺省 460×360', () => {
    usePluginWindowStore.getState().registerAppDef(defOf('acme/notes'));
    expect(openFirst('acme/notes')).toMatchObject({ w: PLUGIN_WINDOW_DEFAULT_W, h: PLUGIN_WINDOW_DEFAULT_H });
  });

  it('有落盘记录：用户的几何盖过 manifest 声明（位置也按用户上次的）', () => {
    usePluginWindowStore.getState().registerAppDef(defOf('acme/notes', { w: 900, h: 700 }));
    saveWindowGeometry('acme/notes', { x: 200, y: 150, w: 640, h: 480 });
    expect(openFirst('acme/notes')).toEqual({ x: 200, y: 150, w: 640, h: 480 });
  });

  it('落盘值超出当前视口：恢复也被夹住（不是原样开在屏幕外）', () => {
    usePluginWindowStore.getState().registerAppDef(defOf('acme/notes'));
    saveWindowGeometry('acme/notes', { x: 5000, y: 5000, w: 5000, h: 5000 });
    const opened = openFirst('acme/notes');
    expect(opened.x).toBeLessThanOrEqual(window.innerWidth - 120);
    expect(opened.y).toBeLessThanOrEqual(window.innerHeight - 48);
    expect(opened.w).toBeLessThanOrEqual(window.innerWidth - 24);
    expect(opened.h).toBeLessThanOrEqual(window.innerHeight - 24);
  });
});

describe('v75 schema 与几何同一把尺子', () => {
  it('schema 的下界与运行时最小尺寸一致（改一处不改另一处 = 红）', () => {
    const v = validateManifest({
      name: 'p',
      version: '1.0.0',
      entry: 'entry.js',
      app: { entry: './a.html', size: { w: 1, h: 1 } },
    });
    expect(v.ok).toBe(false);
    const min = validateManifest({
      name: 'p',
      version: '1.0.0',
      entry: 'entry.js',
      app: { entry: './a.html', size: { w: PLUGIN_WINDOW_MIN_W, h: PLUGIN_WINDOW_MIN_H } },
    });
    expect(min.ok).toBe(true);
  });
});
