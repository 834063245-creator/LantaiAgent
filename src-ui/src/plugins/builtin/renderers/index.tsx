// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 内置渲染器插件工厂（P1，first-party-hot-reload-plan）——资产表现原语
// （grid/chart/metric/media/graph/tree/html/form）从编译期 bundle 迁出：
// 同一份源码两个运行时形态（双走查）：
//
//   A. 编译期 bundle 域（BUILTIN_PLUGINS 表项，loader 直引本模块）：
//      行 id = `builtin/<kind>`（出厂兜底行，永远可用；测试直引此形态）。
//   B. 构建产物域（esbuild 编译 index.tsx → dist-plugins/builtin/renderers/
//      entry.js，随包携带 + Rust 资产通道回退磁盘装载）：
//      行 id = `plugin/hologram/renderers/<kind>`（插件行，与 A 同 kind
//      不同 id → resolveRenderer 后注册胜——磁盘行覆盖 bundle 行；
//      磁盘行卸载/失败 → bundle 行自动恢复）。
//
// 两种形态的切换由 esbuild `define` 注入：
//   - tsc/测试域：`process.env.LANTAI_RENDERER_ROW_PREFIX` 未定义 → 'builtin'；
//   - esbuild 产物域：define 注入 `"plugin/hologram/renderers"`。
//
// 组件本体在 components.tsx（唯一真源），其 import 的 renderer-host 经
// esbuild onResolve 重定向到 renderer-host.aliased.ts（宿主桥取用面）——
// 构建产物自包含（零裸 import）。

import type { Context } from '../../../cordis';
import { type AssetRendererKind, assetRendererComponents } from './components';

/** 行 id 前缀：bundle 域 'builtin'；产物域经 esbuild define 把
 *  `globalThis.__LANTAI_RENDERER_ROW_PREFIX__` 替换为 'plugin/hologram/renderers'。
 *  tsc/测试域该属性不存在 → undefined → 'builtin'（bundle 兜底语义）。 */
const ROW_PREFIX: string =
  ((globalThis as unknown as Record<string, string | undefined>).__LANTAI_RENDERER_ROW_PREFIX__ as
    | string
    | undefined) ?? 'builtin';

/** 内置渲染器插件对象（loader BUILTIN_PLUGINS 引用的第一方插件；
 * 产物域同一对象经 esbuild 编译后行 id 前缀不同）。 */
export const builtinRenderersPlugin = {
  name: 'hologram/renderers',
  // cordis 服务透出要求声明 inject——ctx.renderers 在装载时校验存在性，
  // 缺依赖服务 → 插件 error 记录（失败隔离）；renderers 是常驻服务必在。
  inject: ['renderers'],
  apply(ctx: Context) {
    const components = assetRendererComponents();
    for (const [kind, component] of Object.entries(components) as Array<
      [AssetRendererKind, (props: never) => unknown]
    >) {
      ctx.effect(
        () =>
          ctx.renderers.register({
            id: `${ROW_PREFIX}/${kind}`,
            kind,
            component: component as never,
          }),
        `builtin-renderers/${kind}`,
      );
    }
  },
};

export default builtinRenderersPlugin;
