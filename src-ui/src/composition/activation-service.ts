// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 激活服务（S6 P3a）——ctx.activation：把 composition/activation.ts 的激活账
// 挂上根 Context，供插件面（apply 期声明）与装配面（Agent 装配期记账）消费。
//
// 为什么是 service 而不是复用 ctx.effect（用户 2026-09-15 裁定 A）：`ctx.effect`
// 是**所有权/拆卸**原语（INVARIANTS #12），既没有引用计数的表达力，也表达不了
// 「注册时机 ≠ 启动时机」；但**释放**必须复用它的对称性——装配面把 retain 得到
// 的句柄交给一个 ctx.effect disposer，Agent 拆卸即归零（见 runtime.ts 装配点）。
//
// 挂载位置：compositionServicesPlugin（组合层 service 本体，**不新增插件条目**
// ——first-party-manifest 的 `43 = 13 + 30` 计数与手册文案因此不动）。
//
// 服务面只是转发 + 装配期单点（retainForComposition）：账本体的键控注册表与
// no-op 缺省语义全部在 activation.ts（叶模块，零项目内运行时 import）。

import type { Context } from '../cordis';
import { Service } from '../cordis';
import {
  type ActivationConflict,
  type ActivationHandle,
  type ActivationSkip,
  type ActivationSpec,
  type ActivationState,
  activationClaims,
  activationConflict,
  activationDeclared,
  activationFailure,
  activationPlan,
  activationSkipped,
  activationStates,
  type CompositionActivationInput,
  declareActivation,
  declaredActivations,
  releaseActivations,
  retainActivation,
} from './activation';

export class ActivationService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'activation');
  }

  /** 登记激活声明（插件在 apply 里调用；**只登记**，不启动副作用）。 */
  declare(plugin: string, spec: ActivationSpec): () => void {
    return declareActivation(plugin, spec);
  }

  /** 已声明激活的插件名清单（装载期校验 / 诊断面）。 */
  declared(): string[] {
    return declaredActivations();
  }

  /** 该插件是否声明过激活（loader 的「声明-接线对齐」校验消费面）。 */
  has(plugin: string): boolean {
    return activationDeclared(plugin);
  }

  /** 本组合要激活的插件名清单（纯读）。 */
  planFor(comp: CompositionActivationInput | null | undefined): string[] {
    return activationPlan(comp);
  }

  /** 装配期记账：按组合激活（首次 → `start()`）。返回句柄数组——**调用方负责
   *  挂 ctx.effect 释放**（缺省 = 泄漏面）。未声明插件 ⇒ 空数组（no-op）。
   *
   *  **独占冲突 = 装配期 fail loud**（S6 P3b）：任一插件要的独占资源已被别的
   *  插件持有 ⇒ 本次记账**整体回滚**（已 retain 的先释放）后抛错——拒绝后装配者，
   *  先装配者不受影响（设计件 §3.5：冲突不在运行时静默降级）。 */
  async retainForComposition(
    comp: CompositionActivationInput | null | undefined,
    holder: string,
  ): Promise<ActivationHandle[]> {
    const handles: ActivationHandle[] = [];
    const exclusive = comp?.activationDecl?.exclusive ?? [];
    try {
      for (const plugin of activationPlan(comp)) {
        const h = await retainActivation(plugin, holder, exclusive);
        if (h) handles.push(h);
      }
    } catch (e) {
      await releaseActivations(handles); // 回滚本次已记账的部分（不泄漏句柄）
      throw e;
    }
    return handles;
  }

  /** 批量释放（交给一个 ctx.effect disposer）。 */
  releaseAll(handles: readonly ActivationHandle[]): Promise<void> {
    return releaseActivations(handles);
  }

  /** 激活账快照（诊断面）。 */
  states(): ActivationState[] {
    return activationStates();
  }

  /** 某插件上一次激活失败原因。 */
  failureOf(plugin: string): string | null {
    return activationFailure(plugin);
  }

  /** 诊断第四栏「被跳过」读面（S6 P3b）：激活失败 → 副作用未起的插件 + 原因。 */
  skipped(): ActivationSkip[] {
    return activationSkipped();
  }

  /** 上一次独占资源冲突（null = 无）。 */
  conflict(): ActivationConflict | null {
    return activationConflict();
  }

  /** 当前被持有的独占资源（资源名 → 持有它的插件）。 */
  heldExclusive(): Array<{ resource: string; plugin: string }> {
    return activationClaims();
  }
}

declare module '../cordis/context' {
  interface Context {
    /** 插件激活账（S6 P3a）——登记 ≠ 激活：组合装配期按插件引用计数，
     *  首次激活启动副作用、归零停止（设计件 §3.5）。 */
    activation: ActivationService;
  }
}
