// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话上下文注册表（tool-ergonomics design-1 rev2）——per-owner 的工具层便利上下文。
//
// 职责分界（2026-08-30 用户质询插件化纪律后的重裁）：Rust 漏斗是强制层（沙箱/权限/
// worktree 映射照旧校验最终路径），本模块是便利层——为域工具的参数预处理腰提供
// 「这个 agent 的工作区根/焦点」。解析只做 join、不做规范化（`..` 原样保留，
// 由 Rust 沙箱拒绝——腰不得洗白穿越序列）。
//
// 生命周期：Agent 装配期注册（agent.ts 构造器 ctx.effect 挂，projectPath 来自
// AgentContext——child() 派生自动继承），拆卸 = ctx.dispose 逆序释放 = 注册表删行。
// 键 = owner id（bus id，与 executor 注入的 _owner_id 同源）——双工作区并行天然隔离
// （不做全局单根）；UI 直调 typedRpc 不经域工具包装，结构性不消费本表。
//
// 模块级可变态归类：CONVENTIONS §1.10 第 3 类（activeFsProviders 同款先例）。

import type { ShellPollState } from './shell-poll-guard';

/** desktop 粘性窗口定位器（字段缺省 = 未指定；fill 时逐字段补齐）。 */
export interface WindowLocator {
  hwnd?: number;
  pid?: number;
  title?: string;
}

/** 一个 owner（agent）的工具层上下文。 */
export interface OwnerContext {
  /** 工作区根（逻辑绝对路径，AgentContext.projectPath 同源）。 */
  workspaceRoot: string;
  /** fs 焦点文件——最近一次 fs(read/edit/write) 成功的文件（逻辑绝对路径）。 */
  focusPath?: string;
  /** desktop 焦点窗口——最近一次显式定位 / uia_activate 成功的窗口。 */
  focusWindow?: WindowLocator;
  /** shell 粘性 cwd——最近一次 fg 命令的落点目录（物理绝对路径，marker 捕获）。
   *  R3-d（c3 §9）：粘性 cwd 归 TS 编排层，per-owner 注册 + 随 agent 拆卸重置
   *  = 切工作区即重置；失效自愈在 Rust 口（sticky_cwd 候选盘上不存在即跳过）。 */
  stickyCwd?: string;
}

const registry = new Map<string, OwnerContext>();

/** Agent 装配期注册。返回 disposer（挂 ctx.effect，拆卸即清）。 */
export function registerOwnerContext(ownerId: string, workspaceRoot: string): () => void {
  registry.set(ownerId, { workspaceRoot });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    registry.delete(ownerId);
  };
}

/** 读 owner 上下文。未注册（单测/无引导环境/UI 路径）→ undefined——调用方必须
 *  loudly 报错或缺省不填充，绝静默兜底。 */
export function ownerContext(ownerId: string | undefined | null): OwnerContext | undefined {
  if (!ownerId) return undefined;
  return registry.get(ownerId);
}

/** 测试隔离辅助——清空全部注册（生产代码禁用）。 */
export function clearOwnerContextsForTest(): void {
  registry.clear();
}

// ── 焦点态（design-2 rev2：fs 焦点文件 + desktop 粘性窗口）──

/** fs 焦点文件读取（fill 源）。 */
export function focusPathOf(ownerId: string | undefined | null): string | undefined {
  return ownerContext(ownerId)?.focusPath;
}

/** fs 焦点文件设置（read/edit/write 成功后调用；存派发用的逻辑绝对路径）。 */
export function setFocusPath(ownerId: string | undefined | null, logicalPath: string): void {
  const c = ownerContext(ownerId);
  if (c) c.focusPath = logicalPath;
}

/** 焦点自愈回捞：fill 后派发失败 → 清焦（错清成本 = 一次重读；不清成本 = 反复踩死路径）。 */
export function clearFocusPath(ownerId: string | undefined | null): void {
  const c = ownerContext(ownerId);
  if (c) c.focusPath = undefined;
}

/** desktop 粘性窗口设置（显式定位 / uia_activate 成功后调用）。 */
export function setFocusWindow(ownerId: string | undefined | null, loc: WindowLocator): void {
  const c = ownerContext(ownerId);
  if (c) c.focusWindow = loc;
}

/** 粘性窗口自愈回捞（同 clearFocusPath 的成本权衡）。 */
export function clearFocusWindow(ownerId: string | undefined | null): void {
  const c = ownerContext(ownerId);
  if (c) c.focusWindow = undefined;
}

// ── shell 粘性 cwd（R3-d，c3 §9：编排记忆归 TS——marker 截流提交写本表）──

/** 粘性 cwd 读取（shell 派发候选源）。未注册 owner → undefined。 */
export function stickyCwdOf(ownerId: string | undefined | null): string | undefined {
  return ownerContext(ownerId)?.stickyCwd;
}

/** 粘性 cwd 设置（fg 命令 marker 捕获成功后调用；存物理绝对路径）。 */
export function setStickyCwd(ownerId: string | undefined | null, physicalPath: string): void {
  const c = ownerContext(ownerId);
  if (c) c.stickyCwd = physicalPath;
}

// ── shell 后台任务「忙等」哨兵（2026-11-12 bash_output 滥用批）──
//
// 事实依据：最近 7 卷统计，132 次 `shell(output)` 里 120 次只换回一行
// `[任务运行中, 已运行: Ns]`（91%），最长一段同 job 连读 31 次 / 237 秒。
// 每次读都是一整轮模型调用 ⇒ 这不是「便宜」而是最贵的空转。
//
// 判据与阈值在叶模块 `shell-poll-guard.ts`（纯函数，可单测）；本表只存
// 「本 owner 当前盯的是哪个 job、连续空读数几次、是否已喝止过」。
//
// 独立一张表（不挂 OwnerContext）的理由与下面的 `sessionByOwner` 同款：
// OwnerContext 的注册条件是「有 projectPath」，零目录工作区不注册——哨兵
// 必须在那类工作区里同样生效，否则「无项目也能跑 shell」的卷完全不受保护。
const shellPolls = new Map<string, ShellPollState>();

/** 读 owner 的忙等哨兵状态（未登记 = 本 owner 还没读过后台任务）。 */
export function shellPollStateOf(ownerId: string | undefined | null): ShellPollState | undefined {
  if (!ownerId) return undefined;
  return shellPolls.get(ownerId);
}

/** 写 owner 的忙等哨兵状态；`null` = 清除（读到增量/终态/换工具即归零）。 */
export function setShellPollState(ownerId: string | undefined | null, state: ShellPollState | null): void {
  if (!ownerId) return;
  if (state === null) shellPolls.delete(ownerId);
  else shellPolls.set(ownerId, state);
}

/** 清理单条（Agent 拆卸时调用——与 bus-unregister 同点对称）。 */
export function clearShellPollState(ownerId: string): void {
  shellPolls.delete(ownerId);
}

/** 测试隔离辅助——清空全部记录（生产代码禁用）。 */
export function clearShellPollsForTest(): void {
  shellPolls.clear();
}

// ── owner → 会话号（asset-state 读口，2026-10-07）──
//
// 用途：agent 侧模块（asset-state 的 listAssetStateSummaryForOwner）要经 owner
// （= executor 注入的 _owner_id，agent bus id）反查「本会话」——会话号是本仓库
// 会话级资源的通用键（TaskBoard / DiscoveryBoard / BoardPersistence 同源）。
//
// 为什么是独立一张表而不是 OwnerContext 的字段：会话绑定由 runtime 在
// `_bindAgentSession` / `_materializeSessionServices` 两处写入，而 OwnerContext
// 的注册条件是「有 projectPath」（零目录工作区不注册）——挂一起会让会话号解析
// 陪着 projectPath 一起缺席。两表各自独立、各自完备；消费方（asset-state）
// 按「两者齐备才可用」自行合取。
const sessionByOwner = new Map<string, string>();

/** runtime 会话绑定（AgentHandle.bindSession / 子 Agent 物化）时写入；
 *  同一 owner 重绑 = 覆盖（会话号归属会话层，随其重绑语义）。
 *  对称清理 = runtime `_disposeAgent`（与 _agentSessions 同命）。 */
export function setOwnerSessionId(ownerId: string, sessionId: string): void {
  sessionByOwner.set(ownerId, sessionId);
}

/** 读 owner 的会话号（未登记 = undefined——消费方如实降级，不造默认值）。 */
export function ownerSessionIdOf(ownerId: string | undefined | null): string | undefined {
  if (!ownerId) return undefined;
  return sessionByOwner.get(ownerId);
}

/** 清理单条（runtime _disposeAgent 调用——与 _agentSessions.delete 同点）。 */
export function clearOwnerSessionId(ownerId: string): void {
  sessionByOwner.delete(ownerId);
}

/** 测试隔离辅助——清空全部记录（生产代码禁用）。 */
export function clearOwnerSessionsForTest(): void {
  sessionByOwner.clear();
}

/** 绝对性判定：盘符（C:\ / C:/）、UNC（\\srv\share）、根相对（/x 或 \x）。
 *  纯文本判定，不做任何 IO / 规范化。 */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^[/\\]/.test(p);
}

/** 相对路径对根做纯 join——分隔符跟随根的风格，`..` 与内嵌点段原样保留
 *  （穿越序列由 Rust 沙箱拒绝，本函数绝不规范化掉它们）。绝对路径原样返回。 */
export function resolveAgainstRoot(root: string, p: string): string {
  if (isAbsolutePath(p)) return p;
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  const norm = sep === '\\' ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/');
  return `${base}${sep}${norm}`;
}
