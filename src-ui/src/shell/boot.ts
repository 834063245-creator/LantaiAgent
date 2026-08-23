// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳引导编排器（S2-3）— main.ts init() 的行表化执行。
//
// 职责（设计件 §2.6）：
//   1. 引导三件套就地执行（右键抑制 / 语言 / 字号——原 init 418-422）；
//   2. 组合链（S2-2 用户层 patch + S4-1a preset：选择同步 → 装载 → 发现 →
//      preset 层应用——全部先于一切装配，保证第一个 Agent 就拿到最终组合）；
//   3. 按 resolved.shell 表序逐行 await boot（保序 = 现 init 的 await 语义）；
//   4. 主视图落点：启动落点恒为案卷首页（2026-08-22 用户拍板——不再
//      固定直落纸面板；纸面板由用户动作唤起）；
//   5. 失败隔离：单行抛错 console.error + 继续（loader 同款纪律）。
//
// 行序即执行序——表序是字节契约（§2.6 表 = 现 init() 执行序的证据）。
// workspace 流 deps（actions 行消费）由调用方注入：S2-3 阶段是 main.ts 侧
// 函数（零漂移过渡），S2-4 起是 shell/workspace.ts 真源。

import { loadCompositionPatch, reloadCompositionPatch } from '../composition/patch-loader';
import {
  applyDefaultPreset,
  reapplyComposition,
  syncPresetSelectionFromSettings,
} from '../composition/preset-assembly';
import { discoverPresets } from '../composition/preset-discovery';
import { onPromptContributionsChanged } from '../composition/prompt-service';
import type { ResolvedComposition } from '../composition/roster';
import { onToolContributionsChanged } from '../composition/services';
import { type ShellRow, type WorkspaceFlowDeps, workspaceFlow } from '../composition/shell-rows';
import { setLang } from '../i18n';
import { typedListen } from '../rpc-contract';
import { loadSettings } from '../settings';
import { useCompositionStore } from '../state/composition-store';
import { shellRefs } from './runtime';

/** 启动期一次装载用户层 patch（幂等：composition-store 持结果）。 */
let compositionLoading: Promise<void> | null = null;
function ensureCompositionLoaded(): Promise<void> {
  compositionLoading ??= loadCompositionPatch();
  return compositionLoading;
}

/** 启动期一次 preset 发现（幂等；内置表 + 用户目录合并进 preset-store）。 */
let presetDiscovery: Promise<void> | null = null;
function ensurePresetsDiscovered(): Promise<void> {
  presetDiscovery ??= discoverPresets();
  return presetDiscovery;
}

/** 组合层热重载监听（S4-2）：Rust watcher emit composition:changed →
 *  patch-loader reload → composition-store 更新（新 Agent 装配即用新组合；
 *  在途会话不动）。监听器生命周期 = 应用生命周期（boot 期一次登记）。 */
let compositionWatchArmed = false;
function armCompositionWatcher(): void {
  if (compositionWatchArmed) return;
  compositionWatchArmed = true;
  void typedListen('composition:changed', () => {
    void reloadCompositionPatch();
  });
}

/** 贡献变更监听（S4-4 甲）：插件工具行/prompt 段贡献 register/dispose →
 *  reapplyComposition——组合解析域含通道贡献快照，贡献变更后按当前选择
 *  重解析并回写 composition-store（共享注册表/诊断面读它；error 态跳过、
 *  factory 态重新快照）。监听器生命周期 = 应用生命周期（boot 期一次登记，
 *  与 composition watcher 同款）。 */
let contributionsWatchArmed = false;
function armContributionsWatcher(): void {
  if (contributionsWatchArmed) return;
  contributionsWatchArmed = true;
  onToolContributionsChanged(reapplyComposition);
  onPromptContributionsChanged(reapplyComposition);
}

/** 壳引导主入口 — main.ts 调用（fire-and-forget；永不 reject）。
 *  flowDeps 缺省 = 出厂 workspace 流（workspace 行真源）。 */
export async function bootShell(
  flowDeps: WorkspaceFlowDeps = workspaceFlow,
  composition?: ResolvedComposition,
): Promise<void> {
  try {
    // 1) 引导三件套（原 init() 首段——先于一切 UI 行）
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    setLang(loadSettings().display.language);
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));

    // 2) 组合链（S4-1a + S4-2 + S4-4 甲）：settings 的 preset 选择同步 →
    //    用户层 patch → preset 发现（用户目录）→ preset 层应用（写
    //    composition-store）→ 热重载监听武装（composition:changed →
    //    reload；Rust watcher 在壳进程常驻）→ 贡献变更监听武装（插件
    //    行/段 register/dispose → reapplyComposition——第一方贡献在
    //    loadBuiltinPlugins 已注册完毕，此监听主要服务外部插件晚装载）。
    syncPresetSelectionFromSettings();
    await ensureCompositionLoaded();
    await ensurePresetsDiscovered();
    applyDefaultPreset();
    armCompositionWatcher();
    armContributionsWatcher();

    // 3) 按表序逐行 boot（V5a 组合接线，workspace-flip 批 4）：行表真源 =
    //    composition-store.resolved.shell（第 2 步组合链刚写入——参数注入有
    //    时序悖论：参数在调用时求值，组合链在函数体内才跑完）；第二参保留为
    //    测试注入面（生产一律走 store；factory 态 = 出厂表全等）。
    const resolved = useCompositionStore.getState().resolved;
    const rows: ShellRow[] = composition?.shell ?? resolved.shell;
    for (const row of rows) {
      try {
        await row.boot(shellRefs, flowDeps);
      } catch (err) {
        // 失败隔离：单行失败不炸引导（行内代码不假设前行必然成功）
        console.error('[shell] 壳行 boot 失败:', row.id, err);
      }
    }

    // 4) 主视图落点（2026-08-22 用户拍板）：启动落点恒为案卷首页——
    //    不再固定为最后一卷/新卷。纸面板由用户动作唤起（新建/续开/换卷）；
    //    「关卷」回首页的既有语义不变（纸面板 unmountOnClose）。
  } catch (err) {
    // 编排器级失败（引导三件套/patch await——理论不可达，防御性兜底）
    console.error('[shell] 壳引导失败:', err);
  }
}
