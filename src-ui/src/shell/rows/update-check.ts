// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 壳行（hologram/shell-update-check）：启动期自动检查应用更新。
// 结果写 update-store（单一事实源）：发现新版本 → 设置入口朱砂角标
// （SessionsHome / PaperPanel），打开设置面板即见；失败静默留痕。
//
// sandbox-probe 同款纪律：fire-and-forget，boot 只设延迟定时器立即返回
// （不阻塞引导序——cold-start 的引擎预热/会话恢复优先）。延迟 8s 让位
// 冷启动网络高峰。定时器归属（CONVENTIONS §1.10 第 3 类）：一次性
// 进程级延迟任务，生命周期 = 应用生命周期，无需 fiber 登记。
//
// 开关：settings.updates.autoCheck（缺省开，autoUpdateCheckEnabled 容错读取）；
// 关闭/行禁用涟漪 = 不自动检查（设置面板手动检查不受影响）。

import { autoUpdateCheckEnabled, loadSettings } from '../../settings';
import { useUpdateStore } from '../../state/update-store';

export function bootUpdateCheck(): void {
  if (!autoUpdateCheckEnabled(loadSettings())) return;
  window.setTimeout(() => {
    void useUpdateStore.getState().checkForUpdates();
  }, 8000);
}
