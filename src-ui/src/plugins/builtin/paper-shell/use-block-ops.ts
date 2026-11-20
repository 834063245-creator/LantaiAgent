// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 消息操作域（paper-panel-split C3）——块 hover 操作按钮（施工单 #5 →
// 2026-08-31 修订 → 2026-09-20 造型批）：抄录恒有；状态类操作（改写/重发）只出现在
// 各卷最新一条来文上（答块的「重试」与来文块的「重发」同轨冗余，2026-09-16 用户裁定
// 删除）。**标签用文言双字（改写/重发/抄录/立枝）**：四件等宽、节奏齐——造型批与
// 「去框素面行」同批（台架 prototype/msg-ops-style-ab.html）。
// opsByBlock 是 O(总块数) 的按块建表，P2-3 复合键缓存平移帧零重建。

import type { MutableRefObject } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import type { ChatMessage, RegionView, SourcedBlock, TextPart, UserMessage } from './host';
import { sameKey } from './use-paper-regions';
import type { PaperCore } from './use-paper-sessions';

/** 消息操作项（施工单 #5）：块 hover 出现的操作按钮。
 *  disabled/title：状态类操作（改写/重发）在该轮已无法唯一定位撤回时
 *  置灰降级（2026-09-01 重发锚点工程——绝不撤错轮；置灰样式归 `:disabled`）。 */
export interface BlockOp {
  key: string;
  label: string;
  run: () => void;
  disabled?: boolean;
  title?: string;
}

/** 资产类动作行（**入阁 / 引用**）——活块与孤儿钉共用同一份判据与文案。
 *
 *  为什么单独抽出来：孤儿钉（源卷未摊开 / 已删 / 从架阁摊上来的卡）没有活消息，
 *  `msgOpsFor` 那条按消息建表的循环根本到不了它们——旧实现给它们 `EMPTY_OPS`，
 *  于是「已经摊在画布上的卡没有引用按钮」（2026-11-20 用户报）。
 *  这两件动作只认**资产身份**，与消息无关，故判据可以共用一份。
 *
 *  `resolve` = 点击那一刻取「当刻那一版」块（活块流式期间每帧重建，闭包里捕获的
 *  可能是旧快照）；孤儿钉没有更版，缺省就用入参那一枚。 */
export function assetOpsOf(
  block: SourcedBlock,
  sessionNum: number,
  opts: {
    onShelve?: (block: SourcedBlock, sessionNum: number) => void;
    onQuote?: (block: SourcedBlock, sessionNum: number) => void;
    quoteReady?: boolean;
  },
  resolve: () => SourcedBlock = () => block,
): BlockOp[] {
  const ops: BlockOp[] = [];
  if (!block.asset) return ops;
  // **入阁**（架阁，2026-12-08 B2）：把这一块**当刻的样子**抄进卡片库。拓印语义——
  // 此后它与本卷这张卡互不回写（entity-shelf-plan D3）；必须是**用户手势**。
  if (opts.onShelve) {
    const shelve = opts.onShelve;
    ops.push({ key: 'shelve', label: '入阁', run: () => shelve(resolve(), sessionNum) });
  }
  // **引用**（夹签，card-quote-plan §2.1/§11）：与「入阁」并排的第二个拓印出口——
  // 入阁是**收进库**（长期），引用是**递给这一轮的 Agent**（一次性通行证）。
  if (opts.onQuote) {
    const quote = opts.onQuote;
    ops.push({
      key: 'quote',
      label: '引用',
      run: () => quote(resolve(), sessionNum),
      ...(opts.quoteReady ? {} : { disabled: true, title: '先展开一卷或落一张纸（夹签要有地方可落）' }),
    });
  }
  return ops;
}

/** 「立枝」判据表（**块 id** → 判据）：形状取自 core 能力位，不另立类型出口——
 *  判据真源在 `app/chat/session-branch`（本文件只消费）。 */
type BranchMap = ReturnType<PaperCore['branchPoints']>;
type BranchPoint = NonNullable<ReturnType<BranchMap['get']>>;
/** 查表结果（未列出的块 = 无判据 ⇒ 按可立枝处理——置灰是提示，不是门禁）。 */
type BranchVerdict = BranchPoint | undefined;
type BranchNode = Parameters<PaperCore['branchPoints']>[1][number];
/** 块坐标（消息 parts + 本块下标）——按块定位的输入，形状同样取自 core 能力位。 */
type BranchBlockRef = NonNullable<BranchNode['block']>;

/** 从**块**提取可抄文本——「抄录」抄的是**这一块**（2026-11 修订）。
 *
 *  旧实现抄的是**整条消息**（assistant = 全部 text part 拼接），但按钮是按
 *  **块**挂的（每个块 hover 一行，块与消息不是 1:1）——于是在代码块上点抄录，
 *  拿到的是整篇回复正文；在工具卡上点，拿到的是 agent 的话、工具输出一个字
 *  都没有（用户报「复制的内容和预期不符」）。抄录的语义是「抄眼前这一块」，
 *  故按块投影 payload：纸面上怎么写的，剪贴板里就是什么。
 *
 *  复合块（工具组 / 子代理组）收组内各项；资产块（插件自定义 payload）只认
 *  `text` 字段——投影不出文本就不出按钮，绝不回退成"抄一条不相干的消息"。 */
function blockCopyText(block: SourcedBlock): string {
  const p = (block.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const pick = (v: unknown, fallback: unknown): string => (str(v).trim() ? str(v) : str(fallback));
  switch (block.kind) {
    case 'tool': // 脚注：工具输出为主；未跑完（无输出）退错误、再退入参
      return pick(p.output, pick(p.err, p.args));
    case 'code': // 程文：程序体 + 运行结果
      return [str(p.code), str(p.output)].filter((s) => s.trim()).join('\n\n');
    case 'plan': // 拟策：题 + 正文
      return [str(p.title), str(p.content)].filter((s) => s.trim()).join('\n\n');
    case 'toolgroup': {
      // 工具组：组头只是折叠行，内容 = 组内各项的输出
      const items = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];
      return items
        .map((it) => pick(it.output, pick(it.err, it.args)))
        .filter((s) => s.trim())
        .join('\n\n');
    }
    case 'subagent': {
      // 子代理组：组内各步的正文（工具步取输出）
      const items = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];
      return items
        .map((it) => (it.type === 'tool' ? pick(it.output, it.err) : str(it.text)))
        .filter((s) => s.trim())
        .join('\n\n');
    }
    default:
      // 来文 / 正文 / 夹注 / 抄录（代码）/ 贴黄 / 回合错误：payload.text 即本块文字
      return str(p.text);
  }
}

/** 整条回复的正文——所有 text part 拼接（「抄全文」用；含代码围栏原文）。
 *
 *  与 `blockCopyText` 分工：「抄录」抄**这一块**，「抄全文」抄**整条**。后者只给
 *  **正文块**（用户 2026-11 裁定）——工具卡 / 代码块上给「抄全文」等于又回到
 *  "按钮和内容对不上号"的老毛病。来文块不需要：它本身就是全文。 */
function messageCopyText(msg: ChatMessage): string {
  if (msg.role !== 'assistant') return msg.text;
  return msg.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** 消息操作域（paper-panel-split C3，自 PaperPanel 184-204 + 1592-1697
 *  域内原样搬入）。ops 按块 id 记忆（opsCacheRef，stamp 随最新消息判定与
 * 可撤态变化失效）——点击时经 regionMsgs 取最新消息。 */
export function useBlockOps(params: {
  core: PaperCore | null;
  regions: RegionView[];
  regionsRef: MutableRefObject<RegionView[]>;
  regionMsgs: Record<string, { messages: readonly ChatMessage[]; tick: number }>;
  /** **入阁**（架阁，2026-12-08 B2）：把这一块当刻的样子抄进卡片库。缺席 = 不出
   *  「入阁」按钮（能力位语义——与纸壳其余可选面同款；旧宿主/测试桩零改动）。 */
  onShelve?: (block: SourcedBlock, sessionNum: number) => void;
  /** **引用**（夹签，card-quote-plan §2.1）：把这一块当刻的样子递进本卷的夹签槽。
   *  与「入阁」并排——同一个「拓印」家族：本体不动，只多一枚分身。缺席 = 不出按钮。 */
  onQuote?: (block: SourcedBlock, sessionNum: number) => void;
  /** 夹签有没有地方可落（此刻有没有卷 / 纸）——空画布时按钮**置灰**而不是消失
   *  （方案 §2.2 态一 / §8：用户得看得见它、并读到「先展开一卷或落一张纸」）。 */
  quoteReady?: boolean;
}) {
  const { core, regions, regionsRef, regionMsgs, onShelve, onQuote, quoteReady } = params;

  const msgOpsFor = useCallback(
    (
      msg: ChatMessage,
      stateOps: boolean,
      retrace: boolean,
      sid: number,
      branch: BranchVerdict,
      block: BranchBlockRef | undefined,
      self: SourcedBlock,
    ): BlockOp[] => {
      if (!core) return [];
      const latest = (): ChatMessage => {
        // 在来源会话的消息流里找最新版本
        for (const r of regionsRef.current) {
          const found = regionMsgs[r.sessionNum]?.messages.find((m) => m._id === msg._id);
          if (found) return found;
        }
        return msg;
      };
      /** 本块的**最新版本**（同 id）——流式期间块对象每帧重建，闭包里捕获的
       *  可能是旧快照；抄录点击时必须抄纸面上此刻的内容。 */
      const latestSelf = (): SourcedBlock => {
        for (const r of regionsRef.current) {
          const found = r.blocks.find((b) => b.id === self.id);
          if (found) return found;
        }
        return self;
      };
      const ops: BlockOp[] = [];
      // 可撤态置灰降级（沙盒映射定位失败 = 会话已压缩/上下文已变化——
      // 按钮可留待重派生自愈，但绝不撤错轮）
      const gone = (ok: boolean) => ({
        disabled: !ok,
        title: ok ? undefined : '该轮已不可重发（会话已压缩）',
      });
      if (msg.role === 'user' && stateOps) {
        const latestUser = (): UserMessage => {
          for (const r of regionsRef.current) {
            const m = regionMsgs[r.sessionNum]?.messages.find((x) => x._id === msg._id);
            if (m && m.role === 'user') return m;
          }
          return msg as UserMessage;
        };
        ops.push({ key: 'edit', label: '改写', run: () => core.editUserMessage(latestUser()), ...gone(retrace) });
        ops.push({ key: 'resend', label: '重发', run: () => core.resendUserMessage(latestUser()), ...gone(retrace) });
      }
      // **抄录 = 抄这一块**（不是整条消息）：按钮按块挂，抄的就必须是本块内容。
      const text = blockCopyText(latestSelf());
      if (text.trim()) ops.push({ key: 'copy', label: '抄录', run: () => core.copyText(blockCopyText(latestSelf())) });
      // **入阁 / 引用**（拓印家族两件）：判据与文案单一真源 = assetOpsOf（孤儿钉共用）。
      ops.push(...assetOpsOf(self, sid, { onShelve, onQuote, quoteReady }, latestSelf));
      // **抄全文**只给**正文块**（2026-11 用户裁定）：一条回复的正文常被工具调用夹成
      // 多段，读哪一段都能顺手把整条正文抄走。工具卡 / 代码块 / 组头上不给——那等于
      // 又回到"按钮和内容对不上号"（在代码块上抄到整篇回复）。来文块也不需要：它本身
      // 就是全文。**入口给所有正文段**（只给首段会让读到第三段的用户找不到入口）。
      if (self.kind === 'markdown' && msg.role === 'assistant') {
        const whole = messageCopyText(latest());
        if (whole.trim()) {
          ops.push({ key: 'copy-all', label: '抄全文', run: () => core.copyText(messageCopyText(latest())) });
        }
      }
      // **立枝**（会话树，2026-09-18；2026-09-22 改按**块**定位）：从这一块另起一枝——
      // 枝**含这一块**，切点 = 该块所在**那一步**的末尾（判据在 `session-branch`）。
      // 位置纪律 = 与「改 / 重发 / 抄」同一行动作（主流 agent 软件的分支入口都挂在
      // 消息自己身上，不是会话列表、不是标题栏）；一条答复的每一块都给（正文段 / 工具卡…）
      // ——**块坐标随点击一起交给 core**：一条助手消息在实时形态里聚合整轮，
      // 不带块坐标就只能切到整轮末尾（用户报的「复制了一整个会话」）。
      // **置灰**：判据由调用方每卷**一趟**派生（`core.branchPoints`，逐块 O(1)）后传进来
      // ——判定含整段 fold（O(事件数)），逐块在渲染期跑会拖帧；不可立枝的**具名原因**
      // 直接作 title（错误不静默），点击时仍由 `branchFromMessage` 兜底。
      // 无判据的块按**可立枝**处理（置灰是提示不是门禁：宁可让用户点一下看到具名
      // toast，也不误灰一个合法的枝）。
      ops.push({
        key: 'branch',
        label: '立枝',
        run: () => void core.branchFromMessage(latest(), sid, undefined, block),
        ...(branch && !branch.ok ? { disabled: true } : {}),
        title: branch && !branch.ok ? branch.reason : '从这一块另起一枝：本卷原样保留，新枝复制到这一块为止的历史',
      });
      return ops;
    },
    [core, regionMsgs, regionsRef, onShelve, onQuote, quoteReady],
  );
  const opsCacheRef = useRef<Map<string, { msg: ChatMessage; ops: BlockOp[]; stamp: string; regionMsgs: unknown }>>(
    new Map(),
  );
  /** 派生产物（同一趟循环攒出、同一份复合键缓存）：
   *  `opsByBlock` = 动作行表；`branchGrips` = **可立枝的块**集——空间手势立枝的握把
   *  可见性真源（P4-①，plan §5）：与「立枝」按钮**同一张判据表**（`branchPoints` →
   *  `branchPointIn`），故握把不会长在工具卡/通知块/未落定轮上（那些地方按钮本就置灰，
   *  握把 = 一个注定被拒的整段手势）。 */
  const derivedCacheRef = useRef<{
    key: unknown[];
    opsByBlock: Map<string, BlockOp[]>;
    branchGrips: Set<string>;
  } | null>(null);
  const derived = useMemo(() => {
    // P2-3：复合键复用——输入不变（平移帧：blocks 引用稳定 + regionMsgs 同一
    // 性）时整份产物原样复用，O(总块数) 的 byId 建表/最新来文扫尾/缓存比对
    // 全免。retrace 判定只在内容变化时重算（stamp 语义不变）。
    const key: unknown[] = [regionMsgs, core, msgOpsFor];
    for (const r of regions) key.push(r.sessionNum, r.blocks);
    const prev = derivedCacheRef.current;
    if (prev && sameKey(prev.key, key)) return prev;
    const opsByBlock = new Map<string, BlockOp[]>();
    const branchGrips = new Set<string>();
    const out = { key, opsByBlock, branchGrips };
    derivedCacheRef.current = out;
    if (!core) return out;
    for (const r of regions) {
      const msgs = regionMsgs[r.sessionNum]?.messages ?? [];
      const byId = new Map<string, ChatMessage>();
      for (const m of msgs) byId.set(m._id, m);
      // 每**块**一张节点（键 = 块 id）：同一条答复拆出的各块切点各不相同，故判据必须
      // 按块问——块坐标（消息 parts + 本块下标）一并带上（2026-09-22 按块定位）。
      const nodes: BranchNode[] = [];
      const blockRefs = new Map<string, BranchBlockRef>();
      for (const b of r.blocks) {
        const msg = byId.get(b.source.messageId);
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
        if (msg.role !== 'assistant') {
          nodes.push({ key: b.id, _id: msg._id, role: msg.role });
          continue;
        }
        const block: BranchBlockRef = {
          parts: msg.parts,
          // findIndex 而非 indexOf：`source.part` 的类型是 `object | null`（块来源是
          // 活引用，part 可能已被重建），indexOf 收窄不了 null —— 保住类型安全优先于
          // 一条 lint 提示（useIndexOf 在本行是**既有**警告，不归本批）。
          index: msg.parts.findIndex((p) => p === b.source.part),
        };
        blockRefs.set(b.id, block);
        nodes.push({ key: b.id, _id: msg._id, role: msg.role, respondingTo: msg.respondingTo, block });
      }
      // 可立枝判据：**每卷一趟**派生（O(事件数 + 块数)）——逐块问 = 每块一次整段
      // fold（长卷拖帧，见 session-branch.deriveBranchPoints）。判据随缓存戳走：
      // 未落定批次跑完/锚点变化 ⇒ 戳变 ⇒ 该块的 ops 重算（置灰态不粘旧判定）。
      const branches: BranchMap = core.branchPoints(r.sessionNum, nodes);
      // 各卷最新一条来文（倒序首见）——状态类操作按钮的准入判定
      let lastUser: ChatMessage | undefined;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'user') {
          lastUser = m;
          break;
        }
      }
      for (const b of r.blocks) {
        const msg = byId.get(b.source.messageId);
        if (!msg) continue;
        const stateOps = msg.role === 'user' && lastUser?._id === msg._id;
        // 可撤态入缓存戳——压缩/漂移后置灰态随渲染刷新（不粘旧判定）
        let retrace = false;
        if (stateOps && msg.role === 'user') retrace = core.canRetraceUserMessage(msg);
        const branch: BranchVerdict = branches.get(b.id);
        if (branch?.ok) branchGrips.add(b.id);
        const stamp = `${stateOps ? (retrace ? '1' : '0') : ''}|${
          branch ? (branch.ok ? `b${branch.atSeq}` : `x${branch.reason}`) : ''
        }`;
        const hit = opsCacheRef.current.get(b.id);
        if (hit && hit.msg === msg && hit.stamp === stamp && hit.regionMsgs === regionMsgs) {
          // 2026-09-01 审计：缓存键补 regionMsgs 同一性——ops 闭包捕获建时的
          // regionMsgs，消息表换新而 msg/stamp 未变时旧 ops 的 latest() 会读到
          // 陈旧会话消息表。
          opsByBlock.set(b.id, hit.ops);
        } else {
          const ops = msgOpsFor(msg, stateOps, retrace, r.sessionNum, branch, blockRefs.get(b.id), b);
          opsCacheRef.current.set(b.id, { msg, ops, stamp, regionMsgs });
          opsByBlock.set(b.id, ops);
        }
      }
    }
    return out;
  }, [regions, regionMsgs, core, msgOpsFor]);

  return { opsByBlock: derived.opsByBlock, branchGrips: derived.branchGrips };
}
