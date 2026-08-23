// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层第八 service —— capability 贡献注册表（P4 通道 A-3，设计件
// docs/plans/composition-architecture/designs/A3-capability-contribution-channel.md）：
// 「会话级能力的插件装载」（agent-plugin-architecture-plan §5——B⑤ 批的前置）。
//
// 贡献形状 = AgentCapability 本体（形状零改写——phase（context/agent）、when() 门控、
// install(scope) 全原样保留，插件贡献与第一方 capability 在同一张 blueprint 表上
// 竞争）。key 即寻址 id：capabilities 域「行 id = 现 key」是 S2 设计件 §2.1 既有
// 裁定——key 同时是 AgentBlueprint 唯一性约束与 roster 寻址面。推荐
// '<插件名>/<能力名>' npm scope 风格（hooks 通道同款约定，跨插件防撞名）。
//
// 契约对齐 prompt-service（贡献进解析域的先例）与 hook-service（A-2 先例）：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 key 装载期拒绝（throw，不静默覆盖）——B⑤ 收官（2026-08-24）后
//     第一方十五项本身经通道注册（装载序 = capabilitiesServicePlugin →
//     第一方 capability 插件 → 外部插件），外部贡献撞第一方 key 同样走
//     注册表重名拒绝（装载期可见）；A-3 时代的「撞 builtinCapabilities()
//     key 拒绝」随出厂表退役而退役（B④ prompt-service 同款终态——无第一
//     方通道的环境里第一方 key 可注册，撞名防线在装载序上）；
//   - 运行时形状守卫（外部插件是纯 JS 无 tsc——畸形贡献须在装载期拒绝，不
//     潜伏到会话装配期 TypeError；loader 的 isPluginShape 同款先例）；
//   - disposer 幂等 + 陈旧性守卫（同 def 重注册后旧 disposer 不误删新行）；
//   - 无即时 React 信号（capability 无常驻清单消费面）。
//
// 组合解析域（设计件 §2.2/§2.5，S4-4 甲第三挂点；B⑤ 收官修订见文件头）：
// 贡献 key 经 factoryComposition() 快照进 capabilities 域（B⑤ 后唯一行源
// ——第一方十五项经通道注册，贡献序 = 注册序；无通道环境 = 空表）；patch/
// preset 可按 key disable 贡献行（插件开关与能力粒度裁剪两层正交）。贡献
// register/dispose 因此成为组合输入变更——onCapabilityContributionsChanged
// 供 preset-assembly 的组合 cache 代数失效 + bootShell 的贡献监听重应用。
//
// 生效时机 = 下次 Agent 装配（新会话）——runtime._assembleAgent 既有穿线
// AgentBlueprint.fromRoster(composition.capabilities) 消费整张表（A-3 零
// runtime 改动）；在途会话保持创建时点的能力面不变（KV-cache 纪律，同
// tools/prompts/hooks 三通道）。子 Agent 不自动继承（spawnSubAgent 手工装配
// 不经 blueprint——既有语义不下放）。

import type { AgentCapability } from '../agent/blueprint';
import { type Context, Service } from '../cordis';

/** capability 贡献：形状即 AgentCapability（key 寻址 + 阶段 + 条件 + 安装动作）。 */
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

// ── 注册表内核（prompt-service 同款单文件自持；不导出公共类）──

/** 运行时形状守卫（设计件 §2.1）：三个承重字段装载期校验——外部插件是
 *  纯 JS（无 tsc），漏 install / phase 拼错不拦即潜伏到会话装配期。 */
function assertContributionShape(def: CapabilityContribution): void {
  if (typeof def.key !== 'string' || def.key === '') {
    throw new Error('[capabilities] 贡献 key 必须是非空 string');
  }
  if (def.phase !== 'context' && def.phase !== 'agent') {
    throw new Error(
      `[capabilities] 贡献 "${def.key}" 的 phase 必须是 "context" | "agent"（收到 ${String(def.phase)}）`,
    );
  }
  if (typeof def.install !== 'function') {
    throw new Error(`[capabilities] 贡献 "${def.key}" 缺少 install 函数`);
  }
}

class CapabilityContributionRegistry {
  private entries = new Map<string, { def: CapabilityContribution; dispose: () => void }>();

  constructor(private readonly onChange: (() => void) | null = null) {}

  register(def: CapabilityContribution): () => void {
    assertContributionShape(def);
    if (this.entries.has(def.key)) {
      throw new Error('[capabilities] duplicate contribution key "' + def.key + '" —— 装载期拒绝，不静默覆盖');
    }
    let done = false;
    const entry = {
      def,
      dispose: () => {
        if (done) return;
        done = true;
        if (this.entries.get(def.key)?.def === def) {
          this.entries.delete(def.key);
          this.onChange?.(); // 贡献消失（陈旧性守卫内——实际删除才触发）
        }
      },
    };
    this.entries.set(def.key, entry);
    this.onChange?.(); // 贡献出现
    return entry.dispose;
  }

  /** 组合序 = 注册序（表尾追加序——前缀缓存语义依赖此序）。 */
  list(): CapabilityContribution[] {
    return [...this.entries.values()].map((e) => e.def);
  }
}

// ── service 本体 ──

export class CapabilitiesService extends Service {
  private registry = new CapabilityContributionRegistry(fireCapabilityContributionsChanged);

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
