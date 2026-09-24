// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/translate — 宿主侧块转译 v1（走查弹核心件）。
//
// 拍板决定（paper-shell README V3a「宿主侧块转译」+ R1 staging）：
//   现有 chat-stream（markdown + 工具事件）→ 语义块，**agent 层零改动**。
//   转译是纯函数：ChatMessage[] → SourcedBlock[]，输入是 ui/message-model
//   的既有类型，输出是 paper/block-model 的块。不做反向写回（走查弹只读消费 +
//   输入条转发 core.sendMessage，会话真相仍在消息 store——活引用语义 D-R2-3）。
//
// 转译规则（一条消息 → 0..n 块）：
//   UserMessage        → 1 块 user
//   NoticeMessage      → 1 块 notice
//   AssistantMessage   → parts 顺序映射：
//     reasoning → 1 块 reasoning
//     text      → 1 块 markdown
//     tool      → 1 块 tool（status/output 直映）
//     plan      → 1 块 plan
//     subagent  → 1 块组头 + 子 parts 块（组内折叠，F4 2026-09-01；
//                 组内 tool 子块不再被 groupToolRuns 二次成组——不建嵌套组）
// part → 块保持引用（source.part = part 对象）——外部改动可经消息
// version 信号触发重转译，块 id 按消息 id+part 索引稳定重建。

import type { AssistantMessage, ChatMessage, ToolCallPart, UserMessage } from '../ui/message-model';
import type { SourcedBlock } from './block-model';
import { createBlock, DEFAULT_BLOCK_WIDTH } from './block-model';
import { type RhythmFamily, rhythmFamilyOfBlock } from './grammar';

/** 稳定块 id：同一消息同一 part 在重转译后得到同一 id（React key 稳定 +
 *  钉住状态可跨转译保持——pinned 块按 id 续命）。 */
function partBlockId(messageId: string, partIndex: number): string {
  return `pb:${messageId}:${partIndex}`;
}

/** 用户块稍窄（视觉语义：对话流里用户话轮占次要宽度——布局层消费） */
export const USER_BLOCK_WIDTH = 560;

/** 夹注收窄至正文列宽约 86%（spec §1：夹注缩进列边——布局层居中消费） */
export const REASONING_BLOCK_WIDTH = Math.round(DEFAULT_BLOCK_WIDTH * 0.86);

interface TranslateOpts {
  /** 钉住状态续命表：id → pinned 坐标（重转译时保持已钉块不回flow）。
   *  w（P2b 宽度手调）：pin.w 是钉住几何唯一真相——命中即覆盖块宽。 */
  pinnedPositions?: ReadonlyMap<string, { x: number; y: number; w?: number }>;
}

/** 钉住续命投影：flow 块 + pin 坐标 → pinned 块（pin.w 有值时覆盖块宽）。 */
function withPin(b: SourcedBlock, pos: { x: number; y: number; w?: number } | undefined): SourcedBlock {
  if (!pos) return b;
  return { ...b, state: 'pinned', x: pos.x, y: pos.y, ...(pos.w !== undefined ? { w: pos.w } : {}) };
}

/** 单条消息 → 块序列（纯函数，可无头测试；增量转译缓存的基本单元）。 */
export function translateMessage(
  msg: ChatMessage,
  pinned: ReadonlyMap<string, { x: number; y: number }> | undefined,
): SourcedBlock[] {
  const out: SourcedBlock[] = [];
  if (msg.role === 'user') {
    const b = translateUser(msg);
    out.push(withPin(b, pinned?.get(b.id)));
  } else if (msg.role === 'notice') {
    out.push(createBlock('notice', { text: msg.text, level: msg.level }, { messageId: msg._id, part: null }));
  } else {
    // F4（2026-09-01 三轴审计）：子代理组内子块登记进 skip 集——groupToolRuns
    // 不再把组内 tool 子块二次成组（不建嵌套组纪律），显式参数传递非共享状态。
    const subChildIds = new Set<string>();
    translateAssistantParts(msg, out, pinned, subChildIds);
    return groupToolRuns(out, msg._id, pinned, subChildIds);
  }
  return out;
}

/* ── 工具组（2026-08-30 会话流专项）：同轮并发调用的折叠头 ──
 * 用户报「edit、shell 并发好几个全平铺在聊天流里」。连续 ≥2 个工具块合成
 * 一个 toolgroup 头块 + 各自独立的子 tool 块：组头复用 fold 机制（默认收起、
 * 出错自动张开），壳层按折叠态把子卡从布局栈摘除（collapseToolGroups）。
 * 组头 id 锚在首个子卡 id 上（`${firstId}g`）——流式追加子卡组头 id 稳定，
 * 钉住续命与用户折叠覆盖（foldOv）都不漂。 */

/** 连续 flow 工具块运行 → 组头 + 子卡序列（run < 2 原样，不包组）。
 *  skipSubIds（F4 2026-09-01）：子代理组内 tool 子块已在组内，不重复成组。
 *  族切分（stream-rhythm 刀5 B）：连续工具按节律族切 run——读→写→验证是
 *  不同的工作行为，族变即断组（「读 ×3」「写 ×2」「验 ×1」各自成行，判别量
 *  各露各的，单元边界随之可见）；未表态族（other / 流式半程）并入当前 run
 *  不断组——不破语法铁律的组层延伸。 */
function groupToolRuns(
  blocks: SourcedBlock[],
  messageId: string,
  pinned: ReadonlyMap<string, { x: number; y: number; w?: number }> | undefined,
  skipSubIds?: ReadonlySet<string>,
): SourcedBlock[] {
  const out: SourcedBlock[] = [];
  let run: SourcedBlock[] = [];
  let runF: RhythmFamily | null = null; // 当前 run 的节律族（null = 未表态，混入不断组）
  const flush = (): void => {
    if (run.length >= 2) {
      const items = run.map((b) => b.source.part as ToolCallPart);
      const header = createBlock('toolgroup', { childIds: run.map((b) => b.id), items }, { messageId, part: items[0] });
      // 组头同样走钉住续命（用户把组头拖出流，重转译后钉态不丢）
      out.push(withPin({ ...header, id: `${run[0].id}g`, w: 640 }, pinned?.get(`${run[0].id}g`)));
    }
    out.push(...run);
    run = [];
    runF = null;
  };
  for (const b of blocks) {
    if (b.kind === 'tool' && b.state === 'flow' && !skipSubIds?.has(b.id)) {
      const f = rhythmFamilyOfBlock(b);
      if (runF != null && f != null && f !== runF) flush(); // 族变断组
      if (runF == null && f != null) runF = f; // 首个已表态成员定 run 族
      run.push(b);
    } else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
}

/** 工具组收起摘除（壳层消费）：折叠态组头的 flow 子卡不进布局栈——
 *  钉住子卡不摘（钉住态在世界层，与组收起无关）。
 *  subagent 组（F4 2026-09-01）同机制：组头折叠 = 子 parts 摘出布局栈。 */
export function collapseToolGroups(blocks: SourcedBlock[], isCollapsed: (b: SourcedBlock) => boolean): SourcedBlock[] {
  const hidden = new Set<string>();
  for (const b of blocks) {
    if ((b.kind !== 'toolgroup' && b.kind !== 'subagent') || !isCollapsed(b)) continue;
    for (const id of (b.payload as { childIds?: string[] }).childIds ?? []) hidden.add(id);
  }
  if (hidden.size === 0) return blocks;
  return blocks.filter((b) => !hidden.has(b.id) || b.state === 'pinned');
}

/** 转译主函数（纯函数，可无头测试）。 */
export function translateMessages(messages: readonly ChatMessage[], opts?: TranslateOpts): SourcedBlock[] {
  const pinned = opts?.pinnedPositions;
  const out: SourcedBlock[] = [];
  for (const msg of messages) out.push(...translateMessage(msg, pinned));
  return out;
}

/* ── 增量转译缓存（性能专项第一刀：流式全量重算 → 只重译被触碰的消息）──
 * 消息 store 的 touchMessage 语义是「浅拷贝被触碰的那条消息」——未触碰消息的
 * 对象引用保持不变。本缓存以消息对象引用为 key：流式 token 只换最后一条消息的
 * 引用 → 只有那条消息的块重建，其余块对象引用稳定（React.memo 因而在流式中也
 * 能跳过未变块的 DOM 重渲染）。
 * 钉住表引用变化（用户钉/收/拖）时缓存全量失效——钉住是稀有交互，全量重译可接受。 */

export interface MessageTranslateCache {
  /** 钉住表引用身份——引用变了必须全量重译（钉住状态变化） */
  pinned: Readonly<Record<string, { x: number; y: number }>>;
  pinnedMap: ReadonlyMap<string, { x: number; y: number }>;
  byMessage: Map<ChatMessage, SourcedBlock[]>;
}

/** 增量转译入口：prev 为 null/钉住表变化时全量重建，否则只补新消息引用。 */
export function translateMessagesCached(
  messages: readonly ChatMessage[],
  pinned: Readonly<Record<string, { x: number; y: number }>>,
  prev: MessageTranslateCache | null,
): { blocks: SourcedBlock[]; cache: MessageTranslateCache } {
  if (!prev || prev.pinned !== pinned) {
    const pinnedMap = new Map(Object.entries(pinned));
    const byMessage = new Map<ChatMessage, SourcedBlock[]>();
    const blocks: SourcedBlock[] = [];
    for (const msg of messages) {
      const sub = translateMessage(msg, pinnedMap);
      byMessage.set(msg, sub);
      blocks.push(...sub);
    }
    return { blocks, cache: { pinned, pinnedMap, byMessage } };
  }
  const byMessage = prev.byMessage;
  const blocks: SourcedBlock[] = [];
  for (const msg of messages) {
    const sub = byMessage.get(msg);
    if (sub) {
      blocks.push(...sub);
    } else {
      const fresh = translateMessage(msg, prev.pinnedMap);
      byMessage.set(msg, fresh);
      blocks.push(...fresh);
    }
  }
  return { blocks, cache: prev };
}

function translateUser(msg: UserMessage): SourcedBlock {
  // 附件不再拼进入文正文（旧病灶：等宽路径挤进楷书朱砂批注体，字体语义全乱）。
  // 结构化进 payload.files，渲染层独立小行（石青 mono）展示。
  const files = msg.files?.length ? msg.files.map((f) => ({ path: f.path, name: f.name })) : undefined;
  // 附图引用（B4 D-9）：与 files 并列旁挂——渲染层缩略行；引用纯 JSON，
  // 字节永不进块（INVARIANTS #14——渲染期才回读 data URI）。
  const images = msg.images?.length ? msg.images : undefined;
  return {
    ...createBlock(
      'user',
      { text: msg.text, ...(files ? { files } : {}), ...(images ? { images } : {}) },
      { messageId: msg._id, part: null },
    ),
    id: `pb:${msg._id}`, // 用户消息 1:1，id 直接挂消息 id
    w: USER_BLOCK_WIDTH,
  };
}

/* ── 围栏拆分：text part → 抄录 / markdown 块序列 ──
 * 走查弹定义（R1）：灰框块 = markdown + diff + tool result。真实会话里 diff
 * 以 markdown 围栏（```diff）出现在 text part 内——转译层把它拆出来。
 *
 * ⚠️ 围栏一律**独立成块**（`diff` 块 = 文类「抄录 / CODE」的机器文本块），
 * 块体按语言标记分流（判据 = `isDiffLang`，分块与渲染共用一处）：真差分
 * 走差分着色，其余语言（含裸围栏）走 hljs 代码体。两条路**几何同源**——
 * 同一 `<pre>`（.pp-block.pp-diff pre 的线/底/内距/cap）、同一 `.pp-lang`
 * 语言行、同判据的 measure 预算，高亮只包 span 不改行数/折行 ⇒ 零漂移。
 *
 * 2026-09-23 文类回归批：上一批（a0076c9f）为救高亮把围栏「回吐」进 markdown
 * 段，代价是**文类与块形态双失**——落在 `.pp-md-code` 图码形态上，而 spec 明
 * 说图码是「独立 diff 块之外幸存围栏的兜底面」（只有嵌在列表/引用里的围栏才
 * 该落那儿）。真实会话后果：`git status` / 文件内容这类机器输出以「正文 /
 * AGENT」块混进正文流。本批把文类还给它们，高亮走块体内的语言分派。
 *
 * 唯一豁免 = ```mermaid：图渲染链路（MermaidBlock）与代码块测高契约都挂在
 * markdown 段的 `MdCodeBlock` 上，独立成抄录块会与测高镜像脱钩 ⇒ 回吐
 * markdown（行为与本批前一致）。
 *
 * 流式友好：围栏未闭合（token 还在到达）时按已闭合处理（差分块持续生长）。
 * id 方案：无围栏的纯文本保持 pb:{msg}:{i}（兼容）；拆分后 text 段
 * pb:{msg}:{i}t{n}、围栏段 pb:{msg}:{i}f{n}——围栏标记位置稳定则 id 稳定。 */

/** 真差分围栏语言——**分块与块体渲染共用的单一真源**（转译层分流 + `DiffBody`
 *  分派都读它；两处各判一份必然漂）。 */
export const DIFF_LANGS = new Set(['diff', 'patch']);

/** 该围栏语言是否真差分（`undefined` = 裸围栏 ⇒ false，走代码体：纯 mono
 *  原文，好过被差分体按行首 +/-/@@ 误着色）。 */
export function isDiffLang(lang: string | undefined): boolean {
  return lang !== undefined && DIFF_LANGS.has(lang.toLowerCase());
}

/** mermaid 围栏的唯一豁免标记（回吐 markdown——见文件头注）。 */
const MERMAID_LANG = 'mermaid';

interface TextSegment {
  kind: 'markdown' | 'diff';
  text: string;
  lang?: string;
}

export function splitFencedSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  // 行首 ``` 开围栏；语言标记跟在后（如 ```diff / ```ts）
  const fenceRe = /^```([^\n]*)$/;
  const lines = text.split('\n');
  let i = 0;
  let buf: string[] = [];
  const flushText = (): void => {
    // 去掉围栏前后的空行（块边界干净）
    while (buf.length > 0 && buf[0].trim() === '') buf.shift();
    while (buf.length > 0 && buf[buf.length - 1].trim() === '') buf.pop();
    if (buf.length > 0) segments.push({ kind: 'markdown', text: buf.join('\n') });
    buf = [];
  };
  while (i < lines.length) {
    const m = lines[i].match(fenceRe);
    if (m) {
      const lang = m[1].trim() || undefined;
      const code: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (fenceRe.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        code.push(lines[i]);
        i++;
      }
      void closed; // 未闭合 = 流式中：照常产出（块内容持续增长）
      flushText();
      if (lang === MERMAID_LANG) {
        // 唯一豁免：重建围栏回吐 markdown（parseMarkdown 收成 t:'code' →
        // MdCodeBlock 的 mermaid 认领与测高契约原样保留）。
        segments.push({ kind: 'markdown', text: [`\`\`\`${lang}`, ...code, '```'].join('\n') });
      } else {
        // 其余围栏一律独立成块（抄录 / CODE）——语言标记随 payload 下去，
        // 块体按 isDiffLang 分流差分着色 / hljs 代码体。
        segments.push({ kind: 'diff', text: code.join('\n'), lang });
      }
    } else {
      buf.push(lines[i]);
      i++;
    }
  }
  flushText();
  return segments;
}

function emitTextWithFences(
  messageId: string,
  text: string,
  partIndex: number,
  part: object,
  out: SourcedBlock[],
  pinned: ReadonlyMap<string, { x: number; y: number; w?: number }> | undefined,
  sidecar?: { text: string; reasoningIdx: number },
): void {
  const segs = splitFencedSegments(text);
  if (segs.length === 1 && segs[0].kind === 'markdown') {
    // 纯文本：保持 1:1 映射与稳定 id（兼容既有行为）
    const id = partBlockId(messageId, partIndex);
    const base = {
      ...createBlock(
        'markdown',
        { text: segs[0].text, ...(sidecar ? { sidecar: { text: sidecar.text } } : {}) },
        { messageId, part },
      ),
      id,
      w: DEFAULT_BLOCK_WIDTH,
    };
    out.push(withPin(base, pinned?.get(id)));
    return;
  }
  // 拆分序列：t{n} 文本段 / f{n} 围栏段
  let tN = 0;
  let fN = 0;
  let sidecarLeft = sidecar;
  for (const seg of segs) {
    const id =
      seg.kind === 'markdown' ? `pb:${messageId}:${partIndex}t${tN++}` : `pb:${messageId}:${partIndex}f${fN++}`;
    const isMd = seg.kind === 'markdown';
    const payload = isMd
      ? { text: seg.text, ...(sidecarLeft ? { sidecar: { text: sidecarLeft.text } } : {}) }
      : { lang: seg.lang, text: seg.text };
    if (isMd && sidecarLeft) sidecarLeft = undefined;
    const base = {
      ...createBlock(seg.kind, payload as never, { messageId, part }),
      id,
      w: seg.kind === 'diff' ? 640 : DEFAULT_BLOCK_WIDTH,
    };
    out.push(withPin(base, pinned?.get(id)));
  }
  // 眉批未消化（text 全是围栏）→ 回退独立 reasoning 块，id 用原夹注 part idx
  // （钉住续命不断：流式中钉过的夹注在回退态仍按原 id 续命）
  if (sidecarLeft) {
    const id = partBlockId(messageId, sidecarLeft.reasoningIdx);
    const base = {
      ...createBlock('reasoning', { text: sidecarLeft.text }, { messageId, part }),
      id,
      w: REASONING_BLOCK_WIDTH,
    };
    out.push(withPin(base, pinned?.get(id)));
  }
}

function translateAssistantParts(
  msg: AssistantMessage,
  out: SourcedBlock[],
  pinned: ReadonlyMap<string, { x: number; y: number; w?: number }> | undefined,
  subChildIds: Set<string>,
): void {
  /* P5 眉批化配对预扫：连续 reasoning 合并 → 紧随的 text part 吸收为眉批
   * （payload.sidecar，测高 max(正文, 夹注@侧栏)）；无正文后继（tool 结尾/
   * 消息尾/只含围栏的 text——围栏一律独立成抄录块，掏空了正文段，由
   * emitTextWithFences 二次回退）→ 独立 reasoning 块不丢字，id 保持原夹注
   * part idx（钉住续命不断）。 */
  const sidecarFor = new Map<number, { text: string; reasoningIdx: number }>();
  const fallbackIdx = new Set<number>();
  let pending: Array<{ idx: number; text: string }> = [];
  msg.parts.forEach((part, idx) => {
    if (part.type === 'reasoning') {
      pending.push({ idx, text: part.text });
      return;
    }
    if (part.type === 'text' && pending.length > 0) {
      sidecarFor.set(idx, { text: pending.map((p) => p.text).join('\n\n'), reasoningIdx: pending[0].idx });
      pending = [];
      return;
    }
    for (const pr of pending) fallbackIdx.add(pr.idx);
    pending = [];
  });
  for (const pr of pending) fallbackIdx.add(pr.idx);

  const emit = (
    kind: SourcedBlock['kind'],
    payload: SourcedBlock['payload'],
    partIndex: number,
    part: object,
    w?: number,
  ): void => {
    const id = partBlockId(msg._id, partIndex);
    const base = {
      ...createBlock(kind, payload as never, { messageId: msg._id, part }),
      id,
      w: w ?? DEFAULT_BLOCK_WIDTH,
    };
    out.push(withPin(base, pinned?.get(id)));
  };

  msg.parts.forEach((part, idx) => {
    switch (part.type) {
      case 'reasoning':
        // 被眉批吸收的夹注不单独发射（随 text part 走）；仅回退路径发射
        if (fallbackIdx.has(idx)) {
          emit('reasoning', { text: part.text }, idx, part, REASONING_BLOCK_WIDTH);
        }
        break;
      case 'text':
        emitTextWithFences(msg._id, part.text, idx, part, out, pinned, sidecarFor.get(idx));
        break;
      case 'tool': {
        // code_execution 专属块（P2-A 拍板）：三段式形态与 tool 单进单出分离；
        // 判据 name === 'code_execution'（常驻名，不进 DOMAIN_SPECS）。
        if (part.name === 'code_execution') {
          let code = '';
          let description = part.label;
          try {
            const parsed = JSON.parse(part.args || '{}') as { code?: string; description?: string };
            if (typeof parsed.code === 'string') code = parsed.code;
            if (typeof parsed.description === 'string') description = parsed.description;
          } catch {
            /* args 未流完/非 JSON：保持空程序体（终态会被 ToolResult 覆盖） */
          }
          emit(
            'code',
            {
              toolId: part.toolId,
              description,
              code,
              status: part.status,
              output: part.output,
              err: part.err,
              ...(part.startedAt !== undefined ? { startedAt: part.startedAt } : {}),
            },
            idx,
            part,
            640,
          );
          break;
        }
        emit(
          'tool',
          {
            toolId: part.toolId,
            name: part.name,
            label: part.label,
            args: part.args,
            status: part.status,
            output: part.output,
            err: part.err,
            ...(part.startedAt !== undefined ? { startedAt: part.startedAt } : {}),
          },
          idx,
          part,
          640,
        );
        break;
      }
      case 'plan':
        emit(
          'plan',
          {
            planId: part.planId,
            title: '计划',
            content: part.content,
            status: part.status,
            options: part.options,
            _callback: part._callback,
          },
          idx,
          part,
        );
        break;
      case 'block': {
        // 资产块（WO-3）：BlockPart → 1 块映射——不拆围栏、不分组。
        // id 沿用 pb:{msg}:{i} 稳定规则（update 后重转译 id 不变 = 钉住续命）。
        // 活引用 source.part = BlockPart；资产身份/表现选择挂在 block.asset，
        // payload 保持 BlockPart.payload 纯 JSON 原样。
        const base = {
          ...createBlock(part.kind, part.payload as never, { messageId: msg._id, part }),
          id: partBlockId(msg._id, idx),
          asset: {
            assetId: part.assetId,
            presentation: part.presentation,
            ...(part.title !== undefined ? { title: part.title } : {}),
            finalised: part.finalised,
            ...(part._confirmCallback ? { _confirm: part._confirmCallback } : {}),
          },
          w: DEFAULT_BLOCK_WIDTH,
        };
        const pos = pinned?.get(base.id);
        out.push(withPin(base, pos));
        break;
      }
      case 'subagent': {
        // 子代理组（2026-09-01 三轴审计 F4）：组头一行（描述+状态+段数），
        // 子 parts 挂组内——折叠摘除/钉住续命全复用工具组机制；不再摊平成
        // 独立正文块污染主流。组头 id 锚 part 序号（`g` 尾缀，与工具组头
        // 同族同稳定语义），子块 id 带 `s{n}` 前缀防与父消息 part 撞号。
        const childIds: string[] = [];
        for (let sIdx = 0; sIdx < part.parts.length; sIdx++) childIds.push(`pb:${msg._id}:${idx}s${sIdx}`);
        const headerId = `pb:${msg._id}:${idx}g`;
        const header = withPin(
          {
            ...createBlock(
              'subagent',
              {
                agentId: part.agentId,
                description: part.description,
                status: part.status,
                childIds,
                items: part.parts,
              },
              { messageId: msg._id, part },
            ),
            id: headerId,
            w: 640,
          },
          pinned?.get(headerId),
        );
        out.push(header);
        part.parts.forEach((sp, sIdx) => {
          const subId = `pb:${msg._id}:${idx}s${sIdx}`;
          const make = (): SourcedBlock => {
            switch (sp.type) {
              case 'reasoning':
                return {
                  ...createBlock('reasoning', { text: sp.text }, { messageId: msg._id, part: sp }),
                  id: subId,
                  w: REASONING_BLOCK_WIDTH,
                };
              case 'text':
                return { ...createBlock('markdown', { text: sp.text }, { messageId: msg._id, part: sp }), id: subId };
              case 'tool':
                // code_execution 专属块同父路径（子 Agent parts 同构）
                if (sp.name === 'code_execution') {
                  let subCode = '';
                  let subDesc = sp.label;
                  try {
                    const pp = JSON.parse(sp.args || '{}') as { code?: string; description?: string };
                    if (typeof pp.code === 'string') subCode = pp.code;
                    if (typeof pp.description === 'string') subDesc = pp.description;
                  } catch {
                    /* 未流完 */
                  }
                  return {
                    ...createBlock(
                      'code',
                      {
                        toolId: sp.toolId,
                        description: `[子] ${subDesc}`,
                        code: subCode,
                        status: sp.status,
                        output: sp.output,
                        err: sp.err,
                        ...(sp.startedAt !== undefined ? { startedAt: sp.startedAt } : {}),
                      },
                      { messageId: msg._id, part: sp },
                    ),
                    id: subId,
                    w: 640,
                  };
                }
                return {
                  ...createBlock(
                    'tool',
                    {
                      toolId: sp.toolId,
                      name: sp.name,
                      label: `[子] ${sp.label}`,
                      args: sp.args,
                      status: sp.status,
                      output: sp.output,
                      err: sp.err,
                      ...(sp.startedAt !== undefined ? { startedAt: sp.startedAt } : {}),
                    },
                    { messageId: msg._id, part: sp },
                  ),
                  id: subId,
                  w: 640,
                };
              case 'plan':
                return {
                  ...createBlock(
                    'plan',
                    {
                      planId: sp.planId,
                      title: '计划',
                      content: sp.content,
                      status: sp.status,
                      options: sp.options,
                      _callback: sp._callback,
                    },
                    { messageId: msg._id, part: sp },
                  ),
                  id: subId,
                };
              case 'block':
                return {
                  ...createBlock(sp.kind, sp.payload as never, { messageId: msg._id, part: sp }),
                  id: subId,
                  asset: {
                    assetId: sp.assetId,
                    presentation: sp.presentation,
                    ...(sp.title !== undefined ? { title: sp.title } : {}),
                    finalised: sp.finalised,
                    ...(sp._confirmCallback ? { _confirm: sp._confirmCallback } : {}),
                  },
                };
              default:
                return { ...createBlock('markdown', { text: '' }, { messageId: msg._id, part: sp }), id: subId };
            }
          };
          const b = make();
          subChildIds.add(subId);
          out.push(withPin(b, pinned?.get(subId)));
        });
        break;
      }
      default:
        break;
    }
  });

  // 回合墓碑（2026-08-31 贴黄拆迁）：回合终止失败/暂停 → 错误行贴回合尾。
  // 不入会话流（不是独立消息），而是该回合正文块的附随块——id 锚消息级，
  // 钉住续命与重转译稳定。finishTurn 尊重 status==='error' 不覆盖，
  // 墓碑跨流式收尾存活。
  if (msg.status === 'error' && msg.errorMessage) {
    const errId = `pb:${msg._id}:err`;
    const base = {
      ...createBlock('turn-error', { text: msg.errorMessage, level: 'error' }, { messageId: msg._id, part: null }),
      id: errId,
      w: DEFAULT_BLOCK_WIDTH,
    };
    out.push(withPin(base, pinned?.get(errId)));
  }
}
