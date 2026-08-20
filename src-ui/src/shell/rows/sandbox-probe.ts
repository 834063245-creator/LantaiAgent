// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行 6（hologram/shell-sandbox-probe）：沙箱健康检查（启动期一次，
// 降级仅告警不阻断——权限引擎是唯一屏障的事实要可见）。
// 自 main.ts 576-584 机械迁移（fire-and-forget，boot 不 await 其完成）。

import { typedRpc } from '../../rpc-contract';

export function bootSandboxProbe(): void {
  typedRpc('sandbox_status', {})
    .then((raw) => {
      const s = JSON.parse(raw);
      if (s.degraded) {
        console.warn(`[sandbox] ⚠ DEGRADED: ${s.reason} — permission engine is the only barrier`);
      }
    })
    .catch((e) => console.warn('[sandbox] status check failed:', e));
}
