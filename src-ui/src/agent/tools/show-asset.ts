// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// show-asset — Agent 资产块工具三件套（协议 docs/archive/agent-asset-blocks.md §2.5/§2.6）。
//
// 通道约定（streaming-executor 特判 assetChannel）：
//   - show_asset / update_asset 声明 assetChannel=true —— executor 预生成 assetId
//     注入 args._asset_id；工具的 onProgress chunk 路由为 AssetDelta 事件；execute
//     返回的 JSON 被解析为 Asset 终值事件（ToolDispatch/ToolResult 照常发——管道
//     审计完整，UI 工具卡承接过程、资产块承接产物）。
//   - 错误即导航：kind/presentation 校验失败一律 throw（报错信息带可用清单），
//     Agent 从错误里自纠，绝不静默降级（协议 §2.7）。

import { z } from 'zod';
import { assetKinds, generateAssetId, requireKind, requirePresentation, validatePayload } from '../asset-kinds';
import { type AssetRecord, getAsset, listAssets, upsertAsset } from '../asset-store';
import { waitForConfirm } from '../confirm-registry';
import type { Tool } from '../tool';
import { defineTool } from './define-tool';

const ASSET_CHUNK = 64;

/** 工具执行作用域（executor 注入的 _owner_id；缺省 '' 兜底单槽） */
function scopeOf(args: Record<string, unknown>): string {
  return typeof args._owner_id === 'string' ? args._owner_id : '';
}

/** 资产终值 JSON（executor 解析为 Asset 事件）；结构化 key 与协议 §2.3 AssetEventData 对齐 */
interface AssetToolOutput {
  assetId: string;
  kind: string;
  presentation: string;
  title?: string;
  payload: unknown;
}

/** 资产工具族（无状态——只依赖模块级 kind 注册表与 args meta）。 */
export function createAssetTools(): Tool[] {
  return [createShowAssetTool(), createUpdateAssetTool(), createListBlockKindsTool()];
}

export function createShowAssetTool(): Tool {
  return defineTool({
    name: 'show_asset',
    description:
      'Create a visual asset block in the conversation (chart/table/metric/graph/html...) rendered as a component. ' +
      'Use for any deliverable that benefits from spatial layout or needs to be referred/updated later ' +
      '(charts, tables, impact graphs, metric dashboards, SVG/HTML cards). ' +
      'The block enters the chat flow and can be pinned to the canvas by the user. ' +
      'Kinds and their payload schemas are listed by list_block_kinds; presentation selects the visual form ' +
      'within the kind white-list (omit for the default). ' +
      'Check list_block_kinds before your first call.',
    schema: z.object({
      kind: z.string().describe('资产语义 kind（list_block_kinds 可查全量与 schema）'),
      presentation: z.string().optional().describe('表现形态（kind 白名单内；缺省用默认表现）'),
      title: z.string().optional().describe('短标题（snake_case 风格，可作下载/引用名）'),
      payload: z.unknown().describe('资产数据（须为 JSON；纯数据，不含回调）'),
      stream: z.boolean().optional().describe('append 型 kind 可流式构建（终值仍以本调用为准）'),
    }),
    readOnly: true,
    assetChannel: true,
    execute: async (args, onProgress) => {
      const kind = args.kind;
      const def = requireKind(kind);
      const presentation = requirePresentation(def, args.presentation);
      // D1（2026-09-16）：payload 走向量校验——坏数据不入库（此前 payload 是
      // z.unknown()，任何形状都能过，坏形状直通渲染层塌成「数据不可用」死块）。
      // 例外：append 型 + stream + 字符串 payload 是**流式暂态**（既有设计：
      // 分段 onProgress 走 AssetDelta，终值 JSON 仍是权威替换）——不经结构化契约校验。
      const streamingText = args.stream === true && def.streamable === 'append' && typeof args.payload === 'string';
      if (!streamingText) {
        const payloadErr = validatePayload(def, args.payload);
        if (payloadErr) throw new Error(payloadErr);
      }
      // meta key（executor 注入）不在 schema 类型内——经 passthrough 透传，断言读取
      const injectedAssetId = (args as { _asset_id?: string })._asset_id;
      const assetId =
        typeof injectedAssetId === 'string' && injectedAssetId.length > 0 ? injectedAssetId : generateAssetId();
      const record: AssetRecord = {
        assetId,
        kind: def.id,
        presentation,
        ...(typeof args.title === 'string' && args.title.length > 0 ? { title: args.title } : {}),
        payload: args.payload,
        ts: Date.now(),
      };
      upsertAsset(scopeOf(args), record);

      // confirm kind：阻塞等待用户在卡上表决（executor 已预发卡；决议作为工具
      // 结果回传——plan 审批模式的资产化泛化）。无 UI 通道（嵌套/headless 未
      // 预发卡）立即 no_ui 放行，不空等超时。
      if (def.id === 'confirm') {
        const response = await waitForConfirm(assetId);
        const out: AssetToolOutput & { confirmResponse: typeof response } = {
          assetId,
          kind: def.id,
          presentation,
          ...(record.title ? { title: record.title } : {}),
          payload: args.payload,
          confirmResponse: response,
        };
        return JSON.stringify(out);
      }

      // append 型 + 字符串 payload + stream → 分段 onProgress（executor 路由为 AssetDelta，
      // 终端渐进渲染；以下返回的终值 JSON 仍是权威替换）
      if (args.stream === true && def.streamable === 'append' && typeof args.payload === 'string' && onProgress) {
        const text = args.payload as string;
        for (let i = 0; i < text.length; i += ASSET_CHUNK) {
          onProgress(text.slice(i, i + ASSET_CHUNK));
        }
      }

      const out: AssetToolOutput = {
        assetId,
        kind: def.id,
        presentation,
        ...(record.title ? { title: record.title } : {}),
        payload: args.payload,
      };
      return JSON.stringify(out);
    },
  });
}

export function createUpdateAssetTool(): Tool {
  return defineTool({
    name: 'update_asset',
    description:
      'Update an existing asset block in-place by assetId (payload/presentation replace; the block id and ' +
      'pin position keep unchanged — pinned copies update live). ' +
      'Rules: kind is NOT changeable (changing semantics means creating a new asset with show_asset); ' +
      'presentation is changeable (skin swap, within the same kind white-list). ' +
      'Errors name what went wrong and what to do instead.',
    schema: z.object({
      assetId: z.string().describe('资产 id（show_asset 返回）'),
      presentation: z.string().optional().describe('新表现形态（kind 白名单内；缺省保持原表现）'),
      payload: z.unknown().describe('新资产数据（纯 JSON；整体替换）'),
    }),
    readOnly: true,
    assetChannel: true,
    execute: async (args) => {
      const scope = scopeOf(args);
      const assetId = args.assetId;
      const existing = getAsset(scope, assetId);
      if (!existing) {
        const candidates = listAssets(scope)
          .map((a) => `${a.assetId} (${a.kind})`)
          .join('、');
        throw new Error(
          `资产 '${assetId}' 不存在于当前会话。` +
            (candidates ? `当前会话资产：${candidates}。` : '当前会话还没有任何资产。') +
            '新建用 show_asset；要确认 kind 与 payload 契约先用 list_block_kinds。',
        );
      }
      // kind 不可换：schema 不声明 kind，模型传了（passthrough 透传）就在这里拒绝并讲明规矩
      const requestedKind = (args as { kind?: string }).kind;
      if (typeof requestedKind === 'string' && requestedKind !== existing.kind) {
        throw new Error(
          `update_asset 不能更换 kind：'${assetId}' 的 kind 是 '${existing.kind}'（语义绑定身份）。` +
            `想产出 '${requestedKind}' 请用 show_asset 新建一个资产。`,
        );
      }
      const def = requireKind(existing.kind);
      const presentation = requirePresentation(
        def,
        typeof args.presentation === 'string' ? args.presentation : undefined,
      );
      // D1：update 同样走校验（否则可经 update 绕过 show 的闸门灌坏数据）
      const payloadErr = validatePayload(def, args.payload);
      if (payloadErr) throw new Error(payloadErr);
      const record: AssetRecord = {
        assetId: existing.assetId,
        kind: existing.kind,
        presentation,
        ...(existing.title ? { title: existing.title } : {}),
        payload: args.payload,
        ts: Date.now(),
      };
      upsertAsset(scope, record);
      const out: AssetToolOutput = {
        assetId: record.assetId,
        kind: record.kind,
        presentation,
        ...(record.title ? { title: record.title } : {}),
        payload: record.payload,
      };
      return JSON.stringify(out);
    },
  });
}

export function createListBlockKindsTool(): Tool {
  return defineTool({
    name: 'list_block_kinds',
    description:
      'List all available asset block kinds with their payload JSON Schema, presentation white-lists, ' +
      'and streaming mode. Call before show_asset to learn what you can generate and how the payload must ' +
      'be shaped; the list reflects the live registry (plugin-contributed kinds appear automatically).',
    schema: z.object({}),
    readOnly: true,
    execute: async () => {
      const kinds = assetKinds.list();
      if (kinds.length === 0) return '当前没有任何可用资产 kind。';
      const lines = kinds.map((k) => {
        const pres = [...k.presentations].join(' / ');
        return (
          `- ${k.id} [${k.streamable}]: ${k.description}\n` +
          `    表现: ${pres}（默认 ${k.defaultPresentation}）\n` +
          `    schema: ${JSON.stringify(k.schema)}\n`
        );
      });
      return (
        '可用资产 kind（' +
        kinds.length +
        ' 个）：\n' +
        lines.join('\n') +
        '\n规则：kind 决定语义（update 不可换 kind）；presentation 决定画法（kind 白名单内可选，缺省用默认）。'
      );
    },
  });
}
