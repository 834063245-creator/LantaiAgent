// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层第七 service —— 工具管道钩子贡献注册表（P4 通道 A-2，
// agent-plugin-architecture-plan §5：「插件参与工具管道（富化/门禁）」）。
//
// 贡献形状 = 既有 agent/hooks.ts 的两类钩子（形状零改写——插件贡献与
// capability 注册的是同一 Hook/PreflightHook 接口）：
//   - kind 'enrich'：post-tool 富化（HookRegistry.apply 串流——输出流过
//     各 hook，富化后文本进模型历史）；
//   - kind 'preflight'：pre-tool 预检（PreflightHookRegistry.check 聚合
//     ——警告注入结果顶部，含 HIGH 风险等级的嵌套调用拦截语义）。
//
// 契约对齐 prompt-service（A-1 先例）——注册表内核经 ContributionChannel 单一
// 实现（M1 收口）：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖）；
//   - disposer 幂等 + 陈旧性守卫（同 def 重注册后旧 disposer 不误删新行）；
//   - 无即时信号：钩子在 Agent 装配期消费（runtime 折叠进 per-Agent 的
//     HookRegistry/PreflightHookRegistry），没有 React 常驻清单缓存。
//
// 生效时机 = 下次 Agent 装配（新会话）——装配创建全新 registry，贡献
// 实例按当前通道清单逐个注册；在途会话保持创建时点的钩子面不变
// （KV-cache 纪律，同 tools/prompts 通道 §7）。贡献实例跨装配复用
// （贡献是插件注册的对象本体，无 factory 面——插件自担实例状态性；
// 与 tools 通道的实例缓存语义天然一致）。
//
// 装配序（runtime._assembleAgent）：capability 钩子先注册（state-hooks/
// board-tracking 等第一方面），通道贡献随后——与 tools 域「builtin 行在
// 前、贡献行随后」同序约定；enrich 链中后注册的 hook 看到已富化的输出，
// preflight 聚合序同理。子 Agent 不自动继承（spawnSubAgent 手工建
// registry 只挂 board-tracking——与 state-hooks 不下放子 Agent 的既有
// 语义一致；插件钩子要下放属后续扩展）。
//
// 组合解析域：钩子贡献**不进** roster 寻址域（四域行模型不含 hooks 域
// ——工具/段的寻址扩展是 S4-4 甲的事，钩子寻址无既定需求，不做预防性
// 扩展；卸载/禁用整个插件走插件开关）。

import type { Hook, PreflightHook } from '../agent/hooks';
import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';

/** 管道钩子贡献：enrich（post-tool 富化）| preflight（pre-tool 预检）。
 *  id 约定 '<插件名>/<钩子名>'（npm scope 风格——跨插件防撞名）。
 *  hook.name 是运行时日志/降级报错用名（HookRegistry 既有字段）。 */
export type HookContribution =
  | { id: string; kind: 'enrich'; hook: Hook }
  | { id: string; kind: 'preflight'; hook: PreflightHook };

// ── 注册表内核（M1 收口：composition/contribution-channel 单一实现——
//    本文件不再自持类；timing='next-assembly' 声明在构造点）──
//    注：本通道无 onChanged 挂点（钩子贡献不进 roster 寻址域、无组合 cache
//    消费面——见上「组合解析域」段），这是**声明式事实**而非缺省遗漏：内核
//    的 onChanged 是可选项，与四 service 的 panels/commands 逐字同构。 ──

// ── service 本体 ──

export class HooksService extends Service {
  private registry = new ContributionChannel<HookContribution>('hooks', { timing: 'next-assembly' });

  constructor(ctx: Context) {
    super(ctx, 'hooks');
    _activeHooks = this; // 消费闭环读取面（runtime 装配折叠）
  }

  register(def: HookContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): HookContribution | undefined {
    return this.registry.get(id);
  }

  list(): HookContribution[] {
    return this.registry.list();
  }
}

// ── 消费闭环读取面（模块级活动服务——services.ts 同款第 3 类可变态：
//    单一键，生命周期 = 进程，服务构造期登记）──

let _activeHooks: HooksService | null = null;

/** 当前管道钩子贡献（无服务/无注册 = 空集——runtime 装配折叠读这个）。 */
export function activeHookContributions(): HookContribution[] {
  return _activeHooks?.list() ?? [];
}

// ── 组合层挂载插件（根 Context 装载；经 loadBuiltinPlugins 引导）──

declare module '../cordis/context' {
  interface Context {
    /** 工具管道钩子注册表（A-2）——enrich/preflight 贡献注册 → disposer；
     *  下次 Agent 装配生效语义。 */
    hooks: HooksService;
  }
}

/** 内核线实体化：钩子贡献注册表常驻根上下文，先于外部插件装载。 */
export const hooksServicePlugin = {
  name: 'hologram/hook-services',
  apply(ctx: Context) {
    const svc = new HooksService(ctx);
    // 服务随根 fiber 常驻（app 生命周期）。dispose 路径（测试拆卸）守卫式
    // 清空活动指针：贡献直接进工具管道（executor 消费面），读取面必须随
    // 服务生命周期归零——不残留陈旧注册污染后续装配（vitest 同 worker
    // 模块态跨测试共享，残留即静默串味；prompt-service 同款纪律）。
    ctx.effect(
      () => () => {
        if (_activeHooks === svc) _activeHooks = null;
      },
      'hooks-active-clear',
    );
  },
};
