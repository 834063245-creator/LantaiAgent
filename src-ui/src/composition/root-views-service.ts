// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition/root-views-service — App 外壳视图槽通道（批 9e，2026-09-26）。
//
// 病灶（账本 §2.4 常驻面两行）：案卷首页（`app/SessionsHome.tsx` 593）与 ask/权限卡架
// （`app/chat/PromptShelf.tsx` 776 + `PromptShelfHost.tsx` 30）都在 App 根硬编码渲染——
// 「应用入口页」与「会话刚需浮层」是产品内容，却住在应用外壳里 ⇒ 改样式/文案要重建 exe。
// 既有 `ctx.overlays` 只有 `composer` / `right-edge` 两槽，且渲染点在 **paper-shell 产物内部**
// （只在工作区内存在）；`ctx.panels` 是「可开关面板」语义。首页与浮层需要一个**由 App 外壳渲染**
// 的落点 ⇒ 本通道（用户 2026-09-26 裁定 A：立统一 `ctx.rootViews` 双槽）。
//
// 原则二/三（插件化分层）：**外壳只长通道，不写具体形态**——App.tsx 按槽取活动贡献行渲染，
// 贡献行由产物 apply 经 ctx.rootViews 注册（对齐 compose-dock / paper-minimap 用 ctx.overlays 的先例）。
// 对齐 overlay-service 的 register→Disposer 裸契约（调用方经 ctx.effect 登记，所有权归调用方）。
//
// 槽位（闭集，两个都在 App 根层——与 `ctx.overlays` 的「工作区内」正交）：
//   - 'home'    —— 主区视图（工作区未进入时的应用入口页；同时只应有 1 行活动贡献）；
//   - 'overlay' —— 根浮层（ask / 权限卡一类「无工作区也要在场」的浮层）。
//
// 缺席语义：槽内无活动贡献 = App 该层零渲染（不兜底、不内联）。
// 因此入口页产物标 `required`（不可禁用——名册 `required: true`），否则用户可以把自己关在门外。

import type { ComponentType } from 'react';
import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';

/** 外壳视图槽位。 */
export type RootViewSlot = 'home' | 'overlay';

/** 外壳视图贡献定义。 */
export interface RootViewContribution {
  id: string;
  slot: RootViewSlot;
  component: ComponentType;
}

// ── 注册表内核（与 overlay-service 同款：槽过滤 + 订阅都走 composition/contribution-channel 单一实现）──

export class RootViewsService extends Service {
  // 即时生效语义：App 挂载期经 subscribeRootViews 订阅，贡献热注册即时重取渲染面。
  private registry = new ContributionChannel<RootViewContribution>('rootViews', { timing: 'immediate' });

  constructor(ctx: Context) {
    super(ctx, 'rootViews');
    setActiveRootViews(this);
  }

  register(def: RootViewContribution): () => void {
    return this.registry.register(def);
  }

  list(slot: RootViewSlot): RootViewContribution[] {
    return this.registry.filter((def) => def.slot === slot);
  }

  /** 订阅贡献变更（register/dispose——App 即时重取渲染面）。 */
  subscribe(cb: () => void): () => void {
    return this.registry.subscribe(cb);
  }
}

// ── 活动服务间接层（对齐 overlay-service 的模块级单例读取面）──
// 模块级可变态归属 CONVENTIONS §1.10 第 3 类（键控自清理：单一键，进程生命周期）。

let _activeRootViews: RootViewsService | null = null;

function setActiveRootViews(svc: RootViewsService): void {
  _activeRootViews = svc;
}

/** 当前外壳视图贡献（无服务/无注册 = 空集——App 渲染面合流点）。 */
export function activeRootViews(slot: RootViewSlot): RootViewContribution[] {
  return _activeRootViews?.list(slot) ?? [];
}

/** 订阅外壳视图贡献变更（无服务 = 空退订；App 挂载期调用，贡献热注册即时生效）。 */
export function subscribeRootViews(cb: () => void): () => void {
  return _activeRootViews?.subscribe(cb) ?? (() => {});
}

// ── ctx 通道声明（对齐 overlay-service / space-service 的 augmentation）──

declare module '../cordis/context' {
  interface Context {
    /** App 外壳视图槽通道（批 9e）：首页（slot:'home'）与根浮层（slot:'overlay'）
     *  由产物贡献，App.tsx 按槽渲染。 */
    rootViews: RootViewsService;
  }
}

/** 外壳视图服务挂载插件——常驻根上下文，先于首页 / ask 卡产物装载
 *  （SERVICE_PLUGINS 表序：内核 service 全部先于产物装载 ⇒ inject 依赖可解析）。 */
export const rootViewsServicePlugin = {
  name: 'hologram/composition-root-views',
  apply(ctx: Context) {
    new RootViewsService(ctx);
  },
};
