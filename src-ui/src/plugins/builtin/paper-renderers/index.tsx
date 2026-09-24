// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 纸面块渲染器产物（批 8b，2026-09-25）——纸壳（PaperPanel）默认渲染面的十一 kind 全谱
// + `'*'` 兜底 JSON，**从内核搬进产物**（原 `app/paper/builtin-renderers.tsx`，
// 注册点原在内核 `composition/renderer-service.tsx` 的 `rendererServicePlugin`）。
//
// 双走查（同 `renderers` 产物先例）：
//   A. 编译期 bundle 域（dev/test：`factory-products.ts` 直引本模块）：
//      行 id = `builtin/<kind>`（出厂兜底行，永远可用；测试直引此形态）；
//   B. 构建产物域（esbuild → `dist-plugins/builtin/hologram/paper-renderers/entry.js`）：
//      行 id = `plugin/hologram/paper-renderers/<kind>`（与 A 同 kind 不同 id ⇒
//      resolveRenderer 后注册胜——磁盘行覆盖 bundle 行）。
//   前缀由 esbuild `define` 注入（名册 `define` 字段，同 renderers 的 ROW_PREFIX 机制）。
//
// **不可禁用**（名册 `required: true`）：十一 kind 是纸壳默认渲染面，禁用它等于纸壳裸奔
// ⇒ 设置页不出禁用开关、loader 两条禁用路径直接跳过（§4-1 裁定 A）。
//
// 注册面两件：
//   ① `ctx.renderers`（第五贡献通道）——十一 kind + `'*'` 兜底；
//   ② `registerMarkdownBody`（内核登记表 `paper/markdown-body-seam.ts`）——markdown 体渲染
//      是跨产物复用面（`renderers` 产物的 ipynb / markdown-doc 查看器复用同一份解析）。

import type { Context } from '../../../cordis';
import { registerMarkdownBody } from '../../../paper/markdown-body-seam';
import { builtinRendererDefs, JsonBody, MarkdownBody } from './renderers';

/** 行 id 前缀：bundle 域 'builtin'；产物域经 esbuild define 替换
 *  `globalThis.__LANTAI_PAPER_RENDERER_ROW_PREFIX__` 为 'plugin/hologram/paper-renderers'
 *  （名册 `define` 字段）。tsc/测试域该属性不存在 → undefined → 'builtin'。 */
const ROW_PREFIX: string =
  ((globalThis as unknown as Record<string, string | undefined>).__LANTAI_PAPER_RENDERER_ROW_PREFIX__ as
    | string
    | undefined) ?? 'builtin';

/** 纸面块渲染器插件对象（名册条目 `paper-renderers`；required 产物）。 */
export const paperRenderersPlugin = {
  name: 'hologram/paper-renderers',
  // ctx.renderers 在装载时校验存在性（缺依赖 → 插件 error 记录，失败隔离）；它是常驻服务必在。
  inject: ['renderers'],
  apply(ctx: Context) {
    for (const def of builtinRendererDefs()) {
      ctx.effect(
        () => ctx.renderers.register({ id: `${ROW_PREFIX}/${def.kind}`, kind: def.kind, component: def.component }),
        `paper-renderers/${def.kind}`,
      );
    }
    // '*' 兜底行：未知 / 资产 kind 未接表现原语时显示漂亮 JSON（WO-4）——
    // 不并入 builtinRendererDefs()，保持「十一 kind 全谱」的既有契约面。
    ctx.effect(
      () => ctx.renderers.register({ id: `${ROW_PREFIX}/*`, kind: '*', component: JsonBody }),
      'paper-renderers/fallback',
    );
    // markdown 体渲染复用面（内核登记表；renderers 产物的两个重查看器撤 heavy 后取其用）。
    ctx.effect(() => registerMarkdownBody(MarkdownBody), 'paper-renderers/markdown-body');
  },
};

export default paperRenderersPlugin;
