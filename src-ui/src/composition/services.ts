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
  factory: () => Tool;
}

export interface ProviderContribution {
  id: string;
  /** provider 工厂（S1 阶段仅注册语义；组合引擎消费在 S2）。 */
  factory: () => unknown;
}

// ── 通用注册表内核（四 service 共用：id 寻址 + Disposer + 重名拒绝 + 组合序）──

class ContributionRegistry<T extends { id: string }> {
  private entries = new Map<string, { def: T; dispose: () => void }>();

  constructor(private readonly kind: string) {}

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
        }
      },
    };
    this.entries.set(def.id, entry);
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
  private registry = new ContributionRegistry<PanelContribution>('panels');

  constructor(ctx: Context) {
    super(ctx, 'panels');
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
  private registry = new ContributionRegistry<CommandContribution>('commands');

  constructor(ctx: Context) {
    super(ctx, 'commands');
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
  private registry = new ContributionRegistry<ToolContribution>('tools');

  constructor(ctx: Context) {
    super(ctx, 'tools');
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

// ── Context 类型增强（消费面 ctx.panels / ctx.commands / ctx.tools / ctx.providers）──

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

// ── 组合层挂载插件（根 Context 装配四 service；经 loadBuiltinPlugins 引导）──

/** 内核线第 3 条的实体化：四注册表常驻根上下文，先于任何外部插件装载。 */
export const compositionServicesPlugin = {
  name: 'hologram/composition-services',
  apply(ctx: Context) {
    new PanelsService(ctx);
    new CommandsService(ctx);
    new ToolsService(ctx);
    new ProvidersService(ctx);
  },
};
