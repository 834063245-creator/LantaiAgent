// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 产物自动重载（landmine H1/H4 收口，2026-09-20）——「改插件 = 秒级生效」的最后一环。
//
// 链路事实（缺任何一环都表现为「热重载没生效」，且前两环是**静默**的）：
//   ① 源码 → 产物：`npm run watch:builtin-plugins`（或 build:builtin-plugins）
//      重建 `src-ui/dist-plugins/`；
//   ② 产物 → exe 侧资源根：同一脚本逐文件 SHA256 镜像进 `target/<profile>/_up_/…`
//      （H1：运行中的 exe 只认资源根，漏了这步 = 重载旧文件，无报错）；
//   ③ 资源根 → 运行中的插件：**本模块**。构建脚本在产物根写 `_rev.json`
//      （每个产物目录一份内容指纹），应用只需盯这一份小文件：变了就重载对应插件。
//      （H4：入口 URL 带恒新版本号后才真正取到新模块——见 loader.withArtifactVersion。）
//
// 纪律：
//   - 只在有产物通道时启动（`pluginChannelOrigin()` 为 null = 浏览器/mock，不启动）；
//   - `_rev.json` 缺失/坏形状 = 无信号源（旧产物包 / 第三方部署）：连缺 N 次即停
//     轮询并留一条日志（退化，不刷屏、不误报）；
//   - 窗口隐藏时不轮询（不做后台空转）；
//   - 用户禁用的 feature 插件不自动重载（plugin-prefs 是唯一权威，与 boot 装载同一条判据）；
//   - 只重载变更的产物（不做全量重装）；单个失败记状态栏提示并继续下一轮。
//
// ── H6（2026-09-21 实机取证）：**基线之后的静默死亡** ─────────────────────
// 症状：一整个下午改了四批产物，应用里「什么都没变」；ui.log 里 product-watch
// 只有一行（12:33:48，当天唯一一次重载），之后既无重载也无任何报错。
// 两条静默路（都在本文件内）：
//   ① `readRev()` 返回 null（通道读不到/坏形状）——旧代码只在 `baseline == null` 时
//      计数与停轮询 ⇒ **基线一经建立，后续 N 次失败既不报也不停**，纯哑掉；
//   ② `inFlight` 一旦被一个**不 settle 的 await**（activateExternalPlugin 卡住）
//      永久占住 ⇒ 之后每次 pollOnce 首行就 return，同样一声不响。
// 治法（本批）：失败**可见化**——连缺到阈值即 warn（不刷屏），再往上推一条状态栏；
// `inFlight` 加看门狗（超时释放 + warn）。判据：产物通道断了要能在界面上看见，
// 而不是让用户对着旧界面猜「为什么没生效」。

import { log } from '../agent/logger';
import { useShellStore } from '../app/shell-store';
import { usePluginPrefs } from '../state/plugin-prefs';
import { activateExternalPlugin, deactivateExternalPlugin, isSourceDomainProduct } from './loader';

/** 轮询周期：读的是一份 ~1KB 的本地修订表（`no-store`，进程内 loopback，无外部开销）。
 *  1s ⇒ 实机实测「保存 → 界面生效」端到端 **1.35s**（2026-09-20，真机 CDP 探针：
 *  savedAt 06:58:13.696Z → detectedAt 06:58:15.046Z，canvas-nav 加一条 CSS 规则）。
 *  2s 档实测同口径 ~7s（其中大部分是 watch 侧旧去抖饥饿，两端都已收紧）。 */
export const PRODUCT_WATCH_INTERVAL_MS = 1000;
/** 连续读不到修订表的次数上限（超了停轮询——无信号源环境不空转）。 */
const MAX_MISSES = 5;
/** H6：**基线之后**连缺到这个数就 warn（1s 周期 ⇒ 约 15s 断流），此后每 MISS_WARN_EVERY 次再报一次。 */
const MISS_WARN_AFTER = 15;
const MISS_WARN_EVERY = 300;
/** H6：单次轮询的在途上限——超时释放 `inFlight`（不让一个不 settle 的 await 把整条通道哑掉）。 */
const INFLIGHT_TIMEOUT_MS = 30_000;
/** H6：状态栏提示只在跨过这个次数时报一次（不刷屏）。 */
const MISS_STATUS_AFTER = 60;

/** 修订表（`<origin>/_rev.json`）：插件名（= dirId）→ 内容指纹。 */
export type ProductRev = Record<string, string>;

export interface ProductWatchOptions {
  /** 产物通道 origin（`pluginChannelOrigin()`）。 */
  origin: string;
  /** fetch 注入面（测试用；缺省全局 fetch）。 */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  intervalMs?: number;
}

export interface ProductWatch {
  /** 停止轮询（幂等）。 */
  stop(): void;
  /** 立即轮询一次（测试面/手动触发）；返回本次重载（含 `-名字` = 停用）的插件名。 */
  pollOnce(): Promise<string[]>;
}

/** 修订表形状守卫（坏形状 = 无信号源，不是空表——空表会被读成「所有产物都被删」）。 */
export function parseProductRev(raw: unknown): ProductRev | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: ProductRev = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/** 启动产物自动重载（main.ts 在 bootShell 之后调用；有产物通道才启动）。 */
export function startProductWatch(opts: ProductWatchOptions): ProductWatch {
  const fetchImpl = opts.fetchImpl ?? ((url: string) => fetch(url));
  const url = opts.origin + '/_rev.json';
  const intervalMs = opts.intervalMs ?? PRODUCT_WATCH_INTERVAL_MS;
  let baseline: ProductRev | null = null;
  let misses = 0;
  let stopped = false;
  let inFlight = false;
  let inFlightSince = 0;
  let missStatusPushed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer != null) clearInterval(timer);
    timer = null;
  }

  async function readRev(): Promise<ProductRev | null> {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return null;
      return parseProductRev(await res.json());
    } catch {
      return null;
    }
  }

  async function pollOnce(): Promise<string[]> {
    if (stopped) return [];
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return [];
    // H6②：在途看门狗——一个不 settle 的 await 不许把整条通道永久占住
    if (inFlight) {
      if (Date.now() - inFlightSince < INFLIGHT_TIMEOUT_MS) return [];
      log.warn(
        'plugins',
        `[product-watch] 上一次轮询在途超过 ${Math.round(INFLIGHT_TIMEOUT_MS / 1000)}s——强制释放（产物通道可能已卡住）`,
      );
    }
    inFlight = true;
    inFlightSince = Date.now();
    try {
      const rev = await readRev();
      if (rev == null) {
        misses++;
        if (baseline == null && misses >= MAX_MISSES) {
          log.warn('plugins', `[product-watch] 连续 ${misses} 次读不到 ${url}——产物无修订表，自动重载停用`);
          stop();
          return [];
        }
        // H6①：基线之后的失败必须**可见**（旧代码在这里完全静默 ⇒ 一下午的产物变更全丢）
        if (
          baseline != null &&
          misses >= MISS_WARN_AFTER &&
          (misses === MISS_WARN_AFTER || misses % MISS_WARN_EVERY === 0)
        ) {
          log.warn('plugins', `[product-watch] 连续 ${misses} 次读不到 ${url}——自动重载可能已失效（改产物请重启应用）`);
        }
        if (baseline != null && misses >= MISS_STATUS_AFTER && !missStatusPushed) {
          missStatusPushed = true;
          useShellStore.getState().pushStatus('产物通道读不到修订表——自动重载已失效，改产物请重启应用');
        }
        return [];
      }
      misses = 0;
      missStatusPushed = false;
      // 首轮 = 基线（boot 期装载的就是它，无须重载）
      if (baseline == null) {
        baseline = rev;
        return [];
      }
      const changed = Object.keys(rev).filter((n) => baseline?.[n] !== rev[n]);
      const removed = Object.keys(baseline).filter((n) => !(n in rev));
      baseline = rev;
      const touched: string[] = [];
      for (const name of changed) {
        // dev 源码域装载的出厂产物：产物通道重载会撞贡献 id（见 loader.isSourceDomainProduct）
        if (isSourceDomainProduct(name)) continue;
        if (usePluginPrefs.getState().isDisabled(name)) continue; // 用户禁用 = 唯一权威
        const record = await activateExternalPlugin(name);
        if (record.status === 'active') touched.push(name);
        else log.warn('plugins', `[product-watch] ${name} 自动重载未生效：${record.error ?? record.status}`);
      }
      for (const name of removed) {
        if (await deactivateExternalPlugin(name)) touched.push('-' + name);
      }
      if (touched.length > 0) {
        const text = '插件产物已更新，自动重载：' + touched.join('、');
        log.info('plugins', '[product-watch] ' + text);
        useShellStore.getState().pushStatus(text);
      }
      return touched;
    } finally {
      inFlight = false;
    }
  }

  timer = setInterval(() => void pollOnce(), intervalMs);
  return { stop, pollOnce };
}
