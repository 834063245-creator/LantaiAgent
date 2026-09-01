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
import { hasArgsToShow, toolDigest } from './tool-text';

/** 可折叠 kind（渲染器与测量端共用判据）。 */
export function isFoldable(kind: BlockKind): boolean {
  return kind === 'reasoning' || kind === 'tool' || kind === 'code' || kind === 'toolgroup' || kind === 'subagent';
}

/** 默认折叠态：无用户覆盖时的规则面。 */
export function defaultFolded(kind: BlockKind, payload: unknown): boolean {
  if (kind === 'reasoning') return true;
  if (kind === 'toolgroup') {
    // 工具组默认收起（并发调用的杂乱面是折叠机制的主病灶，2026-08-30 用户报）；
    // 有子调用出错 = 自动展开（错误留面，同 tool/code 纪律）。
    const items = (payload as { items?: Array<{ status?: string }> }).items ?? [];
    return !items.some((i) => i.status === 'error');
  }
  if (kind === 'subagent') {
    // 子代理组（2026-09-01 三轴审计 F4）：过程块收进组内，正文流只留组头一行。
    // 组内子调用出错 / 组自身出错 / 子拟策待审批（可操作卡不可被折叠藏住）= 张开。
    const p = payload as {
      status?: string;
      items?: Array<{ type?: string; status?: string; _callback?: unknown }>;
    };
    if (p.status === 'error') return false;
    const items = p.items ?? [];
    const childErrored = items.some((i) => i.status === 'error');
    const planPending = items.some((i) => i.type === 'plan' && i._callback);
    return !(childErrored || planPending);
  }
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

/** 折叠行文案：折叠态报「有什么可展开」（关键信息 + 字数量化），展开态报「可收起」。 */
export function foldLabel(kind: BlockKind, payload: unknown, folded: boolean): string {
  const p = payload as {
    text?: string;
    args?: string;
    code?: string;
    output?: string;
    err?: string;
    description?: string;
    label?: string;
    name?: string;
    status?: string;
    items?: Array<{ name?: string; status?: string }>;
  };
  const outSuffix = (): string => {
    const out = (p.output?.length ?? 0) + (p.err?.length ?? 0);
    return out > 0 ? ` · 输出 ${charLabel(out)} 字` : '';
  };
  if (kind === 'reasoning') {
    return folded ? `▸ 思考 ${charLabel(p.text?.length ?? 0)} 字` : '▾ 收起思考';
  }
  if (kind === 'tool') {
    // 2026-08-30 会话流专项：折叠行带「干了什么」（名字 + 参数目标摘要）——
    // 纯字数没有信息量，不展开不知道卡是什么。
    const who = p.label || p.name || '工具';
    if (!folded) return `▾ 收起 ${who}`;
    // F1（2026-09-01）：`{}` 骨架与空参数同判——都是「还没带东西来」
    if (!hasArgsToShow(p.args) && !p.output && !p.err) return `▸ ${who} · 待执行`;
    const digest = toolDigest(p.args ?? '');
    return `▸ ${who}${digest ? ` ${digest}` : ''}${outSuffix()}`;
  }
  if (kind === 'code') {
    const who = p.description || '程序';
    if (!folded) return `▾ 收起 ${who}`;
    if (!p.code && !p.output && !p.err) return `▸ ${who} · 待执行`;
    return `▸ ${who}${outSuffix()}`;
  }
  if (kind === 'subagent') {
    // 子代理组头（2026-09-01 F4）：描述即身份，段数量化；在跑/出错缀状态。
    const raw = (p.description || '').replace(/\s+/g, ' ').trim() || '子代理';
    const desc = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
    if (!folded) return `▾ 收起 ${desc}`;
    const n = (p.items as unknown[] | undefined)?.length ?? 0;
    const suffix = p.status === 'error' ? ' · 出错' : p.status === 'running' ? ' · 在跑' : '';
    return `▸ ${desc} · ${n} 段${suffix}`;
  }
  if (kind === 'toolgroup') {
    const items = p.items ?? [];
    const running = items.filter((i) => i.status === 'running' || i.status === 'pending').length;
    const runningSuffix = running > 0 ? ` · ${running} 在跑` : '';
    if (!folded) return `▾ 收起工具 ×${items.length}${runningSuffix}`;
    // 名字摘要：按出现序去重计数（≤3 种逐个列，更多折「等 N 种」）
    const counts = new Map<string, number>();
    for (const it of items) {
      const n = it.name || 'tool';
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const entries = [...counts.entries()];
    const detail =
      entries.length > 0
        ? ` · ${entries
            .slice(0, 3)
            .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
            .join(' · ')}${entries.length > 3 ? ` · 等 ${entries.length} 种` : ''}`
        : '';
    return `▸ 工具 ×${items.length}${detail}${runningSuffix}`;
  }
  return '';
}

/** 夹注折叠预览：首个非空行（流式中思考开头相对稳定，不做尾随）。 */
export function foldPreviewLine(text: string): string {
  const line = text.split('\n').find((s) => s.trim().length > 0);
  return line ?? '';
}
