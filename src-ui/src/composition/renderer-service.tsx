// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 组合层第五 service —— 块渲染器贡献通道（paper-shell V3b）——**纯通道**。
//
// 缘起（paper-shell 计划 V3b「块渲染器 = ctx service——组合层第五贡献通道」；
// 组合层 README D0 收敛注记：块协议的语义声明 + 可插拔渲染器本身就是一个
// 插件面）。
//
// M2 收口（2026-09-14）：本文件曾同时住着通道与出厂渲染器实现（1106 行里
// 约 980 行是 markdown/高亮/katex/diff/plan/tool/user 的体渲染）——通道是
// 内核线（永不插件化），实现是产品，两者同居使「通道文件」名不副实。现实现
// 已迁 `src/app/paper/builtin-renderers.tsx`（随应用编译，不是可禁用产物），
// 出厂行的注册点从 RenderersService 构造器移到 rendererServicePlugin 的
// apply（装配点/wiring）——通道类（RenderersService）此后只做注册表。
//
// 契约（M1 收口后经 ContributionChannel 单一内核；历史五份手抄之一的
// RendererRegistry 已退役）：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖）；
//   - disposer 幂等 + 陈旧性守卫（同 def 重注册后旧 disposer 不误删新行）；
//   - 生效时机 = 'frame'（声明式）：纸壳渲染每帧经 resolveRenderer 重取有效
//     清单，无常驻 React 清单缓存，故无 bump 信号 store。
//
// 渲染器职责边界（灰框纪律的结构化）：
//   - 渲染器只渲染块**体**（kind 特定内容）；块壳（头部/拖拽手柄/钉住收回/
//     占位符）是纸壳结构件，不进注册表——插件换的是「这个 kind 长什么样」，
//     不是「纸怎么交互」。
//   - 出厂行（十一 kind 全谱 + '*' 兜底）= 默认行，由 rendererServicePlugin
//     注册；贡献行与出厂行同 kind 时**后注册胜**（插件晚于出厂装载），同 id
//     时装载期拒绝。

import type { ComponentType } from 'react';
import { assetKinds } from '../agent/asset-kinds';
import { builtinRendererDefs, JsonBody } from '../app/paper/builtin-renderers';
import { type Context, Service } from '../cordis';
import type { BlockKind, SourcedBlock } from '../paper/block-model';
import { ContributionChannel } from './contribution-channel';

/** 渲染器组件入参——渲染器拿到块本体 + 纸壳递下的服务性回调。
 *  folded（2026-08-30 折叠机制）：壳层算好的有效折叠态（用户覆盖 ?? 默认规则，
 *  规则在 paper/fold.ts）——渲染器只按态收敛渲染面，不自持折叠状态。 */
export interface BlockRendererProps {
  block: SourcedBlock;
  folded?: boolean;
  /** P5 眉批折叠态（夹注恒折拍板延续——复合 markdown 的眉批默认收起） */
  sidecarFolded?: boolean;
  /** 眉批折叠切换（壳层 foldOv 持久，key = `${block.id}:sc`） */
  onToggleSidecarFold?: (block: SourcedBlock) => void;
  /** 眉批拖出钉画布（移出语义：首动建钉跟手，快照从眉批栏原位揭起） */
  onSidecarPinMouseDown?: (e: React.MouseEvent, block: SourcedBlock) => void;
  /** 眉批已钉出（2026-08-31 移出语义）：`:sc` 快照钉在画布上——体渲染换
   *  「已移出·点击恢复」占位（替代夹注全文/折叠钮/钉手柄）。 */
  sidecarOut?: boolean;
  /** 眉批恢复：拔掉 `:sc` 快照钉，夹注回眉批栏（占位点击手势的语义端） */
  onSidecarRestore?: (block: SourcedBlock) => void;
}

/** 渲染器贡献：一个 kind 一个渲染器（body 渲染组件）。 */
export interface BlockRendererContribution {
  /** 贡献 id——惯例 '<源>/<kind>'（如 'builtin/markdown'）；与出厂同 id 装载期拒绝。 */
  id: string;
  /** 渲染目标块类型（'*' = 兜底渲染器：无专渲染器的 kind 落这里）。 */
  kind: BlockKind | '*';
  component: ComponentType<BlockRendererProps>;
}

// ── 注册表内核（M1 收口：composition/contribution-channel 单一实现——
//    本文件不再自持类；timing='frame' 声明在构造点）──

// ── service 本体（纯通道：只做注册与注销，不构造任何出厂行）──

export class RenderersService extends Service {
  private registry = new ContributionChannel<BlockRendererContribution>('renderers', { timing: 'frame' });

  constructor(ctx: Context) {
    super(ctx, 'renderers');
    _activeRenderers = this; // 消费闭环读取面（纸壳渲染每帧重取）
  }

  register(def: BlockRendererContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): BlockRendererContribution | undefined {
    return this.registry.get(id);
  }

  list(): BlockRendererContribution[] {
    return this.registry.list();
  }
}

// ── 消费闭环读取面（模块级活动服务——services.ts 同款第 3 类可变态）──

let _activeRenderers: RenderersService | null = null;

/** 有效渲染器清单（无服务 = 空集 + 出厂兜底——纸壳灰框永不裸奔）。 */
export function activeRendererContributions(): BlockRendererContribution[] {
  return _activeRenderers?.list() ?? [];
}

/**
 * 按 kind 解析渲染器：贡献清单里找该 kind 的行；同 kind 多行时
 * 后注册胜（显式覆盖语义：插件晚于出厂装载，覆盖即生效）；
 * 无专渲染器 → '*' 兜底行；全无 → undefined（纸壳用出厂灰框直渲）。
 */
export function resolveRenderer(kind: BlockKind): BlockRendererContribution | undefined {
  let fallback: BlockRendererContribution | undefined;
  let found: BlockRendererContribution | undefined;
  for (const r of activeRendererContributions()) {
    if (r.kind === '*') fallback = r;
    else if (r.kind === kind) found = r; // 后写胜（list 保注册序）
  }
  return found ?? fallback;
}

/**
 * 资产块解析（协议 §2.11）：kind → 白名单回落 → presentation → 表现原语组件。
 * kind 未注册 / presentation 脏数据（不在白名单）→ 回落 kind 的 defaultPresentation；
 * 仍无表现组件 → undefined（纸壳走 '*' 兜底 JSON 视图，WO-4）。
 */
export function resolveAssetBlock(
  kind: string,
  presentation: string | undefined,
): ComponentType<BlockRendererProps> | undefined {
  const def = assetKinds.get(kind);
  if (!def) return resolveRenderer('*')?.component;
  const resolved = presentation && def.presentations.includes(presentation) ? presentation : def.defaultPresentation;
  // 降级链（2026-09-18 真机取证）：白名单可能与注册面脱钩（deps_impact 曾声明无实现的
  // 'table' ⇒ 静默落 '*' JSON，用户看到一张 JSON 卡）。故：请求的表现无渲染器 → 退该 kind
  // 的默认表现 → 再退 '*'。**注册面缺失不再等价于「给你看 JSON」**。
  return (
    resolveRenderer(resolved as BlockKind)?.component ??
    resolveRenderer(def.defaultPresentation as BlockKind)?.component ??
    resolveRenderer('*')?.component
  );
}

// ── 挂载插件（对齐 compositionServicesPlugin；装载期在四 service 之后，
//    同批 loadBuiltinPlugins 引导——块渲染器依赖 cordis Context 即可）──
//
// M2 起**出厂行的注册点在本插件**（不是 RenderersService 构造器）：
//   1. 出厂注疏渲染器十一件（builtinRendererDefs——随应用编译，见
//      app/paper/builtin-renderers.tsx 的归属纪律）；
//   2. '*' 兜底行：未知/资产 kind 未接表现原语时显示漂亮 JSON（WO-4）——
//      不并入 builtinRendererDefs()，保持「十一 kind 全谱」的既有契约面。
// 资产表现原语（WO-6 → P1 插件通道化 → 4B citation）：grid/chart/metric/
// media/graph/tree/html/form/board/timeline/citation 由「内置渲染器插件」
// （plugins/builtin/renderers，BUILTIN_PLUGINS 表项）经 ctx.renderers 注册
// ——P1 起从编译期 bundle 迁为可热重载的第一方插件行；测试直引本 service
// 时需要先装载渲染器插件（asset-primitives.test / asset-media-load.test 已同步）。

declare module '../cordis/context' {
  interface Context {
    /** 块渲染器注册表（V3b 第五贡献通道）——def 注册 → disposer；即时生效。 */
    renderers: RenderersService;
  }
}

export const rendererServicePlugin = {
  name: 'hologram/renderer-service',
  apply(ctx: Context) {
    const svc = new RenderersService(ctx);
    for (const def of builtinRendererDefs()) svc.register(def);
    svc.register({ id: 'builtin/*', kind: '*', component: JsonBody });
  },
};
