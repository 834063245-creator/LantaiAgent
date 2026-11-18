// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 记忆库快照 — durable 消息的形状与「该不该发」的纯判据（2026-11-18 变更驱动批）。
//
// 病史（两段，都要记住）：
//   ① 2026-10-28 之前：记忆坐 system prompt（卷首）。它是卷首里**唯一随用户操作
//      变化**的内容——写一条记忆就成一字节变化，其后**全部对话**按未缓存计费
//      （实测命中率 99% → 0.6%，一次 34.7 万 token 全价）。
//   ② 2026-10-28 → 2026-11-18：改走「请求载荷最后一条的 transient reminder」。
//      卷首稳了，但代价是**每步都重发整份快照**：实测 26 条项目记忆渲染成 2,114
//      tokens，落点正是缓存断点之后的 miss 段（同卷 miss 段通常只有 3.5K–7.7K）
//      ⇒ 每步 30%–60% 的未命中 token 在重付同一段不变内容的全价。语义上更糟：
//      副本每步在历史中段重新出现，模型分不清「固定快照」与「历史被改写」——
//      真机卷 121 三次把它读成「上下文被压缩了（记忆注入）」。
//
// 现行（对齐 DSH `agent-loop/src/runtime-context.ts` 的 `RuntimeContextProjection`）：
//   ① **未变不发**（可见历史里那份 === 当前内容 ⇒ 什么都不写）
//   ② **一次性落史**（durable user 消息：可回放、可压缩、靠前缀缓存复用）
//   ③ **被压缩遮蔽后自愈**（快照落在折叠区间内 ⇒ 补发一份）
//   ④ **取代声明**（新快照开头明说取代此前所有快照，含摘要里的内容）
//
// 本文件只有**纯函数**（不碰 Agent 状态）：Agent 侧只负责「按判据写一条消息」，
// 判据本身可单测、可离线复算。这样 agent.ts 不必为它继续膨胀。

import type { Message } from '../provider/types';

/** 首份快照的标题行（没有更早的版本可取代）。 */
export const MEMORY_SNAPSHOT_INTRO = '## 记忆库';

/** 后续快照的标题行——显式声明取代关系。没有这句话，模型看到历史中段冒出
 *  一块 `## 记忆库`，只能猜它是什么（真机卷 121 三次猜成「被压缩了」）。 */
export const MEMORY_SNAPSHOT_INTRO_SUPERSEDE = '## 记忆库（本次快照取代此前所有记忆库快照，含被压缩摘要里的内容）';

const FRAME_HEAD = '<system-reminder>\n';
const FRAME_TAIL = '\n</system-reminder>';

/** 构造一条记忆库快照消息（**durable**：进 session、可回放、可被压缩遮蔽）。
 *  @param snapshot - 记忆库正文（`loadPromptSection` 的产物）。
 *  @param supersedes - 本会话此前发过快照 ⇒ 加取代句。 */
export function buildMemorySnapshotMessage(snapshot: string, supersedes: boolean): Message {
  const intro = supersedes ? MEMORY_SNAPSHOT_INTRO_SUPERSEDE : MEMORY_SNAPSHOT_INTRO;
  return {
    role: 'user',
    content: `${FRAME_HEAD}${intro}\n${snapshot}${FRAME_TAIL}`,
  };
}

/** 这行内容是不是一条记忆库快照。 */
export function isMemorySnapshotMessage(content: string | undefined): boolean {
  if (!content) return false;
  return content.startsWith(`${FRAME_HEAD}${MEMORY_SNAPSHOT_INTRO}`);
}

/** 从一条已落史的快照消息里取回**快照正文**（与 `buildMemorySnapshotMessage`
 *  互逆）。变更判定需要「历史里那份」与「当前这份」逐字比对，而恢复/开卷之后
 *  内存镜像不作数（那卷的历史才是事实）。取不出来返回 null。
 *
 *  只拆自己构造的固定框架（两条已知 intro + 固定首尾），不是正则嗅探：
 *  拆法一旦与构造函数分叉，往返测试会先红。 */
export function memorySnapshotTextOf(content: string | undefined): string | null {
  if (!isMemorySnapshotMessage(content)) return null;
  const body = content as string;
  const headEnd = body.indexOf('\n', FRAME_HEAD.length);
  if (headEnd < 0 || !body.endsWith(FRAME_TAIL)) return null;
  return body.slice(headEnd + 1, body.length - FRAME_TAIL.length);
}

/** 「这一步该不该补一条快照」——`null` = 什么都不用写（绝大多数步）。
 *
 *  `visible`（折叠点之后可见的那份）决定**发不发**；`everPrior`（含被遮蔽的）
 *  决定**要不要声明取代**：被折叠遮蔽的旧快照可能还以摘要形式留在历史里。
 *  两个判据必须分开——混成一件事会出现「压缩后要么漏发、要么不发取代句」。 */
export function planMemorySnapshotSync(
  messages: readonly Message[],
  head: number,
  foldPoint: number,
  snapshot: string,
): { supersedes: boolean } | null {
  const { everPrior } = scanMemorySnapshots(messages, head);
  const { visible } = scanMemorySnapshots(messages, foldPoint);
  if (visible === snapshot) return null; // ① 未变不发
  return { supersedes: everPrior }; // ②③④ 补发；本会话发过 ⇒ 加取代句
}

/** 载荷里看得见的那段历史（`from` 起）里，记忆快照是什么状况。
 *
 *  两个答案一次扫描答完——它们判的是**不同的事**，混起来是错的：
 *  - `visible`：模型**这一轮真的看得到**的那份正文（取最新）；折叠点之前的
 *    快照模型看不见 = 没发过，要靠它触发补发（自愈）。
 *  - `everPrior`：本会话**曾经**发过（哪怕已被折叠遮蔽）。它只决定新快照要不要
 *    写「取代」——被遮蔽的那份可能还以摘要形式留在历史里，新快照必须声明覆盖它。 */
export function scanMemorySnapshots(
  messages: readonly Message[],
  from: number,
): { visible: string | null; everPrior: boolean } {
  let visible: string | null = null;
  let everPrior = false;
  for (let i = Math.max(0, from); i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text = memorySnapshotTextOf(m.content);
    if (text === null) continue;
    everPrior = true;
    visible = text;
  }
  return { visible, everPrior };
}
