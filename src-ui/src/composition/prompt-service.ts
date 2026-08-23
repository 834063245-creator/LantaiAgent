// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层第六 service —— system-prompt 段落贡献注册表（P4 通道 A-1，
// agent-plugin-architecture-plan §5：「插件注系统提示段落」）。
//
// 契约对齐 renderer-service（第五通道先例）与四 service（S1-1）：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖）；
//   - disposer 幂等 + 陈旧性守卫（同 def 重注册后旧 disposer 不误删新行）；
//   - 无即时信号：prompt 只在 Agent 装配期消费（assembleSystemPrompt 末端
//     追加），没有 React 常驻清单缓存，不需要 bump 信号 store。
//
// 生效时机 = 下次 Agent 装配（新会话）——system prompt 在会话创建时点拼装，
// 在途会话保持创建时点的段落面不变（KV-cache 纪律，同 tools 通道 §7）。
//
// 组合解析域边界（同 tools 通道现状）：贡献段追加在解析产物（出厂表或
// roster 解析表）之后，不进 roster 寻址域——patch/preset 不能禁用/覆盖
// 贡献段（S4-4 机器桥批的扩展点，届时再纳入）。

import { type Context, Service } from '../cordis';
import type { PromptSection } from './prompt-sections';

/** prompt 段贡献：形状即 PromptSection（id 寻址 + 条件参与 + 文本渲染——
 *  render 产出含自身前导分隔符的完整文本，与内置段同一契约）。 */
export type PromptContribution = PromptSection;

// ── 注册表内核（renderer-service 同款单文件自持；不导出公共类——
//    各 service 的通用内核是内核线内部复用，跨文件再抽公共会耦合两处
//    内核，简单复制更诚实）──

class PromptRegistry {
  private entries = new Map<string, { def: PromptContribution; dispose: () => void }>();

  register(def: PromptContribution): () => void {
    if (this.entries.has(def.id)) {
      throw new Error('[prompts] duplicate contribution id "' + def.id + '" —— 装载期拒绝，不静默覆盖');
    }
    let done = false;
    const entry = {
      def,
      dispose: () => {
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

  get(id: string): PromptContribution | undefined {
    return this.entries.get(id)?.def;
  }

  /** 组合序 = 注册序（追加序——前缀缓存语义依赖此序）。 */
  list(): PromptContribution[] {
    return [...this.entries.values()].map((e) => e.def);
  }
}

// ── service 本体 ──

export class PromptsService extends Service {
  private registry = new PromptRegistry();

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
