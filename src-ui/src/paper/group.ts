// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/group — 工作单元封套 pass（stream-rhythm 刀1：docs/plans/stream-rhythm-plan.md §2）。
//
// 版式语法表的执行面：translate 产出的块序列 → 工作单元（WorkUnit[]）。
// 单元 = 一次具有内在关系的 Agent 工作行为（原方案 §二第二层），是节奏渲染
// （刀2：单元内紧 / 单元间留白 / 转折放空）与 TOC 阶段导航（刀4）的消费源。
//
// 两条宪法（计划 §2.4 对审修正）：
//   1. 封口纪律（seal）：已封口单元不可变——id 锚首成员、成员只增不减。
//      「稳定版式」是回顾性稳定：封口前缀稳定，活尾（streaming 消息的块）天生临时。
//   2. 跨消息前瞻禁止（host）：挂靠（夹注吸入下一工作单元）只在同消息内发生；
//      已封口消息的夹注永不跨消息重挂——这是封口不变性的结构保证。
//
// 单元种类（版式语义，非工具语义）：
//   user       来文——工作起点，自成单元（新阶段）
//   work       工作单元——tool / toolgroup / code / subagent 连续运行（含挂靠夹注）
//   recovery   恢复单元——error 块起的头（Error → Retry），布局给转折放空
//   narrative  叙述单元——markdown / diff 连续段（正文 / 围栏）
//   anchor     锚点——plan 卡（工作阶段落款语义）
//   annotation 注疏——notice（稀缺大事）
//   terminal   墓碑——turn-error（回合终止失败，贴回合尾）
//   artifact   产物——未知 / 资产 kind（开放面兜底，不猜语义）

import type { ChatMessage } from '../ui/message-model';
import type { SourcedBlock } from './block-model';

export type UnitKind = 'user' | 'work' | 'recovery' | 'narrative' | 'anchor' | 'annotation' | 'terminal' | 'artifact';

export interface WorkUnit {
  /** 单元 id：锚首成员块 id（`u:{blockId}`）——前缀扩展下 id 稳定。 */
  id: string;
  kind: UnitKind;
  /** 成员块 id（流序）；封口后只增不减。 */
  memberIds: string[];
  /** 封口 = 全部成员来自非 streaming 消息（回顾性稳定的边界）。 */
  sealed: boolean;
}

/** 消息是否已封口（user/notice 到达即整条封口；assistant 待 status 离开 streaming）。 */
export function sealedMessageIdsOf(msgs: readonly ChatMessage[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'assistant' || m.status !== 'streaming') set.add(m._id);
  }
  return set;
}

/** 块是否携带错误语义（转折判据：tool/code 自身 error；组头看子项）。 */
export function isErrorishBlock(b: SourcedBlock): boolean {
  if (b.kind === 'tool' || b.kind === 'code') return (b.payload as { status?: string }).status === 'error';
  if (b.kind === 'toolgroup')
    return ((b.payload as { items?: Array<{ status?: string }> }).items ?? []).some((i) => i.status === 'error');
  if (b.kind === 'subagent') return (b.payload as { status?: string }).status === 'error';
  return false;
}

export interface GroupOpts {
  /** 消息封口判定（缺省 = 全部封口——历史卷回放 / 无 store 上下文）。 */
  isSealedMessage?: (messageId: string) => boolean;
}

/** 块序列 → 工作单元（纯函数；组头子块强制归组头所在单元，不按自身 kind 拆散）。 */
export function groupWorkUnits(blocks: readonly SourcedBlock[], opts?: GroupOpts): WorkUnit[] {
  const sealedOf = opts?.isSealedMessage ?? (() => true);
  const msgOf = new Map<string, string>();
  const headerOfChild = new Map<string, string>(); // toolgroup/subagent 子块 → 组头 id
  for (const b of blocks) {
    msgOf.set(b.id, b.source.messageId);
    if (b.kind === 'toolgroup' || b.kind === 'subagent') {
      for (const c of (b.payload as { childIds?: string[] }).childIds ?? []) headerOfChild.set(c, b.id);
    }
  }

  const units: WorkUnit[] = [];
  const assigned = new Map<string, WorkUnit>(); // 块 id → 所属单元（强制归组查表）
  let cur: WorkUnit | null = null; // 开放中的单元（工作/叙述/产物可续收成员）
  let hosts: string[] = []; // 待挂靠夹注（只吸入同消息的工作/恢复单元）

  const sealedOfMembers = (ids: readonly string[]): boolean => ids.every((m) => sealedOf(msgOf.get(m) ?? ''));

  /** 收口开放单元：sealed 以收口时的最终成员面定（成员只增不减 → 封口后不回改）。 */
  const closeUnit = (): void => {
    if (!cur) return;
    cur.sealed = sealedOfMembers(cur.memberIds);
    units.push(cur);
    cur = null;
  };

  /** 待挂夹注落叙述单元（调用不变量：hosts 非空 ⇒ cur 为 null——夹注只在
   *  序列边界待挂；此处防御性先收口，保证即便不变量松弛顺序也不倒置）。 */
  const flushHosts = (): void => {
    for (const h of hosts) {
      closeUnit();
      const u: WorkUnit = { id: `u:${h}`, kind: 'narrative', memberIds: [h], sealed: sealedOfMembers([h]) };
      units.push(u);
      assigned.set(h, u);
    }
    hosts = [];
  };

  /** 非工作类单元开启（来文/注疏/锚点/墓碑——单成员即收）：先按序清空挂靠夹注。 */
  const startOwnUnit = (k: UnitKind, b: SourcedBlock): void => {
    flushHosts();
    closeUnit();
    const u: WorkUnit = { id: `u:${b.id}`, kind: k, memberIds: [b.id], sealed: sealedOfMembers([b.id]) };
    units.push(u);
    assigned.set(b.id, u);
  };

  /** 工作/恢复类单元开启：同消息后缀夹注吸入（挂靠），单元保持开放续收。 */
  const startWorkUnit = (k: 'work' | 'recovery', b: SourcedBlock): void => {
    const msg = b.source.messageId;
    let split = hosts.length; // 后缀同消息的起点
    while (split > 0 && msgOf.get(hosts[split - 1]) === msg) split -= 1;
    const absorbed = hosts.slice(split);
    hosts = hosts.slice(0, split);
    flushHosts();
    closeUnit();
    const memberIds = [...absorbed, b.id];
    cur = { id: `u:${memberIds[0]}`, kind: k, memberIds, sealed: false };
    for (const m of memberIds) assigned.set(m, cur);
  };

  for (const b of blocks) {
    // 组头子块：强制归组头单元（子块 kind 不参与分派——subagent 组内的
    // markdown/plan 不拆散父单元；组头先入 assigned，子块随后追加）
    const header = headerOfChild.get(b.id);
    if (header !== undefined) {
      const u = assigned.get(header);
      if (u) {
        u.memberIds.push(b.id);
        assigned.set(b.id, u);
      }
      continue;
    }

    // 封口纪律的执行面：单元不跨消息——新消息的块先收口上一消息的开放单元
    // （上一消息已封 → 单元随即封口；活尾只剩当前 streaming 消息的单元，
    //  已封消息的内容永不滞留活尾）。组头子块同消息，不受此守卫影响。
    if (cur && msgOf.get(cur.memberIds[0]) !== b.source.messageId) closeUnit();

    switch (b.kind) {
      case 'user':
        startOwnUnit('user', b);
        break;
      case 'notice':
        startOwnUnit('annotation', b);
        break;
      case 'plan':
        startOwnUnit('anchor', b);
        break;
      case 'turn-error':
        startOwnUnit('terminal', b);
        break;
      case 'markdown':
      case 'diff':
        if (cur?.kind !== 'narrative') {
          flushHosts();
          closeUnit();
          cur = { id: `u:${b.id}`, kind: 'narrative', memberIds: [b.id], sealed: false };
          assigned.set(b.id, cur);
        } else {
          cur.memberIds.push(b.id);
          assigned.set(b.id, cur);
        }
        break;
      case 'reasoning':
        // 思考挂靠：有开放单元即并入（工作/叙述/产物内的夹注——顺序恒正
        //  确，且只在同消息工作单元「首」处经 startWorkUnit 吸入后缀）；
        //  序列边界（cur 空）才待挂，等待吸入下一同消息工作单元。
        if (cur) {
          cur.memberIds.push(b.id);
          assigned.set(b.id, cur);
        } else {
          hosts.push(b.id);
        }
        break;
      case 'tool':
      case 'code':
      case 'toolgroup':
      case 'subagent': {
        const errorish = isErrorishBlock(b);
        if (cur && (cur.kind === 'work' || cur.kind === 'recovery')) {
          if (errorish && cur.kind === 'work') {
            // 转折：error 起新恢复单元（Error → Retry 工作单元 B）
            startWorkUnit('recovery', b);
          } else {
            cur.memberIds.push(b.id);
            assigned.set(b.id, cur);
          }
        } else {
          startWorkUnit(errorish ? 'recovery' : 'work', b);
        }
        break;
      }
      default:
        // 未知 / 资产 kind：产物单元（连续同类合并；开放面不猜语义）
        if (cur?.kind !== 'artifact') {
          flushHosts();
          closeUnit();
          cur = { id: `u:${b.id}`, kind: 'artifact', memberIds: [b.id], sealed: false };
          assigned.set(b.id, cur);
        } else {
          cur.memberIds.push(b.id);
          assigned.set(b.id, cur);
        }
        break;
    }
  }
  flushHosts();
  closeUnit();
  return units;
}

/** 块 → 所属单元 + 是否首成员（布局消费：首成员上方的间距档由单元 kind 定）。 */
export function unitMembership(units: readonly WorkUnit[]): Map<string, { unit: WorkUnit; isFirst: boolean }> {
  const out = new Map<string, { unit: WorkUnit; isFirst: boolean }>();
  for (const u of units) {
    for (let i = 0; i < u.memberIds.length; i++) {
      out.set(u.memberIds[i], { unit: u, isFirst: i === 0 });
    }
  }
  return out;
}

/** 单元首成员上方的间距档（刀2 布局消费；user 档保留 B1 来文规则的兼容位）。 */
export type RhythmLead = 'stage' | 'recovery' | 'unit';

export function leadOf(unit: WorkUnit): RhythmLead {
  if (unit.kind === 'user') return 'stage';
  if (unit.kind === 'recovery' || unit.kind === 'terminal') return 'recovery';
  return 'unit';
}

/** 布局栈节奏档（canvas-math.RhythmClass 的块级映射结果）。 */
export interface RhythmAssign {
  /** 块 id → 节奏档（intra = 单元内非首成员；首成员档由 leadOf 定）。 */
  rhythmOf: Map<string, 'intra' | 'unit' | 'recovery' | 'stage'>;
  /** 阶段首块（leadOf = stage 的来文块）——渲染层阶段细线消费。 */
  stageLeadIds: ReadonlySet<string>;
}

/** 块序列 + 单元归属 → 节奏档分派（刀3：单一真源——PaperPanel 布局栈与
 *  布局级封口测试共用同一映射，防测试/生产漂移）。blocks 传**布局栈实排
 *  序列**（折叠摘除后的——组头子块被摘时不需要节奏档，缺席即无键）。 */
export function rhythmAssign(
  blocks: ReadonlyArray<{ id: string }>,
  membership: ReadonlyMap<string, { unit: WorkUnit; isFirst: boolean }>,
): RhythmAssign {
  const rhythmOf = new Map<string, 'intra' | 'unit' | 'recovery' | 'stage'>();
  const stageLeadIds = new Set<string>();
  for (const b of blocks) {
    const m = membership.get(b.id);
    if (!m) continue;
    const rhythm = m.isFirst ? leadOf(m.unit) : 'intra';
    rhythmOf.set(b.id, rhythm);
    if (rhythm === 'stage') stageLeadIds.add(b.id);
  }
  return { rhythmOf, stageLeadIds };
}
