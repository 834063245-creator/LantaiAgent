// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugins/bundled-engine-prefs — 随包图谱引擎的**探测面与开关面**（批 10 部件三，2026-09-26）。
//
// 为什么这两件留内核（而接线随 `plugins/builtin/bundled-engine/`）：
//   - **探测** = 平台只读面（`engine_bundled_info` RPC + 进程级缓存），设置页开关读它；
//   - **开关** = 平台偏好（localStorage `lantai.bundledEngine.enabled`），设置面板（另一产物
//     `settings-domain`）经 faceDeps 取用——若随包，设置页就要跨产物取用（本仓无此通道）。
// 真正属于「产品装配」的是**接线**（声明构造 + MCP 受治进程拉起 + 激活登记），它已随
// `plugins/builtin/bundled-engine/`，并在工作区激活点经 `ctx.workspaces` 贡献（批 10 部件一）。
//
// 本文件语义与 2026-09-24 实机修复后的版本**逐字一致**（探测双形态兼容 + 失败留痕不静默）。

import { log } from '../agent/logger';
import { typedJsonRpc } from '../rpc-contract';

/** 随包引擎探测结果（`engine_bundled_info` RPC 的形状）。 */
export interface BundledEngineInfo {
  /** 引擎 exe 绝对路径；null = 未找到（降级，非错误）。 */
  path: string | null;
  /** 安装目录（stdio command/args 相对解析锚点）；null = 同上。 */
  dir: string | null;
  /** 二进制是否就位。 */
  available: boolean;
}

/** 探测缓存（模块级可变态归属 CONVENTIONS §1.10 第 3 类：键控自清理——
 *  单键、生命周期 = 进程；安装目录在运行期不变，缓存安全）。
 *  测试经 `resetBundledEngineForTests` 复位。 */
let cachedInfo: BundledEngineInfo | null = null;

/** 探测随包引擎（惰性 + 缓存）。RPC 失败 → 返回不可用（非抛错——随包引擎
 *  缺席不该炸任何启动路径，错误经 available=false 可见）。 */
export async function probeBundledEngine(): Promise<BundledEngineInfo> {
  if (cachedInfo) return cachedInfo;
  try {
    // typedJsonRpc（2026-09-24 换轨）：本命令是 `// JSON` 形态，双形态兼容
    // （Rust 出口已展开为 Value / 表外仍为 JSON 字符串——**两者都要吃**），
    // 且违形即 throw 而非静默读成 false。旧实现用 typedRpc（直通、不 parse）
    // ⇒ 出口按 Text 直通字符串时 `raw?.available` 恒 undefined ⇒ 设置页开关
    // 置灰「拨不开」（实机缺陷；回归 tests/bundled-engine-probe-shape.test.ts）。
    const raw = await typedJsonRpc('engine_bundled_info');
    const info: BundledEngineInfo = {
      path: typeof raw?.path === 'string' ? raw.path : null,
      dir: typeof raw?.dir === 'string' ? raw.dir : null,
      available: raw?.available === true,
    };
    cachedInfo = info;
    return info;
  } catch (e) {
    // 探测失败 = 引擎不可用（不缓存失败结果——代理未起等瞬态可重试）。
    // 但**不静默**：此前 catch 无输出，UI 只会说「未检测到引擎二进制」，
    // 把「RPC/形状故障」误报成「二进制缺席」——留一行 warn 进 ui.log 可查。
    log.warn('plugins', `[bundled-engine] 探测失败（按不可用降级）: ${e instanceof Error ? e.message : String(e)}`);
    return { path: null, dir: null, available: false };
  }
}

/** 测试/诊断复位（生产不消费）。 */
export function resetBundledEngineForTests(): void {
  cachedInfo = null;
}

// ═══════════════════════════════════════════════════════
// 启用开关（方案乙：默认关，localStorage 持久化）
// ═══════════════════════════════════════════════════════

/** localStorage 键（与 `state/plugin-prefs.ts` 同族约定：`lantai.` 前缀）。 */
const PREF_KEY = 'lantai.bundledEngine.enabled';

/** 开关变更订阅者（设置面板即时反馈 + 启动重载提示）。 */
const listeners = new Set<() => void>();

/** 随包引擎是否启用（**默认 false**——方案乙；不改写则零行为变更）。 */
export function isBundledEngineEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'true';
  } catch {
    // 无 localStorage（SSR/测试环境）→ 缺省关（安全向）
    return false;
  }
}

/** 设置启用态（写 localStorage + 通知订阅者）。生效时机：**下次启动 / 下次
 *  打开工作区**（工具行注册在 boot 后的工作区激活点，不热改已装配的 Agent）。
 */
export function setBundledEngineEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, enabled ? 'true' : 'false');
  } catch {
    // 写失败不炸（隐私模式等）——内存态仍生效于本会话
  }
  for (const l of listeners) l();
}

/** 订阅开关变更（返回退订器）。 */
export function onBundledEnginePrefChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
