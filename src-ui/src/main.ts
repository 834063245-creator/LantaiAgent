// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 兰台（Lantai）主入口（S2-4 终态：薄引导）
// 引导职责只剩装配：CSS → cordis 内核 → React 壳 → bootShell（壳行表
// 化执行，见 composition/shell-rows.ts；行实现落 src/shell/rows/*）。
// 历史注：三模式星图 minimal/standard/full 独立实例切换重建（v3）；
// Workspace 抽象统一工作区状态（v4.1）；壳行化（S2，2026-08-20）；
// V5 拆除（2026-08-22）——星图 canvas/旧 chrome CSS 随观测台退役；
// 图谱全量退役（2026-09-09）——后台预热/Agent 图工具面一并移除。
//
// ⚡ 2026-10-29 事故立法：**启动失败必须能看见、能自救**。
//   事故形态（Agent 改自己的代码）：改宿主面 → 重建产物没重建 exe ⇒ 40 个产物
//   被指纹闸拒载 ⇒ 纸壳/首页/任务域缺席 ⇒ **纯白窗口 + 无日志 + 无提示**。
//   当时的三个哑面：auditBoot 只看已装载 fiber（产物被拒时全绿）、initLogger 要
//   等 Workspace.open（早于它的失败一条都不落盘）、<App/> 的 home 槽来自产物。
//   本文件现在负责：早初始化日志（best-effort）→ 引导 → 失败时渲染内核诊断面
//   （app/BootRecovery.tsx）→ 连续失败自动进安全模式。判定逻辑在
//   app/boot-recovery.ts（纯函数，测试可穷举）。

import './app/fonts';
import './app/tokens.css';
import './app/foundation.css';
import './app/shell.css';
import './app/panels/dock-panels/provider-settings.css';
import './app/plugin-windows/plugin-windows.css';
import './plugins/builtin/compose-dock/model-selector.css';
import './plugins/builtin/paper-shell/PaperPanel.css';
import './plugins/builtin/settings-domain/settings-panel.css';
import './plugins/builtin/paper-shell/status-line.css';
// KaTeX 排版 + 字体（科研数学渲染；renderer-service 用 katex.renderToString，
// CSS 集中在此导入——测试直接 import renderer-service 不碰 CSS 面）
import 'katex/dist/katex.min.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { initLogger, log } from './agent/logger';
import { BUILD } from './agent/obs';
import { App } from './app/App';
import { BootRecovery } from './app/BootRecovery';
import { diagnoseBoot, safeModeFailure, safeModeRequest } from './app/boot-recovery';
import { activeRootViews } from './composition/root-views-service';
import { initCordisKernel } from './cordis/boot';
import { auditBoot } from './plugins/boot-gate';
import { hostSurfaceFingerprint } from './plugins/builtin/host-modules';
import { loadBuiltinPlugins, loadExternalPlugins, pluginChannelOrigin } from './plugins/loader';
import { startProductWatch } from './plugins/product-watch';
import { registerUserMcpServerTools } from './plugins/user-mcp';
import { typedJsonRpc } from './rpc-contract';
import { bootShell } from './shell/boot';
import { usePluginStore } from './state/plugin-store';

// ── 全局错误钩子（错误不静默，2026-08-28 加固）──
// 此前装配/发送链路的未捕获异常只进 WebView console（用户打不开开发者工具），
// 排查完全不可见。这里把 unhandledrejection / uncaught error 落进 ui.log
//（[gbl] 标签，排查后清理）。
function logGlobalError(kind: string, reason: unknown): void {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error('main', `[gbl] ${kind}: ${err.message}`, { stack: err.stack });
}
window.addEventListener('unhandledrejection', (ev) => logGlobalError('unhandledrejection', ev.reason));
window.addEventListener('error', (ev) => logGlobalError('uncaught', ev.error ?? ev.message));

// ── 启动计数与安全模式（防砖）──
// 计数语义：每次引导 +1，**到达首帧就清零**。连续失败到阈值 ⇒ 下次启动跳过全部
// 产物装载，直接进诊断面——保证「产物把界面搞死」之后仍有一扇门能进、能修。
// 用 localStorage 而非新 RPC：这是纯前端决策，不该为它在 Rust 侧加契约。
const BOOT_ATTEMPTS_KEY = 'lantai.boot.attempts';
const SAFE_MODE_KEY = 'lantai.safeMode';

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 存储不可用（隐私模式/配额）不拦启动——安全模式退化，但引导照走
  }
}

const attempts = Number(readFlag(BOOT_ATTEMPTS_KEY) ?? '0') + 1;
writeFlag(BOOT_ATTEMPTS_KEY, String(attempts));
const safe = safeModeRequest(attempts, readFlag(SAFE_MODE_KEY) === '1');

// ── Cordis 内核引导（cordis-migration P0：根 Context 先于 React 壳与壳行）──
// ── 插件内核（WO-S0B）：第一方插件表装载（组合层四 service + 块渲染器 + 纸壳面板）──
const pluginKernelRoot = loadBuiltinPlugins(initCordisKernel());

// ── React 壳引导（纸壳唯一界面：SessionsHome / DockPanel / 命令面板）──
const appRoot = document.getElementById('app-root');
if (!appRoot) throw new Error('app-root 挂载点不存在——index.html 被破坏');
const reactRoot = createRoot(appRoot);
reactRoot.render(createElement(App));

/** 上一次 boot 用的工作区（诊断面要显示「日志写在哪」）。 */
let bootWorkspace: string | null = null;

/** 渲染内核诊断面（替换 <App/>）。这是「白屏」到「为什么」的唯一出口。 */
function showRecovery(failure: NonNullable<ReturnType<typeof diagnoseBoot>>): void {
  const logPath = bootWorkspace ? bootWorkspace + '/.lantai/logs/ui.log' : null;
  log.error('main', '[boot-recovery] ' + failure.summary, { kind: failure.kind, evidence: failure.evidence });
  reactRoot.render(
    createElement(BootRecovery, {
      failure,
      build: BUILD,
      hostSurface: hostSurfaceFingerprint(),
      workspace: bootWorkspace,
      logPath,
      safeMode: safe.forced,
      onToggleSafeMode: () => {
        // 退出安全模式：清计数 + 清旗标，然后整页重载（WebView 内重跑 main.ts =
        // 等价冷启动，且不需要新 RPC）。
        writeFlag(SAFE_MODE_KEY, safe.forced ? null : '1');
        writeFlag(BOOT_ATTEMPTS_KEY, '0');
        window.location.reload();
      },
    }),
  );
}

// ── 外部插件装载（WO-S0B）+ boot 审计（S4）+ 壳引导（S2）：产物装载先于
//    壳行执行——位移式内置插件（增补四）在纸面板直落前完成 bundle 行 →
//    产物行互换，首帧即终态（无面板闪卸重挂）。装载永不 reject（失败隔离，
//    通道失败退回 bundle 兜底行）；S4 起装载后经 boot 审计——全树 settle +
//    全 ACTIVE 才放行 bootShell（fail-loud：任一 FAILED / PENDING 超时 =
//    启动不进会话，错误可见）。flowDeps 缺省 = 出厂流。──
void (async () => {
  // ① 尽早把日志通道架起来（2026-10-29）：initLogger 原先只在 Workspace.open 里
  //    调，任何早于它的失败都**零落盘**（事故里连 boot-gate 那条都没写下来）。
  //    这里用已有 RPC 取上次工作区，best-effort——取不到就不 init，不拦启动。
  try {
    const lastDir = await typedJsonRpc('get_last_project', {});
    if (typeof lastDir === 'string' && lastDir.length > 0) {
      bootWorkspace = lastDir;
      await initLoggerSafe(lastDir);
    }
  } catch {
    // 无后端通道（浏览器 mock）/ RPC 未就绪：日志退回缓冲，诊断面照常
  }

  // ② 安全模式：跳过全部产物装载，直接出诊断面（防砖的最后一格台阶）
  if (safe.forced) {
    showRecovery(safeModeFailure(safe.reason ?? 'attempts', attempts));
    return;
  }

  try {
    // 用户级 MCP server（~/.lantai/mcp.json，skills-mcp-production-plan Commit 5b）：
    // 在外部插件装载前折算工具贡献（ctx.tools 通道 loadBuiltinPlugins 已就绪）。
    // 失败隔离——坏配置记日志不阻断启动。
    try {
      await registerUserMcpServerTools(pluginKernelRoot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('main', '[user-mcp] ~/.lantai/mcp.json 装载失败（跳过）: ' + msg);
    }
    await loadExternalPlugins(pluginKernelRoot);
    const audit = await auditBoot(pluginKernelRoot);
    if (!audit.ok) {
      // 不再裸 throw：交给诊断面（原实现抛进浮动 async IIFE ⇒ 只有一条日志，
      // 且日志通道可能还没起 ⇒ 用户看到的就是纯白）。
      throw new Error('[boot-gate] 插件装载失败:\n' + audit.failures.map((f) => '  - ' + f).join('\n'));
    }
    await bootShell();
    // ③ 首帧体检：壳引导「成功」不等于界面有东西——产物缺席时 <App/> 的 home
    //    槽是空的（auditBoot 看不见这一层，是事故的假绿来源）。
    const homeViews = activeRootViews('home').length;
    const failure = diagnoseBoot({
      error: null,
      records: usePluginStore.getState().plugins,
      homeViews,
    });
    if (failure) {
      showRecovery(failure);
      return;
    }
    // 到达首帧 ⇒ 计数清零（下次失败重新计数）
    writeFlag(BOOT_ATTEMPTS_KEY, '0');
    // ── 产物自动重载（landmine H1/H4 收口，2026-09-20）──
    // 构建脚本（watch:builtin-plugins）重建产物 + 镜像进 exe 资源根 + 更新
    // `_rev.json`；这里盯那一份修订表 ⇒ 改插件保存后秒级自动换新，不必再手工
    // 「构建 → 拷贝 → 点重新加载」三步（三步里前两步漏掉是静默的）。
    // 无产物通道（浏览器/mock）= 不启动；boot 审计之后才启动（不与首帧争）。
    const channelOrigin = pluginChannelOrigin();
    if (channelOrigin) startProductWatch({ origin: channelOrigin });
  } catch (e) {
    const failure = diagnoseBoot({
      error: e,
      records: usePluginStore.getState().plugins,
      homeViews: activeRootViews('home').length,
    });
    showRecovery(
      failure ?? {
        kind: 'shell',
        summary: '启动链抛错（未能归类）',
        evidence: [e instanceof Error ? e.message : String(e)],
        hints: ['改过前端代码 ⇒ npm --prefix src-ui run build 后重建 exe（build.cmd）'],
      },
    );
  }
})();

/** initLogger 不抛（日志通道起不来不许拦住引导）。 */
async function initLoggerSafe(dir: string): Promise<void> {
  try {
    await initLogger(dir);
  } catch {
    // 见上：日志是诊断副产物，不是启动前置条件
  }
}
