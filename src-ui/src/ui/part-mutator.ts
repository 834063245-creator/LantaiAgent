// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// part-mutator — AgentEvent → AssistantPart[] 变更的唯一真相源。
// 主 agent（chat-stream.ts）和子 agent（subagent-sink.ts）共用。
// 一个函数，一套实现 — 不再有漂移的重复代码。

import type { AgentEvent, AssetDeltaEventData, AssetEventData } from '../agent/agent-types';
import { EventKind } from '../agent/agent-types';
import type { AssistantPart, BlockPart } from './message-model';
import { findToolPart, lastTextPart } from './message-model';
import { resolveSemanticToolName } from './tool-semantics';

/**
 * 将一个 AgentEvent 应用到 parts 数组。原地变更。
 * 数组有变化时返回 true。
 *
 * 处理：Reasoning、Text、Message、ToolDispatch、ToolProgress、ToolResult、
 *       Asset（资产终值）、AssetDelta（资产增量）。
 * 不处理：TurnStarted、Usage、Notice、SessionChanged — 这些有显示特定的
 * 副作用，由调用方单独管理。
 */
export function applyEventToParts(parts: AssistantPart[], ev: AgentEvent): boolean {
  switch (ev.kind) {
    case EventKind.Reasoning:
      if (ev.text) {
        const last = parts.length > 0 ? parts[parts.length - 1] : null;
        if (last && last.type === 'reasoning') {
          last.text += ev.text;
        } else {
          parts.push({ type: 'reasoning', text: ev.text });
        }
        return true;
      }
      return false;

    case EventKind.Text:
      if (ev.text) {
        const last = lastTextPart(parts);
        if (last && !last.finalised) {
          last.text += ev.text;
        } else {
          parts.push({ type: 'text', text: ev.text, finalised: false });
        }
        return true;
      }
      return false;

    case EventKind.Message: {
      const lt = lastTextPart(parts);
      if (lt) lt.finalised = true;
      return true;
    }

    case EventKind.ToolDispatch:
      if (ev.tool) {
        const existing = findToolPart(parts, ev.tool.id);
        if (existing) {
          // Upsert：ToolCallStart + ToolCall 都发出同一 toolId 的
          // ToolDispatch — 第二个事件携带完整参数。
          existing.status = ev.tool.partial ? 'pending' : 'running';
          if (ev.tool.args && ev.tool.args.length > existing.args.length) {
            existing.args = ev.tool.args;
          }
          if (ev.tool.name) existing.name = ev.tool.name;
        } else {
          parts.push({
            type: 'tool',
            toolId: ev.tool.id,
            name: ev.tool.name,
            args: ev.tool.args || '',
            label: ev.tool.name,
            readOnly: ev.tool.read_only ?? false,
            status: ev.tool.partial ? 'pending' : 'running',
          });
        }
        return true;
      }
      return false;

    case EventKind.ToolProgress:
      if (ev.tool) {
        const tp = findToolPart(parts, ev.tool.id);
        if (tp) {
          tp.status = 'running';
          if (ev.tool.output) {
            // ponytail: 写入/编辑工具替换（预览内容随模型流式增长），
            // shell 工具追加（stdout 块累积）。
            // 工具收敛后 name 是领域名（fs/shell）— 归一化回旧语义名判断。
            const sem = resolveSemanticToolName(tp.name, tp.args);
            // fs 领域的流式输出只可能来自 ToolArgPreview（write/edit 参数预览）—
            // args 未流到时按领域名兜底为替换语义。
            const isWrite =
              sem === 'write_file' || sem === 'write_file_content' || sem === 'edit_file' || tp.name === 'fs';
            tp.output = isWrite ? ev.tool.output : (tp.output || '') + ev.tool.output;
          }
          return true;
        }
      }
      return false;

    case EventKind.ToolResult:
      if (ev.tool) {
        const tr = findToolPart(parts, ev.tool.id);
        if (tr) {
          tr.status = ev.tool.err ? 'error' : 'done';
          // ponytail: ToolResult 携带完整的最终输出。
          // 替换（非追加）— ToolProgress 已累积增量块，
          // ToolResult 发送权威的完整结果。
          if (!ev.tool.err) tr.output = ev.tool.output;
          if (ev.tool.err) {
            tr.err = ev.tool.err;
            tr.output = undefined;
          }
          tr.truncated = ev.tool.truncated;
          return true;
        }
        // 错误不静默：dispatch 卡片被跳过的调用（子 Agent spawn 由
        // SubAgentBlock 接管）若执行失败，补建错误卡片留痕 — 否则
        // spawn 失败在聊天流中完全不可见，无从 debug。
        // 成功结果不补卡（spawn 成功已有 SubAgentBlock）。
        if (ev.tool.err) {
          parts.push({
            type: 'tool',
            toolId: ev.tool.id,
            name: ev.tool.name,
            args: ev.tool.args || '',
            label: ev.tool.name,
            readOnly: ev.tool.read_only ?? false,
            status: 'error',
            err: ev.tool.err,
          });
          return true;
        }
      }
      return false;

    case EventKind.Asset:
      if (ev.asset) return applyAssetFinal(parts, ev.asset);
      return false;

    case EventKind.AssetDelta:
      if (ev.assetDelta) return applyAssetDelta(parts, ev.assetDelta);
      return false;

    default:
      return false;
  }
}

/* ── 资产块路由（协议 docs/plans/agent-asset-blocks.md §2.2/§2.3）── */

function applyAssetFinal(parts: AssistantPart[], asset: AssetEventData): boolean {
  const part: BlockPart = {
    type: 'block',
    assetId: asset.assetId,
    kind: asset.kind,
    presentation: asset.presentation ?? '',
    ...(asset.title !== undefined ? { title: asset.title } : {}),
    payload: asset.payload,
    finalised: true,
    // confirm 实时卡：决议回调随事件挂进 part（瞬态——重载后无回调 = 只读态）
    ...(asset.onResponse ? { _confirmCallback: asset.onResponse } : {}),
  };
  const idx = parts.findIndex((p) => p.type === 'block' && p.assetId === asset.assetId);
  if (idx >= 0) parts[idx] = part;
  else parts.push(part);
  return true;
}

function applyAssetDelta(parts: AssistantPart[], asset: AssetDeltaEventData): boolean {
  const idx = parts.findIndex((p) => p.type === 'block' && p.assetId === asset.assetId);
  if (idx < 0) {
    // 增量先于终值（流式）：建未 finalised 占位（presentation 未知 = ''，渲染层回落 default）
    parts.push({
      type: 'block',
      assetId: asset.assetId,
      kind: asset.kind,
      presentation: '',
      payload: asset.chunk,
      finalised: false,
    });
    return true;
  }
  const existing = parts[idx] as BlockPart;
  // 已 finalised 的块不再接受增量（协议顺序保证 delta 先于 final；防御性忽略）
  if (existing.finalised) return false;
  const prev = typeof existing.payload === 'string' ? existing.payload : '';
  existing.payload = prev + asset.chunk;
  return true;
}

/** 资产更新广播（WO-5/A7）：只更新**已存在**的 BlockPart（含 subagent 内嵌），
 *  不新增位置——update_asset 的“原位置换”语义。递归扫描使子 Agent 内的资产块同刷。 */
export function applyAssetUpdateToExistingParts(parts: AssistantPart[], asset: AssetEventData): boolean {
  let changed = false;
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.type === 'block' && p.assetId === asset.assetId) {
      parts[i] = {
        type: 'block',
        assetId: asset.assetId,
        kind: asset.kind,
        presentation: asset.presentation ?? '',
        ...(asset.title !== undefined ? { title: asset.title } : {}),
        payload: asset.payload,
        finalised: true,
        // 确认卡的活回调跨 update 存续（协议：update 只碰 payload/presentation；
        // 无回调的新事件顶掉表决入口 = 待决议卡按钮猝死）
        ...(p._confirmCallback ? { _confirmCallback: p._confirmCallback } : {}),
      };
      changed = true;
    } else if (p.type === 'subagent') {
      if (applyAssetUpdateToExistingParts(p.parts, asset)) changed = true;
    }
  }
  return changed;
}
