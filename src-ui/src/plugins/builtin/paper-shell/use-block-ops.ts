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
import type { ChatMessage, RegionView, TextPart, UserMessage } from './host';
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

/** 「立枝」判据表（`_id` → 判据）：形状取自 core 能力位，不另立类型出口——
 *  判据真源在 `app/chat/session-branch`（本文件只消费）。 */
type BranchMap = ReturnType<PaperCore['branchPoints']>;

/** 从消息提取可复制的正文文本（text part 拼接）。 */
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
}) {
  const { core, regions, regionsRef, regionMsgs } = params;

  const msgOpsFor = useCallback(
    (msg: ChatMessage, stateOps: boolean, retrace: boolean, sid: number, branches: BranchMap): BlockOp[] => {
      if (!core) return [];
      const latest = (): ChatMessage => {
        // 在来源会话的消息流里找最新版本
        for (const r of regionsRef.current) {
          const found = regionMsgs[r.sessionNum]?.messages.find((m) => m._id === msg._id);
          if (found) return found;
        }
        return msg;
      };
      const latestMsg = latest();
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
      const text = messageCopyText(latestMsg);
      if (text.trim()) ops.push({ key: 'copy', label: '抄录', run: () => core.copyText(messageCopyText(latest())) });
      // **立枝**（会话树，2026-09-18）：从这条消息（节点）另起一枝——枝**含该节点**。
      // 位置纪律 = 与「改 / 重发 / 抄」同一行动作（主流 agent 软件的分支入口都挂在
      // 消息自己身上，不是会话列表、不是标题栏）；来文块与回复块都给（回复块的切点
      // 落在本轮末尾，见 `session-branch.resolveBranchPoint`）。
      // **置灰**：判据由调用方**每卷一趟**派生（`core.branchPoints`）后传进来——判定
      // 含整段 fold（O(事件数)），逐块在渲染期跑会拖帧；不可立枝的**具名原因**直接
      // 作 title（错误不静默），点击时仍由 `branchFromMessage` 兜底。
      // 无判据的块按**可立枝**处理（置灰是提示不是门禁：宁可让用户点一下看到具名
      // toast，也不误灰一个合法的枝）。
      const branch = branches.get(msg._id);
      ops.push({
        key: 'branch',
        label: '立枝',
        run: () => void core.branchFromMessage(latest(), sid),
        ...(branch && !branch.ok ? { disabled: true } : {}),
        title: branch && !branch.ok ? branch.reason : '从这条另起一枝：本卷原样保留，新枝复制到此为止的历史',
      });
      return ops;
    },
    [core, regionMsgs, regionsRef],
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
      // 可立枝判据：**每卷一趟**派生（O(事件数 + 消息数)）——逐块问 = 每块一次整段
      // fold（长卷拖帧，见 session-branch.deriveBranchPoints）。判据随缓存戳走：
      // 未落定批次跑完/锚点变化 ⇒ 戳变 ⇒ 该块的 ops 重算（置灰态不粘旧判定）。
      const branches = core.branchPoints(
        r.sessionNum,
        msgs.filter((m) => m.role === 'user' || m.role === 'assistant'),
      );
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
        const branch = branches.get(msg._id);
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
          const ops = msgOpsFor(msg, stateOps, retrace, r.sessionNum, branches);
          opsCacheRef.current.set(b.id, { msg, ops, stamp, regionMsgs });
          opsByBlock.set(b.id, ops);
        }
      }
    }
    return out;
  }, [regions, regionMsgs, core, msgOpsFor]);

  return { opsByBlock: derived.opsByBlock, branchGrips: derived.branchGrips };
}
