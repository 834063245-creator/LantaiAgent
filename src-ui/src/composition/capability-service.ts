// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层第八 service —— capability 贡献注册表（P4 通道 A-3，设计件
// docs/plans/composition-architecture/designs/A3-capability-contribution-channel.md）：
// 「会话级能力的插件装载」（agent-plugin-architecture-plan §5——B⑤ 批的前置）。
//
// 贡献形状 = AgentCapability 本体（形状零改写——phase（context/agent）、when() 门控、
// install(scope) 全原样保留，插件贡献与第一方 capability 在同一张 blueprint 表上
// 竞争）。行 id = AgentCapability.id（M1 收口，2026-09-14：与其余七条通道统一；
// 历史名 key 已废弃，别名不留）——行 id 同时是 AgentBlueprint 唯一性约束与
// roster 寻址面。推荐 '<插件名>/<能力名>' npm scope 风格（prompts/hooks 通道
// 同款约定，跨插件防撞名）。
//
// 注册表内核（M1 收口）：ContributionChannel 单一实现（contribution-channel.ts）
// ——本文件不再自持手抄的 CapabilityContributionRegistry（历史债：六份复制之一，
// 且是唯一用 key 当行身份的一份）。本通道的差异只剩三件声明式数据：
//   - timing: 'next-assembly'（见下）；
//   - validate: assertContributionShape（运行时形状守卫——外部插件是纯 JS 无 tsc）；
//   - onChanged: fireCapabilityContributionsChanged（组合输入变更监听）。
//
// 保留的契约要点：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖）——B⑤ 收官（2026-08-24）后第一方
//     十五项本身经通道注册（装载序 = capabilitiesServicePlugin → 第一方 capability
//     插件 → 外部插件），外部贡献撞第一方 id 同样走注册表重名拒绝（装载期可见）。
//
// 组合解析域（设计件 §2.2/§2.5，S4-4 甲第三挂点）：贡献 id 经 factoryComposition()
// 快照进 capabilities 域（B⑤ 后唯一行源——第一方十五项经通道注册，贡献序 =
// 注册序；无通道环境 = 空表）；patch/preset 可按 id disable 贡献行（插件开关与
// 能力粒度裁剪两层正交）。贡献 register/dispose 因此成为组合输入变更
// ——onCapabilityContributionsChanged 供 preset-assembly 的组合 cache 代数失效
// + bootShell 的贡献监听重应用。
//
// 生效时机 = 下次 Agent 装配（新会话）——runtime._assembleAgent 既有穿线
// AgentBlueprint.fromRoster(composition.capabilities) 消费整张表（A-3 零
// runtime 改动）；在途会话保持创建时点的能力面不变（KV-cache 纪律，同
// tools/prompts/hooks 三通道）。子 Agent 不自动继承（spawnSubAgent 手工装配
// 不经 blueprint——既有语义不下放）。

import type { AgentCapability } from '../agent/blueprint';
import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';

/** capability 贡献：形状即 AgentCapability（id 寻址 + 阶段 + 条件 + 安装动作）。 */
export type CapabilityContribution = AgentCapability;

// ── 贡献变更监听（S4-4 甲第三挂点）──
// 与 tools/prompts 两通道同款：贡献进组合解析域后，register/dispose = 组合输入变更。
type CapabilityContributionsChangedListener = () => void;
const capabilityContributionListeners = new Set<CapabilityContributionsChangedListener>();

/** 订阅 capability 贡献变更（register/dispose）。返回退订函数。 */
export function onCapabilityContributionsChanged(cb: CapabilityContributionsChangedListener): () => void {
  capabilityContributionListeners.add(cb);
  return () => capabilityContributionListeners.delete(cb);
}

function fireCapabilityContributionsChanged(): void {
  for (const cb of [...capabilityContributionListeners]) cb();
}

/** 运行时形状守卫（设计件 §2.1）：三个承重字段装载期校验——外部插件是
 *  纯 JS（无 tsc），漏 install / phase 拼错不拦即潜伏到会话装配期。 */
function assertContributionShape(def: CapabilityContribution): void {
  if (typeof def.id !== 'string' || def.id === '') {
    throw new Error('[capabilities] 贡献 id 必须是非空 string');
  }
  if (def.phase !== 'context' && def.phase !== 'agent') {
    throw new Error(`[capabilities] 贡献 "${def.id}" 的 phase 必须是 "context" | "agent"（收到 ${String(def.phase)}）`);
  }
  if (typeof def.install !== 'function') {
    throw new Error(`[capabilities] 贡献 "${def.id}" 缺少 install 函数`);
  }
}

// ── service 本体 ──

export class CapabilitiesService extends Service {
  // 下次装配生效语义 + 装载期形状守卫 + 组合输入变更监听。
  private registry = new ContributionChannel<CapabilityContribution>('capabilities', {
    timing: 'next-assembly',
    validate: assertContributionShape,
    onChanged: fireCapabilityContributionsChanged,
  });

  constructor(ctx: Context) {
    super(ctx, 'capabilities');
    _activeCapabilities = this; // 消费闭环读取面（factoryComposition 快照）
  }

  register(def: CapabilityContribution): () => void {
    return this.registry.register(def);
  }

  list(): CapabilityContribution[] {
    return this.registry.list();
  }
}

// ── 消费闭环读取面（模块级活动服务——services.ts 同款第 3 类可变态：
//    单一键，生命周期 = 进程，服务构造期登记）──

let _activeCapabilities: CapabilitiesService | null = null;

/** 当前 capability 贡献（无服务/无注册 = 空集——factoryComposition 读这个）。 */
export function activeCapabilityContributions(): CapabilityContribution[] {
  return _activeCapabilities?.list() ?? [];
}

// ── 组合层挂载插件（根 Context 装载；经 loadBuiltinPlugins 引导）──

declare module '../cordis/context' {
  interface Context {
    /** capability 贡献注册表（A-3 第八贡献通道）——贡献注册 → disposer；
     *  下次 Agent 装配生效语义。 */
    capabilities: CapabilitiesService;
  }
}

/** 内核线实体化：capability 贡献注册表常驻根上下文，先于外部插件装载
 *  （BUILTIN_PLUGINS 表内 hooksServicePlugin 之后）。 */
export const capabilitiesServicePlugin = {
  name: 'hologram/capability-services',
  apply(ctx: Context) {
    const svc = new CapabilitiesService(ctx);
    // 服务随根 fiber 常驻（app 生命周期）。dispose 路径（测试拆卸）守卫式
    // 清空活动指针：贡献直接进组合解析域（capability 表序 = 字节敏感面），
    // 读取面必须随服务生命周期归零——不残留陈旧注册污染后续快照
    // （vitest 同 worker 模块态跨测试共享，残留即静默串味；
    // prompt/hook service 同款纪律）。
    ctx.effect(
      () => () => {
        if (_activeCapabilities === svc) _activeCapabilities = null;
      },
      'capabilities-active-clear',
    );
  },
};
