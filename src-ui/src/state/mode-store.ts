// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// mode-store — 权限模式单一真相（C11 重设计，2026-08-22）。
//
// 旧链路三处实病（V5 拆除时明知带病、入口退役后无人调用而休眠）：
//   ① 切换不同步 Rust 镜像——set_permission_mode 只有 workspace 初始化
//     一处调用，中途切模式后台任务仍按启动时旧模式跑（半切）；
//   ② 双源真相（panel-store 内存态 × settings 默认值）+ 单向陷阱
//     （手动切换不落盘，重启回默认）；
//   ③ per-panel 作用域 × 全局单份 Rust 镜像，多面板语义糊。
// 重设计：app 级单例 store（模式是「与 Agent 的相处方式」，属工作台不属面板）；
// 切换 = 写 store + 立刻镜像 Rust + 落盘 settings，一个动作三件事。
//
// 水合：boot 时 hydrateFromSettings()（shell 行调用）——盘上 settings 是
// 上次会话的落盘结果；无值回退 ask。之后所有变更以此 store 为唯一真相。
//
// 模块级可变态归属（CONVENTIONS §1.10）：zustand store 属进程级单例，
// 与 dock-store / composition-store 同族。

import { create } from 'zustand';
import { typedRpc } from '../rpc-contract';
import { loadSettings, saveSettings } from '../settings';

export type PermissionMode = 'ask' | 'auto' | 'yolo';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'yolo'] as const;

/** 人类词面（书眉字样 / 提示用）。 */
export const MODE_LABELS: Record<PermissionMode, string> = {
  ask: '常询',
  auto: '半放',
  yolo: '全放',
};

/** 模式语义说明（确认条 / 提示用）。 */
export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: '每个写操作都递牒请示',
  auto: '安全编辑自动放行，其余请示',
  yolo: '全部放行，不再请示',
};

interface ModeStore {
  permissionMode: PermissionMode;
  /** yolo 二次确认态：非 null 时书眉显示确认条，目标模式存此。 */
  pendingYolo: boolean;
  /** 切换权限模式：写 store + 镜像 Rust + 落盘。 */
  setPermissionMode: (mode: PermissionMode) => void;
  /** yolo 确认条开/合。 */
  setPendingYolo: (pending: boolean) => void;
}

export const useModeStore = create<ModeStore>(() => ({
  permissionMode: 'ask',
  pendingYolo: false,
  setPermissionMode: (mode) => {
    useModeStore.setState({ permissionMode: mode, pendingYolo: false });
    // 镜像 Rust — 后台任务（同步权限路径）旁路判定靠它；失败可见（不静默吞，
    // 但不阻断交互——镜像失败时前台闸门仍按本 store 裁决，仅后台路径回退旧值）
    typedRpc('set_permission_mode', { mode }).catch((e) =>
      console.error('[mode-store] set_permission_mode 镜像失败（后台任务将按旧模式跑）:', e),
    );
    // 落盘 — settings.agent.permissionMode 作为下次启动的水合源
    try {
      const s = loadSettings();
      if (s.agent.permissionMode !== mode) {
        saveSettings({ ...s, agent: { ...s.agent, permissionMode: mode } });
      }
    } catch (e) {
      console.warn('[mode-store] permissionMode 落盘失败（重启将回上次落盘值）:', e);
    }
  },
  setPendingYolo: (pendingYolo) => useModeStore.setState({ pendingYolo }),
}));

/** boot 期水合：盘上 settings → store；并同步 Rust 镜像（应用启动时
 *  Rust 侧为缺省值，无论是否有落盘值都要推一次）。 */
export function hydratePermissionMode(): void {
  let mode: PermissionMode = 'ask';
  try {
    const stored = loadSettings().agent?.permissionMode;
    if (stored && PERMISSION_MODES.includes(stored)) mode = stored;
  } catch {
    // settings 读失败 — 保持 ask 缺省
  }
  useModeStore.setState({ permissionMode: mode });
  typedRpc('set_permission_mode', { mode }).catch(() => {
    // boot 期 Rust 可能未就绪 — 不视为错误（后续切换时会再镜像）
  });
}
