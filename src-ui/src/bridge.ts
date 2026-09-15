// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Bridge — 检测 Tauri 与浏览器环境，将 invoke/listen 路由到真实或 mock 实现
// 用此模块替代 '@tauri-apps/api/core' / '@tauri-apps/api/event'
// typeof 守卫：node 环境（真进程集成测试 @vitest-environment node）无
// window——回落 mock 通道（与浏览器 mock 模式同路），webview/jsdom 语义不变。

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

import { log } from './agent/logger';

type RealInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type RealListen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
let _realInvoke: RealInvoke | null = null;
let _realListen: RealListen | null = null;
let _mockInvoke: ((cmd: string, args?: Record<string, unknown>) => string) | undefined;

async function loadMock(): Promise<(cmd: string, args?: Record<string, unknown>) => string> {
  if (!_mockInvoke) {
    const mock = await import('./mock-data');
    _mockInvoke = mock.mockInvoke;
  }
  return _mockInvoke;
}

async function loadReal(): Promise<void> {
  if (!_realInvoke) {
    const core = await import('@tauri-apps/api/core').catch(() => {
      throw new Error('Failed to load Tauri core API — is the app running in Tauri shell?');
    });
    _realInvoke = core.invoke as unknown as RealInvoke;
  }
}

async function loadRealListen(): Promise<void> {
  if (!_realListen) {
    const event = await import('@tauri-apps/api/event').catch(() => {
      throw new Error('Failed to load Tauri event API — is the app running in Tauri shell?');
    });
    // Tauri 的 EventCallback<T> 携带 event/id 元字段 — 本桥接层只暴露 payload，
    // 类型边界收窄在模块加载点一次性完成（运行时直通）。
    _realListen = event.listen as unknown as RealListen;
  }
}

/**
 * `invoke`（来自 @tauri-apps/api/core）的直接替代品。
 * 浏览器环境（npm run dev）下路由到 mock 数据。
 * Tauri 环境下调用真实后端。
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (IS_TAURI) {
    await loadReal();
    log.debug('bridge', 'invoke', { command: cmd });
    try {
      if (!_realInvoke) throw new Error('invoke bridge not initialized');
      const result = await _realInvoke(cmd, args);
      return result as T;
    } catch (e) {
      log.error('bridge', 'invoke failed', { command: cmd, error: String(e) });
      throw e;
    }
  }
  // 浏览器 mock 模式：mock 返回与 Rust 出口同形（JSON 命令返 JSON 字符串、
  // 文本命令返原文），零转换直通。
  return (await loadMock())(cmd, args) as T;
}

/**
 * `listen`（来自 @tauri-apps/api/event）的直接替代品。
 * 浏览器环境下返回空操作 unlisten 函数。
 */
export async function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  if (IS_TAURI) {
    await loadRealListen();
    if (!_realListen) throw new Error('listen bridge not initialized');
    return _realListen(event, handler);
  }
  // 浏览器：无文件监听 — 返回一个空 unlisten
  return () => {};
}

/** 在浏览器中独立运行时为 true（npm run dev）。 */
export function isMockMode(): boolean {
  return !IS_TAURI;
}

/**
 * RPC — 所有应用命令的统一入口。
 * 替代单独的 invoke('cmd_name', params) 调用。
 * 自动将 camelCase 参数键转换为 snake_case 以适配 Rust 后端。
 *
 * 返回值语义（rpc Value 化第二步，2026-08-22，landmine 根治级）：
 * Rust 出口（rpc.rs rpc_result_shape 表）对 JsonValue 形态命令返回真结构化
 * Value（JSON 命令已展开）；Text 形态命令包 Value::String 字节精确直通
 * （read_file_content 读 .json 文件不能被误展开）。消费面：typedJsonRpc
 * 双形态兼容（结构化透传 / 字符串 parse 慢路径——浏览器 mock 返字符串）；
 * agentInvoke 对结构化返回回卷 JSON 字符串（agent 工具链 string 世界零改动）。
 */
export async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      // ponytail：仅在 lowercase→uppercase 转换处插入 _。
      // 避免破坏缩写词（URI → uri，而非 u_r_i）。
      const snakeKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      normalized[snakeKey] = value;
    }
  }
  return invoke<T>('rpc', { method, params: normalized });
}

// ── Webview 原生文件拖放（创作坞「拖文件入卷」数据通道，2026-08-31）──
//
// 为什么不走 HTML5 drop：T2 WebView dragDropEnabled 默认接管拖放，网页层
// 永远收不到 drop 事件（C10 尸检结论，baton6——当年因此砍掉假拖放）。真做
// 只能走 Tauri onDragDropEvent 原生通道；与 invoke/listen 同属 Tauri 路由
// 面，住本桥（ui/ 封口纪律：不为一个函数开新文件）。
//
// 坐标系：Tauri 事件给 PhysicalPosition——除以 devicePixelRatio 转回 CSS
// 像素，消费方才能与 getBoundingClientRect 直接做命中判定。

export type FileDropPhase = 'enter' | 'over' | 'drop' | 'leave';

export interface FileDragEvent {
  phase: FileDropPhase;
  /** OS 拖入的文件绝对路径（leave 相无 paths）。 */
  paths: string[];
  /** CSS 像素坐标（物理坐标已按 devicePixelRatio 折算）。 */
  x: number;
  y: number;
}

/** 监听 webview 级文件拖放。返回 unlisten；非 Tauri 环境返回空函数。 */
export async function watchFileDragDrop(handler: (e: FileDragEvent) => void): Promise<() => void> {
  if (isMockMode()) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type !== 'enter' && p.type !== 'over' && p.type !== 'drop' && p.type !== 'leave') return;
    const dpr = window.devicePixelRatio || 1;
    const pos = 'position' in p ? p.position : { x: 0, y: 0 };
    handler({
      phase: p.type,
      paths: 'paths' in p && Array.isArray(p.paths) ? p.paths : [],
      x: pos.x / dpr,
      y: pos.y / dpr,
    });
  });
  return unlisten;
}

// ── 关窗请求（真退出 flush 的权威入口，2026-09-15 存盘审计 P0）──
//
// 为什么需要它：`beforeunload` 在 WebView2/Tauri 关窗时**不触发**（上游
// WebView2Feedback#3217 / tauri#2996），而 Tauri 关窗 = 销毁窗口 → main.rs
// 的 `WindowEvent::Destroyed` 分支 drain 后 `std::process::exit(0)`——异步落盘
// 必被腰斩。Tauri 官方形态 = 拦截 close-requested（preventDefault）→ 自己做
// 收尾 → 主动 destroy()。与 drag/drop 同属「Tauri 路由面，住本桥」。

export interface WindowCloseRequest {
  /** 阻止本次关闭（调用方承诺最终自行 destroy——否则窗口永不关闭）。 */
  preventDefault(): void;
  /** 销毁窗口（此后 Rust 侧 Destroyed → 进程退出）。 */
  destroy(): Promise<void>;
}

/** 监听关窗请求（非 Tauri 环境返回空 unlisten——dev/mock 走 beforeunload 兜底）。 */
export async function watchWindowClose(handler: (ev: WindowCloseRequest) => void): Promise<() => void> {
  if (isMockMode()) return () => {};
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  return win.onCloseRequested((event) => {
    handler({
      preventDefault: () => event.preventDefault(),
      destroy: () => win.destroy(),
    });
  });
}
