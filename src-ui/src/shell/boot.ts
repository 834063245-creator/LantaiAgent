// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳引导编排器（S2-3）— main.ts init() 的行表化执行。
//
// 职责（设计件 §2.6）：
//   1. 引导三件套就地执行（右键抑制 / 语言 / 字号——原 init 418-422）；
//   2. await compositionReady（S2-2 用户层 patch 先于一切装配）；
//   3. 按 resolved.shell 表序逐行 await boot（保序 = 现 init 的 await 语义）；
//   4. 失败隔离：单行抛错 console.error + 继续（loader 同款纪律）。
//
// 行序即执行序——表序是字节契约（§2.6 表 = 现 init() 执行序的证据）。
// workspace 流 deps（行 10 消费）由调用方注入：S2-3 阶段是 main.ts 侧
// 函数（零漂移过渡），S2-4 起是 shell/workspace.ts 真源。

import { useShellStore } from '../app/shell-store';
import { loadCompositionPatch } from '../composition/patch-loader';
import type { ResolvedComposition } from '../composition/roster';
import { builtinShellRows, type ShellRow, type WorkspaceFlowDeps } from '../composition/shell-rows';
import { setLang } from '../i18n';
import { loadSettings } from '../settings';
import { shellRefs } from './runtime';

/** 启动期一次装载用户层 patch（幂等：composition-store 持结果）。 */
let compositionLoading: Promise<void> | null = null;
function ensureCompositionLoaded(): Promise<void> {
  compositionLoading ??= loadCompositionPatch();
  return compositionLoading;
}

/** 壳引导主入口 — main.ts 调用（fire-and-forget；永不 reject）。 */
export async function bootShell(flowDeps: WorkspaceFlowDeps, composition?: ResolvedComposition): Promise<void> {
  try {
    // 1) 引导三件套（原 init() 首段——先于一切 UI 行）
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    setLang(loadSettings().display.language);
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));
    shellRefs.starGraph?.resize(); // CSS 自定义属性变化 → 容器缩小 → canvas 必须跟随

    // 2) 用户层组合 patch（S2-2：先于冷启动装配；永不 reject）
    await ensureCompositionLoaded();

    // 3) 按表序逐行 boot（resolved.shell 组合后行表；缺省 = 出厂表）
    const rows: ShellRow[] = composition?.shell ?? builtinShellRows();
    for (const row of rows) {
      try {
        await row.boot(shellRefs, flowDeps);
      } catch (err) {
        // 失败隔离：单行失败不炸引导（行内代码不假设前行必然成功）
        console.error('[shell] 壳行 boot 失败:', row.id, err);
      }
    }
  } catch (err) {
    // 编排器级失败（引导三件套/patch await——理论不可达，防御性兜底）
    console.error('[shell] 壳引导失败:', err);
    useShellStore.getState().setView('welcome');
  }
}
