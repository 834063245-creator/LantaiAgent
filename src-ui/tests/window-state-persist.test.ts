// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 窗口状态（最大化 / 位置 / 尺寸）落盘 守护 —— 2026-09-18 事故立法。
//
// 病灶（只读排查实证，2026-09-18）：
//   `tauri-plugin-window-state` 全仓**唯一**的落盘点在 `RunEvent::Exit`
//   （插件 `src/lib.rs` 的 `.on_event(|app, event| if let RunEvent::Exit ...)`），
//   而壳层在窗口 `Destroyed` 里 `std::process::exit(0)`（防僵尸子进程的既定设计）
//   **抢在事件循环收尾之前**（tauri-runtime-wry 的次序：窗口监听器先跑 →
//   之后才 `ExitRequested` → `ControlFlow::Exit` → `LoopDestroyed` → `RunEvent::Exit`）
//   ⇒ 正常关窗永不落盘。
//   物证：`%APPDATA%\com.lantai.app\.window-state.json` 只在「应用还在运行时被系统
//   关机」的两次里、**关机那一秒**被写（09-15 04:12:24 / 09-16 18:34:49，后者与
//   System 日志 `1074 User32` 同秒），此后十余次应用自身退出一次都没写；文件内容
//   停在 `maximized:false` + `x/y = -8,-8`（= 最大化时的外框角位），于是每次启动
//   都在左上角还原成一个未最大化的 1000×700。
//
// 修法（本文件钉住）：`CloseRequested` 分支显式 `save_window_state(all())`——
// 那一刻窗口还活着（几何与最大化态都读得到），且三条关窗路径（窗口钮 /
// 前端 `watchWindowClose` 拦截后 destroy / 系统关窗）都先经过它。
//
// 覆盖边界：这是**源码契约钉值**（壳层闭包在 `main()` 里，构造真窗口的集成测试
// 在 CI 上不可行）。行为面验收 = 真机：最大化 → 关窗 → 重开仍是最大化，
// 且 `.window-state.json` 的 mtime 随每次关窗前进。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const main = readFileSync(join(__dirname, '..', '..', 'src-tauri', 'src', 'main.rs'), 'utf8');

describe('窗口状态落盘：关窗请求时显式写盘（插件的 RunEvent::Exit 到不了）', () => {
  it('window-state 插件在册（缺它 = 状态文件根本不存在）', () => {
    expect(main).toContain('tauri_plugin_window_state::Builder::new().build()');
  });

  it('CloseRequested 里落盘：窗口还活着的唯一时刻，三条关窗路径的公共前置', () => {
    expect(main).toContain('tauri::WindowEvent::CloseRequested { .. }');
    expect(main).toContain('save_window_state(StateFlags::all())');
    // 失败必须可见（错误不静默）——不得写成 let _ = ...
    expect(main).toContain('窗口状态落盘失败');
  });

  it('Destroyed 仍是硬退：不得为了「让插件自己落盘」把它顺手删掉（僵尸子进程会回来）', () => {
    expect(main).toContain('tauri::WindowEvent::Destroyed');
    expect(main).toContain('std::process::exit(0)');
  });
});
