// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/fold — 会话流折叠机制（2026-08-30 会话流渲染专项）。
//
// 缘起：夹注（reasoning）/ 脚注（tool）/ 程文（code）此前恒平铺——思考全文、
// 工具参数原始 JSON、执行输出全部进流，「信息非常杂乱」的直接根因。
// block-model 自走查弹起就给 reasoning 标注「可折叠语义」，此处补上机制。
//
// 折叠默认规则（状态派生 + 用户覆盖单字段）：
//   - 夹注：恒折叠（流里只留**最新一行**预览——折叠态随思考推进动态更新，
//     见 foldPreviewLine；展开读全文）；
//   - 脚注/程文：出错 = 展开（错误留面），其余（pending/running/done）=
//     折叠——完成即收。在跑信号由折叠行呼吸（pp-fold--busy）+ 走秒签
//     （行 Ns）承载，要看进度点折叠行显式展开（用户覆盖跨状态保持）。
//     2026-09-08 抽搐根治：此前 running 自动展开——读/查类快工具（fs
//     read、glob、search——无参数预览事件）在模型流参数期间死静折叠，
//     完整分发（running）与结果（done）近乎背靠背，展开只闪一帧，用户
//     看到的是「折叠→完成时展开→又折叠」的抽搐；与 toolgroup/subagent
//     组语义对齐（组内 running 子卡从不自动展开）后主灶消除；
//   - 其余 kind（来文/正文/抄录/拟策/贴黄）不可折叠。
// 用户显式点开/收起写入壳层覆盖表（foldOv），覆盖默认——
// 状态翻转（running→done）自动收回的是「没有用户意志的默认态」。

import type { BlockKind } from './block-model';
import { type RhythmFamily, rhythmFamilyOfTool } from './grammar';
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
    // 错误留面：error 恒展开；pending/running/done 恒折叠（2026-09-08
    // 抽搐根治——running 自动展开对快工具是折叠→闪开→折叠的主灶，详见
    // 文件头注；在跑可见性 = 折叠行呼吸 + 走秒签，点折叠行可显式展开）。
    return status !== 'error';
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
    items?: Array<{ name?: string; args?: string; readOnly?: boolean; status?: string }>;
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
    // 判别量摘要（stream-rhythm 刀4a）：压缩的是重复，不是信息——组头一行就能
    // 分辨「动了哪些文件 / 跑了什么命令」。按名分组，每组露前 3 个判别字段
    // （toolDigest：read_file 露路径 / shell 露命令；同判别值去重）；无判别
    // 字段（无参 / 流式半程）回退旧计数文案。判别值截 20 字：折叠行是 10px
    // mono 单行（FOLD_ROW_H 恒一行，测高镜像零变化），3 值 × 20 字在 640
    // 版心内放得下。
    const GROUP_DIGEST_MAX = 20;
    const groups = new Map<string, { count: number; digests: string[] }>();
    for (const it of items) {
      const n = it.name || 'tool';
      const g = groups.get(n) ?? { count: 0, digests: [] };
      g.count += 1;
      const d = toolDigest(it.args ?? '', GROUP_DIGEST_MAX);
      if (d && !g.digests.includes(d)) g.digests.push(d);
      groups.set(n, g);
    }
    const entries = [...groups.entries()];
    const detail =
      entries.length > 0
        ? ` · ${entries
            .slice(0, 3)
            .map(([n, g]) => {
              // 无判别字段：旧计数文案原样（×N 只在多枚时挂）
              if (g.digests.length === 0) return g.count > 1 ? `${n} ×${g.count}` : n;
              // 计数补位：只露部分判别值（截断 / 同值去重）时补 ×N，总账不失真
              const truncated = g.digests.length > 3;
              const countTag = truncated || g.count > g.digests.length ? ` ×${g.count}` : '';
              return `${n}${countTag} ${g.digests.slice(0, 3).join(' / ')}`;
            })
            .join(' · ')}${entries.length > 3 ? ` · 等 ${entries.length} 种` : ''}`
        : '';
    // 族签（stream-rhythm 刀5 D）：子项已表态族全同 → 前缀族字（读/写/验/落）
    // ——小字 mono 行里扫一眼读出阶段节奏；混族 / 无表态 → 维持「工具」旧文案
    // （B 按族切组后恒同族，混组只剩流式半程过渡态）。
    const FAMILY_ZH: Record<RhythmFamily, string> = { read: '读', write: '写', verify: '验', commit: '落' };
    let famZh: string | null = null;
    {
      let first: RhythmFamily | null = null;
      let uniform = true;
      for (const it of items) {
        if (typeof it?.name !== 'string') continue;
        const f = rhythmFamilyOfTool(it.name, typeof it.args === 'string' ? it.args : undefined, it.readOnly === true);
        if (f == null) continue;
        if (first == null) first = f;
        else if (f !== first) uniform = false;
      }
      if (first != null && uniform) famZh = FAMILY_ZH[first];
    }
    const who = famZh ?? '工具';
    return `▸ ${who} ×${items.length}${detail}${runningSuffix}`;
  }
  return '';
}

/** 夹注折叠预览：**最新一行**（2026-09-14 用户拍板改向）。
 *  折叠态要报「此刻在想什么」，思考是尾随生长的：旧行为取首个非空行 = 永远
 *  定格开头（折叠卡成了静态墓碑），改取末个非空行——流式每落一行预览即更新，
 *  收尾态读到的是结论而不是开场白。空行（流式行间断）跳过，全空返回空串。
 *  渲染侧单行截断（.pp-fold-preview nowrap + ellipsis），测量侧恒一行——
 *  取哪一行不影响测高。 */
export function foldPreviewLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim().length > 0) return line.trim();
  }
  return '';
}
