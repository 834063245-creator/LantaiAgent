// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层第六 service —— system-prompt 段落贡献注册表（P4 通道 A-1，
// agent-plugin-architecture-plan §5：「插件注系统提示段落」）。
//
// 契约对齐 renderer-service（第五通道先例）与四 service（S1-1）：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖）；
//   - disposer 幂等 + 陈旧性守卫（同 def 重注册后旧 disposer 不误删新行）；
//   - 无即时信号：prompt 只在 Agent 装配期消费（assembleSystemPrompt），没有
//     React 常驻清单缓存，不需要 bump 信号 store。
//
// 生效时机 = 下次 Agent 装配（新会话）——system prompt 在会话创建时点拼装，
// 在途会话保持创建时点的段落面不变（KV-cache 纪律，同 tools 通道 §7）。
//
// 组合解析域（S4-4 甲，2026-08-23）：贡献段进 roster 寻址域——
// factoryComposition() 的 prompt 域快照当前贡献清单（同 tools 通道的
// pluginToolRows 折算行）；patch/preset 可 disable/text 覆盖/锚定贡献段
// id（A-1 时代「贡献恒追加在解析产物末尾、不进寻址域」的合流语义退役
// ——assembleSystemPrompt 见 prompt-sections.ts）。贡献 register/dispose
// 因此成为组合输入变更——onPromptContributionsChanged 供 preset-assembly
// 的组合 cache 代数失效 + bootShell 的贡献监听重应用（无即时信号面：
// prompt 无 React 常驻清单，不需要 bump 信号 store）。

import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';
import type { PromptSection } from './prompt-sections';

/** prompt 段贡献：形状即 PromptSection（id 寻址 + 条件参与 + 文本渲染——
 *  render 产出含自身前导分隔符的完整文本，与内置段同一契约）。 */
export type PromptContribution = PromptSection;

// ── 贡献变更监听（S4-4 甲）──
// 与 tools 通道的 onToolContributionsChanged（services.ts）同款：register/
// dispose 时触发——贡献进组合解析域后，贡献变更 = 组合输入变更。
type PromptContributionsChangedListener = () => void;
const promptContributionListeners = new Set<PromptContributionsChangedListener>();

/** 订阅 prompt 段贡献变更（register/dispose）。返回退订函数。 */
export function onPromptContributionsChanged(cb: PromptContributionsChangedListener): () => void {
  promptContributionListeners.add(cb);
  return () => promptContributionListeners.delete(cb);
}

function firePromptContributionsChanged(): void {
  for (const cb of [...promptContributionListeners]) cb();
}

// ── 注册表内核（M1 收口：composition/contribution-channel 单一实现——
//    本文件不再自持类；timing='next-assembly' 声明在构造点）──

// ── service 本体 ──

export class PromptsService extends Service {
  private registry = new ContributionChannel<PromptContribution>('prompts', {
    timing: 'next-assembly',
    onChanged: firePromptContributionsChanged,
  });

  constructor(ctx: Context) {
    super(ctx, 'prompts');
    _activePrompts = this; // 消费闭环读取面（assembleSystemPrompt 末端追加）
  }

  register(def: PromptContribution): () => void {
    return this.registry.register(def);
  }

  get(id: string): PromptContribution | undefined {
    return this.registry.get(id);
  }

  list(): PromptContribution[] {
    return this.registry.list();
  }
}

// ── 消费闭环读取面（模块级活动服务——services.ts 同款第 3 类可变态：
//    单一键，生命周期 = 进程，服务构造期登记）──

let _activePrompts: PromptsService | null = null;

/** 当前 prompt 段贡献（无服务/无注册 = 空集——合流点读这个）。 */
export function activePromptContributions(): PromptContribution[] {
  return _activePrompts?.list() ?? [];
}

// ── 挂载插件（对齐 rendererServicePlugin；装载期在四 service 与 renderer
//    之后，同批 loadBuiltinPlugins 引导——段贡献插件 inject ['prompts']
//    依赖可解析）──

declare module '../cordis/context' {
  interface Context {
    /** system-prompt 段落注册表（A-1 第六贡献通道）——段注册 → disposer；
     *  下次 Agent 装配生效。 */
    prompts: PromptsService;
  }
}

export const promptsServicePlugin = {
  name: 'hologram/prompts-service',
  apply(ctx: Context) {
    const svc = new PromptsService(ctx);
    // 服务随根 fiber 常驻（app 生命周期，同四 service）。dispose 路径
    // （测试拆卸）守卫式清空活动指针：贡献直接进系统提示词（字节敏感面），
    // 读取面必须随服务生命周期归零——不残留陈旧注册污染后续拼装
    // （vitest 同 worker 模块态跨测试共享，残留即静默串味）。
    ctx.effect(
      () => () => {
        if (_activePrompts === svc) _activePrompts = null;
      },
      'prompts-active-clear',
    );
  },
};
