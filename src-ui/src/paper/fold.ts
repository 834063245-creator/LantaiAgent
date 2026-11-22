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
//   - **资产块**（带 asset 元数据的块 —— 图版卡族）：**默认张开**（2026-10-08 用户
//     拍板 —— **显式规格变更**，撤销 2026-09-23 图版架批的「默认收起成一行签条」；
//     用户原话「默认折叠很奇怪」）。**仍可折叠**：点折叠行即收起长卡（折叠行 =
//     物类签 + 题名），但那不是默认态——默认态与来文/正文同族：内容留面。
//     历史注：收起态当年的理由是「架上已有一份收纳面，流里再摊一整张卡＝同一张图版
//     两处各一份（§9.5「流内配套」）」——该理由随本次拍板作废：流里那张 = **上下文
//     原位的一份**，架上签条 = **本卷收纳读数**，两处并存就是现行形态。
//     判据 = **块带 asset 元数据**（kind 是开放面，资产身份在 asset 上，不认 kind 名）；
//   - 其余 kind（来文/正文/抄录/拟策/贴黄——**未带 asset 元数据**的那些）不可折叠。
// 用户显式点开/收起写入壳层覆盖表（foldOv），覆盖默认——
// 状态翻转（running→done）自动收回的是「没有用户意志的默认态」。

import { displayToolName } from '../ui/tool-semantics';
import type { BlockKind, SourcedBlock } from './block-model';
import { codeCallsReadout } from './code-calls';
import { type CodeView, codeViewReadout } from './code-view';
import { type RhythmFamily, rhythmFamilyOfTool } from './grammar';
import { plateSignOf } from './plate-sign';
import { presentTool } from './tool-present';
import { codeSections, hasArgsToShow, toolDigest } from './tool-text';

/** 折叠行读数缓存（2026-10-29 语义投影层）。
 *  归属 = CONVENTIONS §1.10 第 3 类「键控自清理」：WeakMap 以 payload 对象为键，
 *  随块回收自动消失，无跨工作区所有权问题。命中判据用**字符串引用相等**
 *  （JS 字符串不可变，引用变了才是内容变了——长度戳会在「同长改写」时撒谎）。 */
const summaryCache = new WeakMap<object, { args?: string; output?: string; err?: string; summary?: string }>();

function toolSummaryOf(
  payload: object & { name?: string; args?: string; output?: string; err?: string },
): string | undefined {
  const hit = summaryCache.get(payload);
  if (hit && hit.args === payload.args && hit.output === payload.output && hit.err === payload.err) return hit.summary;
  const summary = presentTool({
    name: payload.name,
    args: payload.args,
    output: payload.output,
    err: payload.err,
  }).summary;
  summaryCache.set(payload, { args: payload.args, output: payload.output, err: payload.err, summary });
  return summary;
}

/** 可折叠 kind（渲染器与测量端共用判据）。
 *  `block` 缺省 = 只看 kind 面（非资产）；生产调用点一律传块——资产身份在
 *  `block.asset` 上，不看 kind 名（开放 kind 面）。
 *  **可折叠 ≠ 默认折叠**：资产（图版卡）自 2026-10-08 起默认张开，但仍可手动
 *  收起（见 defaultFolded）。 */
export function isFoldable(kind: BlockKind, block?: SourcedBlock): boolean {
  if (block?.asset != null) return true;
  return kind === 'reasoning' || kind === 'tool' || kind === 'code' || kind === 'toolgroup' || kind === 'subagent';
}

/** 默认折叠态：无用户覆盖时的规则面。 */
export function defaultFolded(kind: BlockKind, payload: unknown, block?: SourcedBlock): boolean {
  if (block?.asset != null) {
    // 资产（图版卡）：**默认张开**（2026-10-08 用户拍板「默认折叠很奇怪」）。
    // 折叠能力位保留——用户点折叠行即可收起长卡（写进覆盖表）。
    // 历史：2026-09-23 起此处返 `block.state !== 'pinned'`（默认收起），另给两条
    // 豁免（钉住态 / 活确认卡）。默认态翻成张开后两条豁免一并作废：张开的卡
    // 无所谓"豁免折叠"——保留它们只会让判据多两条读不出来的分支。
    return false;
  }
  if (kind === 'reasoning') return true;
  if (kind === 'toolgroup') {
    // 工具组默认收起（并发调用的杂乱面是折叠机制的主病灶，2026-08-30 用户报）；
    // 有子调用出错 = 自动展开（错误留面，同 tool/code 纪律）。
    const items = (payload as { items?: Array<{ status?: string }> }).items ?? [];
    return !items.some((i) => i.status === 'error');
  }
  if (kind === 'subagent') {
    // 子代理**帖**（2026-11-20 帖批；前身 2026-09-01 F4 组头）：默认收起——
    // 帖签 + 活体行已经说清「谁、在干什么、多久」，体（子 parts）按需展开。
    // 仍有三条**张开**的例外（可操作/出错的内容不可被折叠藏住）：
    //   ① 帖自身出错；② 帖内子调用出错；③ 子拟策待审批。
    const p = payload as {
      status?: string;
      items?: Array<{ type?: string; status?: string; _callback?: unknown }>;
    };
    if (p.status === 'error') return false;
    const items = p.items ?? [];
    const childErrored = items.some((i) => i.status === 'error');
    // 待批判据读**持久化的 status**（_callback 只是「本帧可点」的能力位，重载即丢）。
    // 只认回调 = 重载后的待批卡被当已决议，连同它的帖一起收起（卡片凭空消失）。
    const planPending = items.some((i) => i.type === 'plan' && (i.status === 'pending' || i._callback));
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

/** 紧凑计数（>1k 缩写，折叠行不放长数字）。
 *  2026-11-18 计数口径修正：旧实现 `(n/1000).toFixed(1)` 会把 9999 说成「10.0k」、
 *  `Math.round(n/1000)` 把 10499 说成「10k」——**四舍五入到整档 = 夸大**。现在一律
 *  **向下取整到显示精度**（9999 → 9.9k / 12345 → 12.3k）：读数永远不超过真实值。 */
function charLabel(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}k`;
  return `${(Math.floor(n / 100_000) / 10).toFixed(1)}M`;
}

/** 书写系统分类（折叠行读数用）。
 *  CJK 字面按「字」计；其余字母连续串按「词」计；数字串与标点按语境归桶。
 *  ⚠ 用 `for…of` 按**码点**遍历（代理对只算一个），这是与 `.length` 分道扬镳的关键。 */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
const WORD_CHAR = /[\p{L}\p{M}]/u;
const DIGIT_CHAR = /\p{N}/u;
/** 词内连接符：`fs_read` / `src/a.ts` / `v4-flash` / `2.0` 是**一个**英文块，不是几个词
 *  ——中文思考里夹的代码/路径不该把词数顶起来（2026-11-18 混排修正）。 */
const WORD_JOINER = /[_.\-/]/;
/** CJK 符号与标点 + 全角形式 + 中文弯引号：中文语境里它们算「字」（对齐 Word 字数口径）。 */
const CJK_PUNCT = /[\u3000-\u303F\uFF00-\uFFEF\u2018\u2019\u201C\u201D]/u;
const SYMBOL_CHAR = /\p{S}/u;

/** 文本规模普查：CJK 字 / 词 / 数字串 / CJK 标点 / 符号各多少。 */
function surveyText(text: string): {
  chars: number;
  words: number;
  digits: number;
  cjkPunct: number;
  symbols: number;
} {
  let chars = 0;
  let words = 0;
  let digits = 0;
  let cjkPunct = 0;
  let symbols = 0;
  let inWord = false;
  let inDigits = false;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) {
      chars += 1;
      inWord = false;
      inDigits = false;
      continue;
    }
    if (DIGIT_CHAR.test(ch)) {
      // 词内的数字（`v4` / `gpt-4`）不拆词：仍在同一个英文块里
      if (inWord) continue;
      if (!inDigits) {
        digits += 1;
        inDigits = true;
      }
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      if (!inWord) {
        words += 1;
        inWord = true;
      }
      inDigits = false;
      continue;
    }
    // 词/数字内的连接符不断词（见 WORD_JOINER 注释）
    if (WORD_JOINER.test(ch) && (inWord || inDigits)) continue;
    inWord = false;
    inDigits = false;
    if (CJK_PUNCT.test(ch)) cjkPunct += 1;
    else if (SYMBOL_CHAR.test(ch)) symbols += 1;
  }
  return { chars, words, digits, cjkPunct, symbols };
}

/** 文本规模读数 —— 「思考 N 字」的唯一出口（2026-11-18 计数口径修正）。
 *
 *  旧口径 = `text.length`（UTF-16 码元），三个病灶：
 *    ① **英文按字母算「字」**：214 字符的英文只有 40 来个词，却报「214 字」——
 *       读者会把 214 当成 214 个汉字的分量，实际差四五倍；
 *    ② emoji / 生僻字（CJK 扩展 B 起）是代理对，`.length` 一律算 2；
 *    ③ 中英混排只有一个混算数，但单位是错的（字母与汉字同等计价）。
 *  现行口径（2026-11-18 用户拍板「还是加一起吧，大概准就行」）：
 *    - 汉字/假名/谚文/注音 → 1「字」；CJK 标点与数字串在中文语境也算字
 *      （「第 3 步」= 3 字，「你好，世界！」= 6 字——对齐 Word「字数」口径）；
 *    - 拉丁/希腊/西里尔字母串 → 1「词」；`_ . - /` 连接的是同一个词
 *      （`src/paper/fold.ts` 算 1 个词，不是 4 个）；
 *    - **混排合并成一个数**：英文词按 {@link CJK_PER_WORD} 折成汉字当量后相加；
 *      单位取主导方——中文当量 ≥ 英文当量报「N 字」，否则报「N 词」；
 *    - 纯 emoji/符号 → 「N 符号」。
 *  折算系数是**阅读量的经验值**，不是精确换算（真要精确只有分词器算 token）；
 *  用户 2026-11-18 明示「大概准就行」——宁可少一个数，也不要两个数各报各的。 */
const CJK_PER_WORD = 1.5;

export function textScaleLabel(text: string): string {
  const s = surveyText(text);
  // 中文当量：汉字 + CJK 标点 + 数字串（数字串按一个字算）
  const cjkUnits = s.chars + s.cjkPunct + s.digits;
  const wordUnits = s.words;
  if (cjkUnits === 0 && wordUnits === 0) {
    return s.symbols > 0 ? `${charLabel(s.symbols)} 符号` : '0 字';
  }
  if (cjkUnits >= wordUnits * CJK_PER_WORD) {
    return `${charLabel(Math.round(cjkUnits + wordUnits * CJK_PER_WORD))} 字`;
  }
  return `${charLabel(Math.round(wordUnits + cjkUnits / CJK_PER_WORD))} 词`;
}

/** 折叠行文本上限（字符）。
 *  折叠行是**恒一行**的 10px mono 注记（几何 14px + 6px 下距，见 .pp-fold），超出本来
 *  由 CSS 省略号收尾。这里再给一层**硬上限**，防的是「脏数据把 DOM 文本撑到几千字符」：
 *  2026-10-29 实机回归——模型偶尔把整条命令塞进 args.action（真机 512 字符），折叠行
 *  长到 574 字符（≈3900px），`<button>` 按内容宽撑开盒子，整行文字冲出聊天流区。
 *  三层防线各司其职：displayToolName 拒收非法 action（源头）/ 本上限（文本）/
 *  .pp-fold 的 width:100% + ellipsis（版面）。 */
const FOLD_LABEL_MAX = 160;

/** 折叠行文案（折叠态报「有什么可展开」，展开态报「可收起」）。
 *  资产块（图版卡）出「物类签 + 题名」——与架上签条同一枚签、同一个语汇；
 *  `block` 缺省 = 非资产（旧调用面照旧走 kind 面文案）。 */
export function foldLabel(kind: BlockKind, payload: unknown, folded: boolean, block?: SourcedBlock): string {
  const label = foldLabelRaw(kind, payload, folded, block);
  return label.length > FOLD_LABEL_MAX ? `${label.slice(0, FOLD_LABEL_MAX - 1)}…` : label;
}

function foldLabelRaw(kind: BlockKind, payload: unknown, folded: boolean, block?: SourcedBlock): string {
  if (block?.asset != null) {
    // 题名取 asset.title（资产身份上的题名，不是 payload 里的业务字段）；空题名
    // 只出签——签恒在，不空着（同图版题签行的规则）。
    const sign = plateSignOf(kind);
    const title = (block.asset.title ?? '').replace(/\s+/g, ' ').trim();
    const name = title ? `${sign} ${title}` : sign;
    return folded ? `▸ ${name}` : `▾ 收起 ${name}`;
  }
  const p = payload as {
    text?: string;
    args?: string;
    code?: string;
    /** 程序体流式预览（code 块的 args 到齐前的那一段，见 paper/translate）。 */
    preview?: string;
    output?: string;
    err?: string;
    description?: string;
    label?: string;
    name?: string;
    status?: string;
    view?: CodeView;
    items?: Array<{ name?: string; args?: string; readOnly?: boolean; status?: string }>;
  };
  const outSuffix = (outputLen?: number): string => {
    // 程文块传入「段文本字数」（信封行 `── logs ──` 不计入内容——2026-09-19）。
    const out = (outputLen ?? p.output?.length ?? 0) + (p.err?.length ?? 0);
    return out > 0 ? ` · 输出 ${charLabel(out)} 字` : '';
  };
  if (kind === 'reasoning') {
    // 2026-11-18 计数口径修正：旧 `text.length` 把英文字母当「字」、emoji 算两个。
    // 读数出口 = `textScaleLabel`（按书写系统分「字 / 词 / 符号」）。
    return folded ? `▸ 思考 ${textScaleLabel(p.text ?? '')}` : '▾ 收起思考';
  }
  if (kind === 'tool') {
    // 2026-08-30 会话流专项：折叠行带「干了什么」（名字 + 参数目标摘要）——
    // 纯字数没有信息量，不展开不知道卡是什么。
    // 2026-10-29 语义投影层：名字走领域显示名（`fs(read)` 而不是 `fs`），读数走
    // presentTool 的 summary（「42 行」「9 处 · 1 文件」「17 个改动」）——折叠行是
    // 用户 95% 时间看到的那一行，读数比字数有用；无 summary 才回落字数。
    const who = p.name ? displayToolName(p.name, p.args) : p.label || '工具';
    if (!folded) return `▾ 收起 ${who}`;
    // F1（2026-09-01）：`{}` 骨架与空参数同判——都是「还没带东西来」
    if (!hasArgsToShow(p.args) && !p.output && !p.err) return `▸ ${who} · 待执行`;
    const digest = toolDigest(p.args ?? '');
    const summary = toolSummaryOf(p as object);
    return `▸ ${who}${digest ? ` ${digest}` : ''}${summary ? ` · ${summary}` : outSuffix()}`;
  }
  if (kind === 'code') {
    const who = p.description || '程序';
    if (!folded) return `▾ 收起 ${who}`;
    if (!p.code && !p.output && !p.err) {
      // 程序体还在流（2026-11-22 卷 165 后续）：这张卡折叠着、只有折叠行可见——
      // 报**已生成程序体的最新一行**（与夹注 foldPreviewLine 同款读法），用户看见的
      // 是「它正在写什么」，而不是一个静止的「待执行」。行高恒一行（FOLD_ROW_H），
      // 测高镜像零变化——这也是不另开预览行的原因（那要动测高，风险不成比例）。
      const tail = p.preview ? foldPreviewLine(p.preview) : '';
      return tail ? `▸ ${who} · 生成中 ${tail}` : `▸ ${who} · 待执行`;
    }
    // 结构化完成值（P5）：读数换成「表格 12×4」/「差分 +3 −2」——折叠行是用户
    // 95% 时间看到的那一行，行列/增删比字数有用（与脚注 summary 同一纪律）。
    // 程序内调用（2026-11-21 显形批）：折叠行先报「内调 N」——用户 95% 时间只
    // 看到这一行，「这条程序实际调了几次工具」比字数更能说明它干了什么。
    const calls = (p as { calls?: readonly { ok: boolean }[] }).calls;
    const callsRead = codeCallsReadout(calls as never);
    if (p.view) return `▸ ${who} · ${codeViewReadout(p.view)}${callsRead ? ` · ${callsRead}` : ''}`;
    const contentLen = codeSections(p.output).reduce((n, s) => n + s.raw.length, 0);
    const head = `▸ ${who}${outSuffix(contentLen)}`;
    return callsRead ? `${head} · ${callsRead}` : head;
  }
  if (kind === 'subagent') {
    // 子代理**帖**折叠行（2026-11-20 帖批）：这一行只报**身份与账**（描述 + 步数 +
    // 走秒 + 状态），**不报活体行**——「此刻在干什么」由帖签下面那条独立活体行说，
    // 两者不重复（旧实现把描述/段数/状态全挤在一行，一行读三件事，反而都读不清）。
    const raw = (p.description || '').replace(/\s+/g, ' ').trim() || '子代理';
    const desc = raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
    const step = (p as { step?: number }).step ?? 0;
    const mode = (p as { mode?: string }).mode;
    // 帖签前缀：承 = fork（继承上下文）/ 白 = fresh（白纸）——怎么派的是帖的身份之一
    const mark = mode === 'fresh' ? '白' : mode === 'fork' ? '承' : '';
    const head = `${desc}${mark ? ` · ${mark}` : ''}${step > 0 ? ` · ${step} 步` : ''}`;
    if (!folded) return `▾ 收起 ${head}`;
    const suffix = p.status === 'error' ? ' · 未办' : p.status === 'running' ? ' · 在办' : '';
    return `▸ ${head}${suffix}`;
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
