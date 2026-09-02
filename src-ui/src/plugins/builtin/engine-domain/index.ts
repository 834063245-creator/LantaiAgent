// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// hologram 域工具插件 · 真源产物（S3，plugin-bundle-retirement）。
// 动态工具 + dataflow 对——graphData 是装配期开关；loadHologramSchemas
// 动态面每装配刷新。一行贡献承载整族（动态名面装配期才知）。

import type { Context } from '../../../cordis';
import { agentInvoke, defineTool, graphExecute, loadHologramSchemas, mcpSchemaToTool, z } from './host';

/** hologram 域插件（①c ③ 变体）——graph/ops/lsp 动态工具 + dataflow 对：
 *  graphData 是装配期开关（缺帐行产出空集——实例缓存会锁死首装配的有无，
 *  noCache 每装配现判）；loadHologramSchemas 动态面每装配刷新。
 *  **动态名承载**：工具名面在装配期才知（引擎/mock schema 各异）——本族
 *  不走 per-tool 名清单，而是「一行贡献承载整族」（factory 返回 Tool[]，
 *  S4-4 乙的整组形态；名字集 = 当次装配的 schemas + dataflow 对）。 */
export const hologramDomainPlugin = {
  name: 'hologram/engine-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const dispose = ctx.tools.register({
        id: 'hologram/engine-domain/tools',
        noCache: true,
        factory: async (rowCtx) => {
          if (!rowCtx?.graphData) return []; // 缺帐 = 空集（原 if (graphData) 分支）
          const holoExec = async (name: string, args: Record<string, unknown>) => {
            const result = await graphExecute(name, args);
            return typeof result === 'string' ? result : JSON.stringify(result);
          };
          const schemas = await loadHologramSchemas();
          const tools = schemas.map((s) => mcpSchemaToTool(s, holoExec));
          tools.push(
            defineTool({
              name: 'dataflow_save',
              description: '保存数据流追踪结果到 .lantai/dataflow/，供面板查看和后续查询。',
              schema: z.object({
                query: z.string(),
                content: z.string(),
              }),
              execute: async (args) => {
                const r = await agentInvoke('dataflow_save', args);
                return r;
              },
            }),
          );
          tools.push(
            defineTool({
              name: 'dataflow_query',
              description: '查询已保存的数据流追踪结果。',
              schema: z.object({
                traceId: z.string().optional(),
                list: z.boolean().optional(),
              }),
              readOnly: true,
              execute: (args) => agentInvoke('dataflow_query', args),
            }),
          );
          return tools;
        },
      });
      return () => dispose();
    }, 'hologram-domain-tools');
  },
};

export default hologramDomainPlugin;
