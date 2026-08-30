// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/fold — 会话流折叠机制（2026-08-30 会话流渲染专项）。
//
// 缘起：夹注（reasoning）/ 脚注（tool）/ 程文（code）此前恒平铺——思考全文、
// 工具参数原始 JSON、执行输出全部进流，「信息非常杂乱」的直接根因。
// block-model 自走查弹起就给 reasoning 标注「可折叠语义」，此处补上机制。
//
// 折叠默认规则（状态派生 + 用户覆盖单字段）：
//   - 夹注：恒折叠（流里只留一行预览，展开读全文）；
//   - 脚注/程文：运行中/出错 = 展开（看得到在跑什么、错在哪），
//     其余（done/pending）= 折叠——完成即收，错误留面；
//   - 其余 kind（来文/正文/抄录/拟策/贴黄）不可折叠。
// 用户显式点开/收起写入壳层覆盖表（foldOv），覆盖默认——
// 状态翻转（running→done）自动收回的是「没有用户意志的默认态」。

import type { BlockKind } from './block-model';

/** 可折叠 kind（渲染器与测量端共用判据）。 */
export function isFoldable(kind: BlockKind): boolean {
  return kind === 'reasoning' || kind === 'tool' || kind === 'code';
}

/** 默认折叠态：无用户覆盖时的规则面。 */
export function defaultFolded(kind: BlockKind, payload: unknown): boolean {
  if (kind === 'reasoning') return true;
  if (kind === 'tool' || kind === 'code') {
    const status = (payload as { status?: string }).status;
    // 运行中/出错展开（过程与错误可见）；完成/待起折叠
    return status !== 'running' && status !== 'error';
  }
  return false;
}

/** 字数展示（>1k 缩写，折叠行不放长数字）。 */
function charLabel(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 折叠行文案：折叠态报「有什么可展开」（字数量化），展开态报「可收起」。 */
export function foldLabel(kind: BlockKind, payload: unknown, folded: boolean): string {
  const p = payload as { text?: string; args?: string; code?: string; output?: string; err?: string };
  const outSuffix = (): string => {
    const out = (p.output?.length ?? 0) + (p.err?.length ?? 0);
    return out > 0 ? ` · 输出 ${charLabel(out)} 字` : '';
  };
  if (kind === 'reasoning') {
    return folded ? `▸ 思考 ${charLabel(p.text?.length ?? 0)} 字` : '▾ 收起思考';
  }
  if (kind === 'tool') {
    if (!folded) return '▾ 收起调用';
    if (!p.args && !p.output && !p.err) return '▸ 待执行';
    return `▸ 参数 ${charLabel(p.args?.length ?? 0)} 字${outSuffix()}`;
  }
  if (kind === 'code') {
    if (!folded) return '▾ 收起程序';
    if (!p.code && !p.output && !p.err) return '▸ 待执行';
    return `▸ 程序 ${charLabel(p.code?.length ?? 0)} 字${outSuffix()}`;
  }
  return '';
}

/** 夹注折叠预览：首个非空行（流式中思考开头相对稳定，不做尾随）。 */
export function foldPreviewLine(text: string): string {
  const line = text.split('\n').find((s) => s.trim().length > 0);
  return line ?? '';
}
