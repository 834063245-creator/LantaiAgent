// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具域贡献助手（S3 真源产物化，plugin-bundle-retirement）——
// 从 coding-domain-plugins.ts 机械迁出；纯函数零运行时依赖（类型导入
// 经 esbuild 擦除），各域产物 index.ts 经相对导入共享（esbuild 逐产物内联）。

import type { Tool, ToolExecutor } from '../../agent/tool';
import type { ToolContribution } from '../../composition/services';
import type { ToolRowContext } from '../../composition/tool-rows';
import type { Context } from '../../cordis';

/** apply 期名字展开用的占位 exec——族工厂是纯函数，exec 只在工具 execute
 *  闭包里被引用，apply 期永不执行；占位符抛错保证任何误执行立即可见。 */
const NEVER_EXEC: ToolExecutor = async () => {
  throw new Error('[contribution-helpers] apply 期占位 exec 不应被调用');
};

/** 域插件通用形状：ctx.tools.register 逐条 + disposer 逆序注销。 */
export function registerFamily(ctx: Context, tag: string, contributions: ToolContribution[]) {
  ctx.effect(() => {
    const disposers = contributions.map((c) => ctx.tools.register(c));
    return () => {
      for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
    };
  }, tag);
}

/** 注册一个无状态工具族为贡献清单：每工具一条贡献（id = `<插件名>/<工具名>`）。
 *  贡献 factory 惰性建族——首个贡献装配时以真实 rowCtx.codingExec 构建，
 *  同族贡献共享一次建族（apply 作用域闭包，非模块级态）。 */
export function familyContributions(pluginName: string, build: (exec: ToolExecutor) => Tool[]): ToolContribution[] {
  const names = build(NEVER_EXEC).map((t) => t.name());
  let family: Tool[] | null = null;
  return names.map((name) => ({
    id: `${pluginName}/${name}`,
    factory: (rowCtx) => {
      if (!rowCtx?.codingExec) {
        throw new Error(`[${pluginName}] 工具贡献 ${name} 需要装配上下文（codingExec）——折算路径未穿 rowCtx`);
      }
      family ??= build(rowCtx.codingExec);
      const tool = family.find((t) => t.name() === name);
      if (!tool) throw new Error(`[${pluginName}] 族内未找到工具 ${name} —— 族工厂输出漂移`);
      return tool;
    },
  }));
}

/** 注册一个装配期真值族为贡献清单（①c 无缓存行）：每工具一条 noCache 贡献
 *  ——factory 每装配重调（buildRow 每装配以当次 rowCtx 重建族），实例缓存
 *  对其不生效。buildRow 可为异步族（hologram 动态 schema 拉取）。
 *  names 必须显式给（族名序 = 声明序）——条件产出族（graphData 缺帐空集）
 *  无法无参展开取名，异步族 apply 期不展开。 */
export function noCacheContributions(
  pluginName: string,
  buildRow: (rowCtx: ToolRowContext) => Tool[] | Promise<Tool[]>,
  names: string[],
): ToolContribution[] {
  return names.map((name) => ({
    id: `${pluginName}/${name}`,
    noCache: true,
    factory: async (rowCtx) => {
      if (!rowCtx) {
        throw new Error(`[${pluginName}] 工具贡献 ${name} 需要装配上下文——折算路径未穿 rowCtx`);
      }
      const family = await buildRow(rowCtx);
      const tool = family.find((t) => t.name() === name);
      if (!tool) return []; // 装配期条件族缺帐：该行无产出（原行 if 分支空集语义）
      return tool;
    },
  }));
}
