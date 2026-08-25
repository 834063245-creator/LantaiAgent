// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 组合层四 service（S1-1）——panels / commands / tools / providers 挂根 Context。
//
// 宪法定位（composition-architecture README「内核线」第 3 条）：slot / 注册表本身是
// 特权代码，永不插件化——本文件在内核线内。四 service 只做注册与注销（行生命周期的
// 锚点），不做任何业务：面板渲染、命令分发、工具执行都仍在各自既有实现。
//
// 契约（S1 设计件 §3 S1-1 + 计划 README S1 节第 5 条）：
//   - register(def) → Disposer：调用方负责挂 ctx.effect（对齐 agent 工具面
//     ToolRegistry.register 与工作区资源两原语的裸 disposer 契约——vendored cordis
//     不提供运行时 caller-fiber 追踪，所有权登记是调用方纪律，见 AGENTS.md §6）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖——「错误不静默」宪法）；
//   - disposer 幂等且不误删后注册的同名行（与 ToolRegistry 相同的陈旧性守卫）；
//   - 工具/provider 贡献下次 Agent 装配生效；命令/面板即时生效（生效时机语义由
//     消费方实现，本文件不实现任何生效逻辑）。
//
// S1-1 是纯新增批：既有内置装配（PANEL_DEFS / DEFAULT_COMMANDS / buildToolRegistry）
// 不改读这里；S1-2/S1-3 起内置面才逐族迁行接管。四 service 经 compositionServicesPlugin
// 挂根 Context（loadBuiltinPlugins 引导，先于外部插件装载——inject 依赖可解析）。

import type { ComponentType } from 'react';
import type { Tool } from '../agent/tool';
import { type Context, Service } from '../cordis';
import { bumpCommands, bumpPanelDefs } from '../state/panel-defs-store';
import type { ToolRowContext } from './tool-rows';

// ── 工具贡献变更监听（S4-1.5）──
// ToolsService 的 onChange：不 bump 即时信号（下次装配语义），但触发
// 「贡献变更」钩子——pluginToolRows() 的实例缓存按贡献生命周期管理
// （register 时 factory 调用一次缓存实例；dispose 清缓存——工具实例
// 不随每次装配重建，设计件 §2.3 ToolRow 折算规则）。
type ContributionsChangedListener = () => void;
const contributionListeners = new Set<ContributionsChangedListener>();

/** 订阅工具贡献变更（register/dispose）。返回退订函数。 */
export function onToolContributionsChanged(cb: ContributionsChangedListener): () => void {
  contributionListeners.add(cb);
  return () => contributionListeners.delete(cb);
}

function fireContributionsChanged(): void {
  for (const cb of [...contributionListeners]) cb();
}

// ── def 形状（字段对齐既有消费面：PanelDef / CommandDef；tools 行对齐 S1-0 的
//    ToolContribution 概念——S1-2 起行表统一到此形状）──

export interface PanelContribution {
  /** 面板 id——string 开集（S1-5 起 DockPanelId union 退役，合法清单由
   *  panel-def 装载期校验守门；外部插件面板经本 service 注册走同款语义）。 */
  id: string;
  /** 轨道侧；null = 不上轨道（命令面板 / 快捷键唤起） */
  side: 'left' | 'right' | null;
  title: string;
  icon: string;
  /** 面板内提供「问 Agent」入口 */
  askAgent?: boolean;
  /** 关闭即卸载、重开重置状态 */
  unmountOnClose?: boolean;
  component: ComponentType;
}

export interface CommandContribution {
  id: string;
  /** 显示名称 */
  label: string;
  /** 副标题 / 描述 */
  description?: string;
  /** 分组 */
  group: string;
  /** 快捷路径（如 '/memory'），用于输入匹配和提示 */
  shortcut: string;
  action:
    | { type: 'send'; text: string; displayLabel: string }
    | { type: 'local'; handler: () => void }
    | { type: 'fill'; text: string }
    | { type: 'skill'; skillName: string };
}

export interface ToolContribution {
  /** 行 id（S1-2 起由行表寻址；与 Tool.name 可不同——行 id 稳定寻址，name 是模型可见名）。 */
  id: string;
  /** 工具工厂。三种形态：
   *  - 无参 factory → Tool（外部插件经典形态，S4-1.5 契约）；
   *  - factory(rowCtx) → Tool（B① 放宽：第一方域插件收装配上下文取 codingExec
   *    等装配期依赖——收 ctx 的贡献自担「首装配实例跨装配复用」的语义等价责任）；
   *  - factory → Tool[]（S4-4 乙放宽：MCP 机器桥行——一个 server 贡献整组
   *    远端工具，惰性连接后动态产出；空集不缓存，下次装配重试）。
   *  实例缓存对非空结果跨装配复用（工具可能持状态/连接）；dispose 清缓存。 */
  factory: (ctx?: ToolRowContext) => Tool | Tool[] | Promise<Tool | Tool[]>;
  /** 无缓存行（①c 路线一，2026-08-23 拍板 #2）：factory 每装配重调、产物不进
   *  实例缓存——依赖装配期真值的族（wait 的 subAgentPool / ask 的 ui 回调 /
   *  hologram 的 graphData 开关）经此标记跨装配取新真值。缓存行为等价于
   *  「永远 miss」：每装配新实例（无跨装配串扰面）。 */
  noCache?: boolean;
}

export interface ProviderContribution {
  id: string;
  /** provider 工厂（S1 阶段仅注册语义；组合引擎消费在 S2）。 */
  factory: () => unknown;
}

// ── 通用注册表内核（四 service 共用：id 寻址 + Disposer + 重名拒绝 + 组合序）──

/**
 * 注册表变更信号（S4-1.5 消费闭环）——panels/commands 域贡献变更时 bump
 * 对应信号 store（即时生效语义：DockRail/DockPanel/CommandPalette 重取
 * 清单）。tools/providers 不 bump——它们的生效时机是「下次 Agent 装配」
 * （S1 既有语义），无即时消费面。
 */
type ChangeSignal = () => void;

class ContributionRegistry<T extends { id: string }> {
  private entries = new Map<string, { def: T; dispose: () => void }>();

  constructor(
    private readonly kind: string,
    private readonly onChange: ChangeSignal | null = null,
  ) {}

  register(def: T): () => void {
    if (this.entries.has(def.id)) {
      throw new Error('[' + this.kind + '] duplicate contribution id "' + def.id + '" —— 装载期拒绝，不静默覆盖');
    }
    let done = false;
    const entry = {
      def,
      dispose: () => {
        // 一次性守卫 + 陈旧性守卫（对齐 ToolRegistry.register 的 disposer 契约）：
        // done 保证幂等；同 def 对象重注册后，陈旧 disposer 的二次调用不误删新行。
        if (done) return;
        done = true;
        if (this.entries.get(def.id)?.def === def) {
          this.entries.delete(def.id);
          this.onChange?.(); // 贡献消失——即时面重取清单（S4-1.5）
        }
      },
    };
    this.entries.set(def.id, entry);
    this.onChange?.(); // 贡献出现——即时面重取清单（S4-1.5）
    return entry.dispose;
  }

  get(id: string): T | undefined {
    return this.entries.get(id)?.def;
  }

  /** 组合序 = 注册序（数组序）；前缀缓存语义依赖此序（S1 设计件 §2.1）。 */
  list(): T[] {
    return [...this.entries.values()].map((e) => e.def);
  }
}

// ── 四 service 本体（结构同构，分立四个服务名：inject 面各自独立）──

export class PanelsService extends Service {
  private registry = new ContributionRegistry<PanelContribution>('panels', bumpPanelDefs);

  constructor(ctx: Context) {
    super(ctx, 'panels');
    setActivePanels(this); // S4-1.5：消费闭环读取面（panelDefs() 合流点）
  }

  register(def: PanelContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): PanelContribution | undefined {
    return this.registry.get(id);
  }

  list(): PanelContribution[] {
    return this.registry.list();
  }
}

export class CommandsService extends Service {
  private registry = new ContributionRegistry<CommandContribution>('commands', bumpCommands);

  constructor(ctx: Context) {
    super(ctx, 'commands');
    setActiveCommands(this); // S4-1.5：消费闭环读取面（effectiveActions() 合流点）
  }

  register(def: CommandContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): CommandContribution | undefined {
    return this.registry.get(id);
  }

  list(): CommandContribution[] {
    return this.registry.list();
  }
}

export class ToolsService extends Service {
  private registry = new ContributionRegistry<ToolContribution>('tools', fireContributionsChanged);

  constructor(ctx: Context) {
    super(ctx, 'tools');
    setActiveTools(this); // S4-1.5：消费闭环读取面（pluginToolRows() 折算源）
  }

  register(def: ToolContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): ToolContribution | undefined {
    return this.registry.get(id);
  }

  list(): ToolContribution[] {
    return this.registry.list();
  }
}

export class ProvidersService extends Service {
  private registry = new ContributionRegistry<ProviderContribution>('providers');

  constructor(ctx: Context) {
    super(ctx, 'providers');
  }

  register(def: ProviderContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): ProviderContribution | undefined {
    return this.registry.get(id);
  }

  list(): ProviderContribution[] {
    return this.registry.list();
  }
}

// ── S4-1.5 消费闭环读取面 ──
//
// React 消费面（DockRail/DockPanel/CommandPalette）与装配面（buildToolRegistry）
// 不持根 Context 引用——经此模块级「活动服务」间接层读取贡献清单。服务的
// set/bump 都发生在构造期（loadBuiltinPlugins 引导），fiber dispose 卸载
// 时无消费者残留（app 生命周期 = 根 fiber 生命周期）。模块级可变态归属
// CONVENTIONS §1.10 第 3 类（键控自清理：单一键，生命周期 = 进程）。

let _activePanels: PanelsService | null = null;
let _activeCommands: CommandsService | null = null;
let _activeTools: ToolsService | null = null;

/** 服务构造期登记（loadBuiltinPlugins 引导的唯一入口）。 */
function setActivePanels(svc: PanelsService): void {
  _activePanels = svc;
}
function setActiveCommands(svc: CommandsService): void {
  _activeCommands = svc;
}
function setActiveTools(svc: ToolsService): void {
  _activeTools = svc;
}

/** 当前面板贡献（无服务/无注册 = 空集——合流点读这个，常量面零改写）。 */
export function activePanelContributions(): PanelContribution[] {
  return _activePanels?.list() ?? [];
}

/** 当前面板贡献按 id 查找。 */
export function getPanelContribution(id: string): PanelContribution | undefined {
  return _activePanels?.get(id);
}

/** 当前命令贡献（无服务/无注册 = 空集）。 */
export function activeCommandContributions(): CommandContribution[] {
  return _activeCommands?.list() ?? [];
}

/** 当前工具贡献（无服务/无注册 = 空集——pluginToolRows 折算源）。 */
export function activeToolContributions(): ToolContribution[] {
  return _activeTools?.list() ?? [];
}

// ── 组合层挂载插件（根 Context 装配四 service；经 loadBuiltinPlugins 引导）──

declare module '../cordis/context' {
  interface Context {
    /** 面板注册表（S1-1）——def 注册 → disposer；即时生效语义。 */
    panels: PanelsService;
    /** 命令注册表（S1-1）——def 注册 → disposer；即时生效语义。 */
    commands: CommandsService;
    /** 工具注册表（S1-1）——行注册 → disposer；下次 Agent 装配生效语义。 */
    tools: ToolsService;
    /** Provider 注册表（S1-1）——行注册 → disposer；下次 Agent 装配生效语义。 */
    providers: ProvidersService;
  }
}

/** 内核线第 3 条的实体化：注册表常驻根上下文，先于任何外部插件装载。
 *  空间服务（ctx.space）独立成 spaceServicePlugin（依赖 chat-store 链，
 *  不并入本插件——见 composition/space-service.ts 头注）。 */
export const compositionServicesPlugin = {
  name: 'hologram/composition-services',
  apply(ctx: Context) {
    new PanelsService(ctx);
    new CommandsService(ctx);
    new ToolsService(ctx);
    new ProvidersService(ctx);
  },
};
