// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层贡献通道内核（M1 收口，2026-09-14）——**全平台唯一的注册表实现**。
//
// 缘起（收口前实测）：平台有九条贡献通道（panels/commands/tools/llm/prompts/
// renderers/hooks/capabilities/overlays）加五个 seam provider 注册表（fs/shell/
// sessionPersistence/subagents/agentLoop，共 14 个 service），但「id 寻址 +
// 重名拒绝 + 幂等 disposer + 陈旧性守卫 + 贡献序清单」这套语义被实现了七遍——
// ContributionRegistry 一份（11 个 service 复用，**是本文件的直接前身**），
// 另有 RendererRegistry / PromptRegistry / HookContributionRegistry /
// CapabilityContributionRegistry / OverlayRegistry 五份手抄，且**成员集互不
// 相同**（有的没 get()，有的没变更通知，overlay 的订阅 API 形状自成一格）。
// 同一条通道语义六种接口 = 改一次生效时机要改七处、读一条通道的时序要读七份
// 文件头。反讽的是那五份手抄的文件头都写着「简单复制更诚实」——而同一时期
// fs/shell/sessionPersistence/subagents 四个 seam 正在复用共享内核，理由已被
// 自己人证伪。本文件是那个「一处」。
//
// 边界（刻意不收编的）：`agent/asset-kinds.ts` 的 AssetKindRegistry 外形近似
// 但**不是**贡献通道——它在 agent 层（低层，不得反向依赖 composition），
// 无 ctx/Service/fiber 生命周期，注册面是资产 kind 而非插件行。形状近似不等于
// 同一概念，收它会造出向上依赖。
// 本文件是那个「一处」——收口后的不变量：
//   - **一种行身份**：`id`（string，npm scope 风格 '<插件名>/<行名>'）。历史上
//     capabilities 通道叫 `key`——本版统一为 `id`，别名不再保留。
//   - **一种生命周期**：register(def) → Disposer；disposer 幂等 + 陈旧性守卫
//     （同 def 对象重注册后，旧 disposer 的二次调用不误删新行）；重名装载期
//     throw（「错误不静默」宪法——不静默覆盖）。
//   - **一种生效时机**：timing 是**声明式数据**，不再是「构造时传没传回调」的
//     隐式后果。历史上读一条通道什么时候生效只能读它的文件头注释。
//   - **一种变更通知**：subscribe(cb)（消费侧运行期订阅）+ 构造期 onChanged
//     （通道级装载期挂点）。两者都在 register/dispose 后触发。
//
// 生效时机四档（timing）——语义由**消费方**实现，本文件不实现任何生效逻辑：
//   - 'immediate'     注册/注销即重取清单（React 常驻面：panels/commands/
//                     overlays/renderers）。通常经 onChanged bump 信号 store。
//   - 'next-assembly' 下次 Agent 装配生效，在途会话冻结（KV-cache 纪律：
//                     tools/prompts/hooks/capabilities）。变更即「组合输入变更」
//                     ——preset-assembly 的组合 cache 代数失效 + bootShell 重应用。
//   - 'request'       请求期解析（llm adapter 方言 + fs/shell/sessionPersistence/
//                     subagents/agentLoop 等 seam provider 的「后注册胜」扫描）。
//   - 'frame'         渲染期每帧重取（renderers 的 resolveRenderer）。
//
// 宪法定位（composition-architecture README「内核线」第 3 条）：注册表本身是
// 特权代码，永不插件化——本文件在内核线内。通道只做注册与注销（行生命周期的
// 锚点），不做任何业务：面板渲染、命令分发、工具执行都在各自既有实现。

/** 贡献生效时机（四档闭集——未知档位是编程错误，不是运行时数据）。 */
export type ContributionTiming = 'immediate' | 'next-assembly' | 'request' | 'frame';

/** 通道构造选项。 */
export interface ContributionChannelOptions<Def> {
  /** 生效时机（声明式——见文件头四档语义）。 */
  timing: ContributionTiming;
  /** 装载期形状校验：外部插件是纯 JS（无 tsc），畸形贡献须在装载期拒绝，不
   *  潜伏到消费期 TypeError（loader 的 isPluginShape 同款先例）。抛错即拒绝注册。 */
  validate?: (def: Def) => void;
  /** 通道级变更钩子（register/dispose 后调用）——装载期一次性挂点：面板/命令
   *  bump 信号 store、tools/prompts/capabilities 触发组合输入变更监听。
   *  消费侧运行期订阅走 subscribe()。 */
  onChanged?: () => void;
}

/**
 * 贡献通道——id 寻址的行注册表。
 *
 * 组合序 = 注册序（数组序）；前缀缓存语义依赖此序（S1 设计件 §2.1）。
 * 所有权登记是**调用方纪律**（vendored cordis 不提供运行时 caller-fiber 追踪）：
 * register 返回裸 Disposer，调用方负责挂 ctx.effect（对齐 agent 工具面
 * ToolRegistry.register 的契约）。
 */
export class ContributionChannel<Def extends { id: string }> {
  private readonly entries = new Map<string, { def: Def; dispose: () => void }>();
  private readonly listeners = new Set<() => void>();

  constructor(
    /** 通道名（错误信息前缀 + 目录/文档寻址用；全平台唯一）。 */
    readonly kind: string,
    private readonly options: ContributionChannelOptions<Def>,
  ) {}

  /** 生效时机（声明式读取面——守卫测试与目录生成器消费）。 */
  get timing(): ContributionTiming {
    return this.options.timing;
  }

  /** 注册一行贡献，返回其所有权 Disposer（幂等 + 陈旧性守卫）。 */
  register(def: Def): () => void {
    this.options.validate?.(def);
    if (this.entries.has(def.id)) {
      throw new Error('[' + this.kind + '] duplicate contribution id "' + def.id + '" —— 装载期拒绝，不静默覆盖');
    }
    let done = false;
    const entry = {
      def,
      dispose: () => {
        // 一次性守卫 + 陈旧性守卫：done 保证幂等；同 id 换 def 重注册后，
        // 陈旧 disposer 的二次调用不误删新行。
        if (done) return;
        done = true;
        if (this.entries.get(def.id)?.def === def) {
          this.entries.delete(def.id);
          this.notify();
        }
      },
    };
    this.entries.set(def.id, entry);
    this.notify();
    return entry.dispose;
  }

  get(id: string): Def | undefined {
    return this.entries.get(id)?.def;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 组合序 = 注册序（数组序）。 */
  list(): Def[] {
    return [...this.entries.values()].map((e) => e.def);
  }

  /** 条件清单（槽位/类型等通道内维度过滤——overlay 的 slot 面、renderer 的 kind 面）。 */
  filter(pred: (def: Def) => boolean): Def[] {
    return this.list().filter(pred);
  }

  /** 订阅贡献变更（register/dispose）。返回退订函数。 */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb();
    this.options.onChanged?.();
  }
}
