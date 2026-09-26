// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// update-store — 应用更新检测的单一事实源（app 级单例，dock-store 同族）。
// 两个写入源共享一份状态面：
//   - 壳行 shell-update-check（启动延迟自动检查，见 shell/rows/update-check.ts）；
//   - 设置面板「关于」tab 的手动「检查更新 / 下载并安装」（SettingsPanel 消费，
//     不再自持 useState——自动检查发现的新版本，打开面板即见）。
// 角标消费面：SessionsHome / PaperPanel 的设置入口按 status === 'available'
// && !badgeDismissed 显示朱砂点；打开设置面板（用户已看见）即熄，换新版本重新亮起。
//
// 模块级可变态归属（CONVENTIONS §1.10）：zustand create 实例 = app 级单例
// （第 3 类「进程级单例」），生命周期 = 应用生命周期，无跨工作区串扰面。

import { create } from 'zustand';

export type UpdateStatus =
  | 'idle' // 未检查（启动早期 / 检查失败后重置）
  | 'checking' // 检查中
  | 'available' // 有新版本（角标 + 面板显示下载按钮）
  | 'downloading' // 下载安装中
  | 'done' // 完结（已是最新 / 下载完成）
  | 'error'; // 失败（面板可见 + 重试按钮；角标不亮）

interface UpdateState {
  status: UpdateStatus;
  /** 可用新版本号（status === 'available' 时非空；角标 tooltip 消费） */
  version: string | null;
  /** 状态文案（新版本提示 / 已是最新 / 失败原因 / 下载进度） */
  message: string;
  /** 用户是否已看过本次角标（打开设置面板即置 true；换版本号重新亮起） */
  badgeDismissed: boolean;

  /** 检查更新（manual=true 为设置面板手动路径）。全路径内部 catch——
   *  自动检查失败静默留痕（console.warn + error 态），不打扰用户。 */
  checkForUpdates: (opts?: { manual?: boolean }) => Promise<void>;
  /** 下载并安装（面板交互；完成后提示重启生效，不自动 relaunch）。 */
  downloadAndInstall: () => Promise<void>;
  /** 用户已看过角标（SettingsPanel mount 时调用）——角标熄灭。 */
  markBadgeSeen: () => void;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message || String(e) : String(e);
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  version: null,
  message: '',
  badgeDismissed: false,

  checkForUpdates: async (opts) => {
    const manual = opts?.manual ?? false;
    set({ status: 'checking', message: '' });
    try {
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const update = await checkUpdate();
      if (update) {
        const prev = get();
        // 同版本号重查且用户已看过 → 角标保持熄灭；新版本号 → 重新亮起
        const dismissed = update.version === prev.version ? prev.badgeDismissed : false;
        set({
          status: 'available',
          version: update.version,
          message: `新版本 ${update.version} 可用`,
          badgeDismissed: dismissed,
        });
      } else {
        set({ status: 'done', version: null, message: '已是最新版本' });
      }
    } catch (e) {
      const msg = errText(e);
      // 自动检查是 best-effort：失败只留痕（console + error 态供面板展示），不弹提示
      if (!manual) console.warn('[update] 启动自动检查失败:', msg);
      set({ status: 'error', message: msg });
    }
  },

  downloadAndInstall: async () => {
    set({ status: 'downloading', message: '下载中…' });
    try {
      // 安装前重查一次（与既有手动路径同款语义：拿到当前可用的 Update 句柄，
      // 避免陈旧的 Update 对象指向已被覆盖的发布产物）
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const update = await checkUpdate();
      if (!update) {
        set({ status: 'error', message: '更新信息已过期' });
        return;
      }
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Finished') set({ message: '下载完成，重启生效' });
      });
      set({ status: 'done', message: '下载完成，下次启动生效' });
    } catch (e) {
      set({ status: 'error', message: errText(e) });
    }
  },

  markBadgeSeen: () => {
    if (get().status === 'available') set({ badgeDismissed: true });
  },
}));
