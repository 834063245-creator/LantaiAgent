// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 工具声明桥（C11-1 工具声明可序列化，agent-plugin-architecture-plan §5
// 拍板 #5）—— zod ↔ manifest 双向桥接原语 + 装载器挂接面。
//
// 两个方向：
//   - manifest → 工具（declarationToTool）：数据声明（name/description/
//     parameters JSON Schema/readOnly）+ 执行函数 → Tool。第三方工具免编译
//     挂载的落点——声明是 manifest 数据，执行是 entry 模块 toolHandlers
//     命名导出的映射（插件无需触碰 ctx.tools——信任面更小，且装载期即知
//     工具面）。
//   - zod → manifest 数据（declarationOf）：任意 Tool（含 defineTool 的
//     zod 装置——parameters() 即 toInputJsonSchema 产物）序列化为同一数据
//     声明形状。自家工具清单数据化：第一方 zod 工具与第三方 manifest
//     工具在同一数据形状上对拍（DSH L1 compat 的映射零成本）。
//
// 声明形状与 DSH L1 契约同构（p4a-dsh-contract-notes §1.1：ToolSchema 三
// 字段 name/description/parameters——公共分母是可序列化 JSON Schema）。
//
// 挂接语义（mountToolDeclarations，loader 装载期调用）：
//   - 每条声明一条 ctx.tools 贡献（id `<插件名>/<工具名>`——折算行 id
//     `plugin/<插件名>/<工具名>`，S4-4 甲起 patch/preset 可寻址禁用）；
//   - 声明与实现一一对应：声明缺 handler / handler 未声明 / handler 非
//     函数 / 无 toolHandlers 导出 → throw（调用方记插件 error，失败隔离
//     ——all-or-nothing，「写了但什么都不发生」的字段是手误）；
//   - 实例缓存语义：数据 + 函数闭包无装配期依赖 → 不声明 noCache（首装配
//     锁存跨装配复用，与无状态族同款）；handler 自担实例状态性；
//   - disposer 挂 ctx.effect（插件 fiber dispose → 贡献全部注销——机器桥
//     同款生命周期纪律）。

import type { Tool } from '../agent/tool';
import type { Context } from '../cordis';
import type { ToolManifestDecl } from './types';

/** 运行时工具声明：数据面（模型面三字段 + readOnly）+ 执行函数。
 *  数据面即 manifest.tools 声明形状（ToolManifestDecl 的超集）。 */
export interface ToolDeclaration {
  name: string;
  description: string;
  /** 参数 JSON Schema（draft-7 object 形态）——数据，非 zod。 */
  parameters: Record<string, unknown>;
  /** 是否只读（可安全并行）；缺省 false。 */
  readOnly?: boolean;
  execute: (
    args: Record<string, unknown>,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal,
  ) => Promise<string>;
}

/** 声明 → Tool（manifest→工具方向）：数据形状直转，零 zod 参与。 */
export function declarationToTool(decl: ToolDeclaration): Tool {
  return {
    name: () => decl.name,
    description: () => decl.description,
    parameters: () => decl.parameters,
    readOnly: () => decl.readOnly ?? false,
    execute: (args, onProgress, signal) => decl.execute(args, onProgress, signal),
  };
}

/** Tool → 声明数据（zod→manifest 方向）：任意 Tool 序列化为数据声明
 *  （不含 execute——序列化面）。defineTool 的 zod 工具经 parameters()
 *  （toInputJsonSchema 产物）天然产出同一形状。 */
export function declarationOf(tool: Tool): Omit<ToolDeclaration, 'execute'> {
  return {
    name: tool.name(),
    description: tool.description(),
    parameters: tool.parameters(),
    readOnly: tool.readOnly(),
  };
}

/** toolHandlers 映射形状（entry 模块命名导出：工具名 → 执行函数）。 */
export type ToolHandlerMap = Record<string, ToolDeclaration['execute']>;

/**
 * 挂接一个插件声明的全部工具（loader 装载期调用）。
 *
 * handlers 是 entry 模块的 `toolHandlers` 命名导出（unknown 进、形状守卫
 * 在内——外部插件是纯 JS 无 tsc）。任何失配即 throw（调用方把插件记
 * error，失败隔离）：无导出 / 声明缺 handler / handler 未声明 / 非
 * 函数形状。
 */
export function mountToolDeclarations(
  ctx: Context,
  pluginName: string,
  decls: ToolManifestDecl[],
  handlers: unknown,
): void {
  if (handlers == null || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new Error(
      `[${pluginName}] manifest 声明了 tools，但 entry 模块未导出 toolHandlers 映射` +
        '（export const toolHandlers = { "<工具名>": async (args) => … }）',
    );
  }
  const map = handlers as Record<string, unknown>;
  const declNames = new Set(decls.map((d) => d.name));
  for (const key of Object.keys(map)) {
    if (!declNames.has(key)) {
      throw new Error(
        `[${pluginName}] toolHandlers 含未声明的工具 "${key}"——声明与实现必须一一对应（manifest.tools 补声明或删多余 handler）`,
      );
    }
    if (typeof map[key] !== 'function') {
      throw new Error(`[${pluginName}] toolHandlers["${key}"] 必须是函数`);
    }
  }
  const missing = decls.filter((d) => typeof map[d.name] !== 'function').map((d) => d.name);
  if (missing.length > 0) {
    throw new Error(`[${pluginName}] 声明的工具缺 handler：${missing.join(', ')}——entry 模块 toolHandlers 映射补齐`);
  }
  ctx.effect(() => {
    const disposers = decls.map((d) =>
      ctx.tools.register({
        id: `${pluginName}/${d.name}`,
        factory: () => declarationToTool({ ...d, execute: map[d.name] as ToolDeclaration['execute'] }),
      }),
    );
    return () => {
      for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
    };
  }, `${pluginName}/tool-declarations`);
}
