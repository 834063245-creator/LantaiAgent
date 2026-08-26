// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition/overlay-service — 画布覆盖层贡献通道（Stage-4 打孔：流区附着
// 渲染通道，canvas-space-model-notes.md §7 打孔清单② / stage-4 §5）。
//
// 原则二/三（插件化分层）：**空间内核 = 平台开放 API，上层形态 = 第一方
// 插件**。创作坞（底部）与目次带（右缘窄条）都是画布视口固定的上层形态，
// 以贡献行注册本通道，由 PaperPanel 在对应槽位渲染——核心只长「通道」，
// 不写具体形态。对齐 services.ts 的 register→Disposer 裸契约（调用方经
// ctx.effect 登记，所有权归调用方）。
//
// 槽位：
//   - 'composer'   —— 底部创作坞（视口固定输入条 + 设置行）；
//   - 'right-edge' —— 右缘窄条（目次带等卷内导航附件）。
// 组件渲染在 PaperPanel 内部（可经 paper/overlay-context 取派生流区数据）。

import type { ComponentType } from 'react';
import { type Context, Service } from '../cordis';

/** 覆盖层槽位。 */
export type OverlaySlot = 'composer' | 'right-edge';

/** 覆盖层贡献定义。 */
export interface OverlayContribution {
  id: string;
  slot: OverlaySlot;
  component: ComponentType;
}

/** 通用注册表（id 寻址 + Disposer + 重名拒绝——对齐四 service 语义）。 */
class OverlayRegistry {
  private entries = new Map<string, { def: OverlayContribution; dispose: () => void }>();
  private listeners = new Set<() => void>();

  private fireChange(): void {
    for (const cb of [...this.listeners]) cb();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  register(def: OverlayContribution): () => void {
    if (this.entries.has(def.id)) {
      throw new Error('[overlays] duplicate contribution id "' + def.id + '" —— 装载期拒绝，不静默覆盖');
    }
    let done = false;
    const entry = {
      def,
      dispose: () => {
        if (done) return;
        done = true;
        if (this.entries.get(def.id)?.def === def) {
          this.entries.delete(def.id);
          this.fireChange();
        }
      },
    };
    this.entries.set(def.id, entry);
    this.fireChange();
    return entry.dispose;
  }

  list(slot: OverlaySlot): OverlayContribution[] {
    const out: OverlayContribution[] = [];
    for (const { def } of this.entries.values()) {
      if (def.slot === slot) out.push(def);
    }
    return out;
  }
}

export class OverlayService extends Service {
  private registry = new OverlayRegistry();

  constructor(ctx: Context) {
    super(ctx, 'overlays');
    setActiveOverlays(this);
  }

  register(def: OverlayContribution): () => void {
    return this.registry.register(def);
  }

  list(slot: OverlaySlot): OverlayContribution[] {
    return this.registry.list(slot);
  }

  /** 订阅覆盖层贡献变更（register/dispose——PaperPanel 即时重取渲染面）。 */
  subscribe(cb: () => void): () => void {
    return this.registry.subscribe(cb);
  }
}

// ── 活动服务间接层（对齐 services.ts 的模块级单例读取面）──
// 模块级可变态归属 CONVENTIONS §1.10 第 3 类（键控自清理：单一键，进程生命周期）。

let _activeOverlays: OverlayService | null = null;

function setActiveOverlays(svc: OverlayService): void {
  _activeOverlays = svc;
}

/** 当前覆盖层贡献（无服务/无注册 = 空集——PaperPanel 渲染面合流点）。 */
export function activeOverlayContributions(slot: OverlaySlot): OverlayContribution[] {
  return _activeOverlays?.list(slot) ?? [];
}

/** 订阅覆盖层贡献变更（无服务 = 空退订；PaperPanel 挂载期调用，贡献热注册即时生效）。 */
export function subscribeOverlayContributions(cb: () => void): () => void {
  return _activeOverlays?.subscribe(cb) ?? (() => {});
}

// ── ctx 通道声明（对齐 space-service 的 augmentation）──

declare module '../cordis/context' {
  interface Context {
    /** 画布覆盖层通道（Stage-4）：创作坞/目次带等视口固定形态经此注册，
     *  由 PaperPanel 在对应槽位渲染。 */
    overlays: OverlayService;
  }
}

/** 覆盖层服务挂载插件——常驻根上下文，先于 compose-dock 等消费插件装载
 *  （loadBuiltinPlugins 表序：四 service → space → overlays → 形态插件）。 */
export const overlayServicePlugin = {
  name: 'hologram/composition-overlays',
  apply(ctx: Context) {
    new OverlayService(ctx);
  },
};
