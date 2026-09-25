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
//   5. 失败隔离：单行抛错 log.error（console + ui.log）+ 继续（loader 同款纪律）。
//
// 行序即执行序——表序是字节契约（§2.6 表 = 现 init() 执行序的证据）。
// workspace 流 deps（actions 行消费）由调用方注入：S2-3 阶段是 main.ts 侧
// 函数（零漂移过渡），S2-4 起是 shell/workspace.ts 真源。

import { log } from '../agent/logger';
import { onCapabilityContributionsChanged } from '../composition/capability-service';
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
// §4-9（批 10 同窗）：壳行贡献通道——产物登记的行追加在内置行之后（注册序）
import { activeShellRows } from '../composition/shell-rows-service';
import { setLang } from '../i18n';
import { armProvidersWatcher, bootstrapProvidersDoc, ensureProvidersDir } from '../provider/providers-store';
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

/** 贡献变更监听（S4-4 甲 + A-3）：插件工具行/prompt 段/capability 贡献
 *  register/dispose → reapplyComposition——组合解析域含通道贡献快照，贡献
 *  变更后按当前选择重解析并回写 composition-store（共享注册表/诊断面读它；
 *  error 态跳过、factory 态重新快照）。监听器生命周期 = 应用生命周期
 *  （boot 期一次登记，与 composition watcher 同款）。 */
let contributionsWatchArmed = false;
function armContributionsWatcher(): void {
  if (contributionsWatchArmed) return;
  contributionsWatchArmed = true;
  onToolContributionsChanged(reapplyComposition);
  onPromptContributionsChanged(reapplyComposition);
  onCapabilityContributionsChanged(reapplyComposition);
}

/** 壳引导主入口 — main.ts 调用（fire-and-forget；永不 reject）。
 *  flowDeps 缺省 = 出厂 workspace 流（workspace 行真源）。 */
export async function bootShell(
  flowDeps: WorkspaceFlowDeps = workspaceFlow,
  composition?: ResolvedComposition,
): Promise<void> {
  try {
    // 0) provider 配置文件（2026-09-24 配方改文件批）——**必须是第一句**：
    //    provider 的权威在 `~/.lantai/providers.yml`，`loadSettings()` 在读取
    //    边界按投影合成完整行，而投影要等文件装载完才成立。此处还承担一次性
    //    存量迁移（磁盘上没有配置内容 ⇒ 把旧 localStorage 存档写成文件）。
    //    失败不阻断引导：投影缺席 = 回落旧语义（按 localStorage 走），
    //    原因在设置页「提供方」页可见。
    try {
      await bootstrapProvidersDoc();
      await ensureProvidersDir();
    } catch (e) {
      log.error('shell', 'provider 配置文件装载失败（回落本机存储语义）', { error: String(e) });
    }
    armProvidersWatcher();

    // 1) 引导三件套（原 init() 首段——先于一切 UI 行）
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    setLang(loadSettings().display.language);
    document.documentElement.style.setProperty('--font-scale', String(loadSettings().display.fontScale));

    // 2) 组合链（S4-1a + S4-2 + S4-4 甲 + A-3）：settings 的 preset 选择
    //    同步 → 用户层 patch → preset 发现（用户目录）→ preset 层应用（写
    //    composition-store）→ 热重载监听武装（composition:changed →
    //    reload；Rust watcher 在壳进程常驻）→ 贡献变更监听武装（插件
    //    行/段/capability 贡献 register/dispose → reapplyComposition
    //    ——第一方贡献在 loadBuiltinPlugins 已注册完毕，此监听主要服务
    //    外部插件晚装载）。
    syncPresetSelectionFromSettings();
    await ensureCompositionLoaded();
    await ensurePresetsDiscovered();
    applyDefaultPreset();
    armCompositionWatcher();
    armContributionsWatcher();
    // ①b boot 序洞修复（2026-08-24 工作区归属根治）：composition-store 的
    // 初始 resolved 是模块加载期快照（静态 import 阶段，彼时 loadBuiltinPlugins
    // 尚未执行、tools 通道为空——tools 域快照 = 空表）。第一方工具贡献在
    // main.ts 引导体注册，早于上方 armContributionsWatcher 武装——注册事件
    // 不会倒放，且「无用户 patch（404 不动 store）+ standard preset（空 patch
    // 跳过）」路径下 store 无人刷新 → setupAgent 的 buildToolRegistry 拿到
    // 空行表 → alias('read_file','read_file_content') 抛「unknown tool」
    // ——Agent 装配整链失败（此前静默，2026-08-24 Phase D 起可见）。
    // 修复：贡献监听武装后无条件重应用一次——factory 态重快照 / ok 态重解析
    // / error 态保持可见（reapplyComposition 的既有语义），后续外部插件
    // 装载仍经监听器增量重应用。
    reapplyComposition();

    // 3) 按表序逐行 boot（V5a 组合接线，workspace-flip 批 4）：行表真源 =
    //    composition-store.resolved.shell（第 2 步组合链刚写入——参数注入有
    //    时序悖论：参数在调用时求值，组合链在函数体内才跑完）；第二参保留为
    //    测试注入面（生产一律走 store；factory 态 = 出厂表全等）。
    const resolved = useCompositionStore.getState().resolved;
    const rows: ShellRow[] = composition?.shell ?? resolved.shell;
    // §4-9（批 10 同窗）：贡献行**追加在内置行之后**（注册序）——`shell-update-check`
    // 恰是今日最后一行，故该语义逐位复现引导序（零行为漂移）。无 `ctx.shellRows`
    // 的环境（工具/单测）= 空集。逐行 patch 寻址是后续精化（见该 service 头注）。
    const contributed: ShellRow[] = activeShellRows().map((r) => ({ id: r.id, boot: r.boot }));
    for (const row of [...rows, ...contributed]) {
      try {
        await row.boot(shellRefs, flowDeps);
      } catch (err) {
        // 失败隔离：单行失败不炸引导（行内代码不假设前行必然成功）
        log.error('shell', '壳行 boot 失败: ' + row.id, { error: String(err) });
      }
    }

    // 4) 主视图落点（2026-08-22 用户拍板）：启动落点恒为案卷首页——
    //    不再固定为最后一卷/新卷。纸面板由用户动作唤起（新建/续开/换卷）；
    //    「关卷」回首页的既有语义不变（纸面板 unmountOnClose）。
  } catch (err) {
    // 编排器级失败（引导三件套/patch await——理论不可达，防御性兜底）。
    // ⚡ F1（2026-09-15 审计）：此前只 console.error——WebView 用户看不到，
    // 而这里中断的后果是**第 3 步壳行全不 boot（空壳）**。经 log（ui.log）
    // 落盘：boot 期 logPath 尚未 init（首个工作区打开时）→ 条目先入缓冲，
    // initLogger 后的 flush 把它写进 .lantai/logs/ui.log。
    log.error('shell', '壳引导失败（后续壳行未 boot）', { error: String(err) });
  }
}
