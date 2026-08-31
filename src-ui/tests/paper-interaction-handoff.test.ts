// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸壳交互承接守护（施工单 docs/plans/paper-interaction-handoff.md）
//
// 背景：纸壳唯一主界面（a621b1e6）拆除旧观测台时，交互承接断层——Agent/数据侧
// 有交互出口，UI 侧无消费方（plan 审批回调丢失、停止按钮缺失、消息操作无入口等）。
//
// 本测试用 KNOWN_DEAD 收敛机制把「交互出口 × 消费方」对账固化成机器断言：
//   - 展示面（part kind 渲染器 + EventKind 覆盖）是硬锚，永远全绿；
//   - 交互面用探针探测断链，实际断链 ⊆ KNOWN_DEAD（新增断链未登记会红）；
//   - KNOWN_DEAD 每条必须真的是断链（修复后从清单移除该 id，测试才继续绿）。
//
// 修复纪律：施工单修一条，销账一条（删 KNOWN_DEAD 里对应 id），直到清单清空。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinRendererDefs } from '../src/composition/renderer-service';
import { translateMessages } from '../src/paper/translate';
import type { AssistantMessage } from '../src/ui/message-model';

const SRC = join(process.cwd(), 'src');
const APP = join(SRC, 'app');
const BUILTIN = join(SRC, 'plugins', 'builtin');
const PLAN_DIR = join(SRC, 'agent', 'plan');

/** 读取文件文本（不存在返回空串，避免测试崩溃）。 */
function read(p: string): string {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/** 递归收集目录下全部 .ts/.tsx 文件文本拼接（静态扫描用）。
 *  excludeBasename 跳过指定文件名（提供方自身不算消费方）。 */
function readAllTs(dir: string, excludeBasename: string[] = []): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    const entries = readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !excludeBasename.includes(e.name)) out.push(read(p));
    }
  };
  walk(dir);
  return out.join('\n');
}

/** 截取命名函数体（粗略提取，够检测器用）。 */
function functionBody(src: string, name: string): string {
  const m = src.match(new RegExp(`function ${name}\\b[\\s\\S]*?\\n}`));
  return m?.[0] ?? '';
}

/* ═══ 断链探针（每一条对应施工单一行）═══ */

interface DeadLinkProbe {
  id: string;
  note: string;
  isDead: () => boolean;
}

/** 构造一条带 PlanPart（含 _callback）的助手消息，供转译探针使用。 */
function planPartMessage(): AssistantMessage {
  return {
    role: 'assistant',
    _id: 'm1',
    status: 'done',
    respondingTo: 'm0',
    parts: [
      {
        type: 'plan',
        planId: 'plan-x',
        planFilePath: '/p/.lantai/plans/plan-x.md',
        content: '1. 方案',
        status: 'pending',
        _callback: () => {},
      },
    ],
  };
}

const PROBES: DeadLinkProbe[] = [
  {
    id: 'plan-callback-translate',
    note: '#1 PlanPart._callback 在 paper 转译时被丢弃 → 纸块无回调，审批无法接线',
    isDead: () => {
      const blocks = translateMessages([planPartMessage()]);
      const plan = blocks.find((b) => b.kind === 'plan');
      if (!plan) return true; // 连 plan 块都没有更是断
      return typeof (plan.payload as { _callback?: unknown })._callback !== 'function';
    },
  },
  {
    id: 'plan-approval-ui',
    note: '#2 PlanBody 只渲染内容，无批准/修改/拒绝按钮',
    isDead: () => {
      const body = functionBody(read(join(SRC, 'composition', 'renderer-service.tsx')), 'PlanBody');
      return !body.includes('onClick');
    },
  },
  {
    id: 'plan-exit-timeout',
    note: '#3 exit_plan_mode 永久挂起等审批回调，无超时兜底（对比 PromptShelf 有 CARD_TIMEOUT_MS）',
    isDead: () => {
      const src = read(join(PLAN_DIR, 'plan-tools.ts'));
      return !/setTimeout|Promise\.race/.test(src);
    },
  },
  {
    id: 'stop-button',
    note: '#4 Agent 运行中无停止入口（chat-core.abort 活着，纸壳没接）——Stage-4 后停止钮在创作坞（ComposerDock）',
    isDead: () =>
      !read(join(BUILTIN, 'paper-shell', 'PaperPanel.tsx')).includes('abort') &&
      !read(join(BUILTIN, 'compose-dock', 'ComposerDock.tsx')).includes('abort'),
  },
  {
    id: 'message-ops',
    note: '#5 消息操作（复制/编辑/重发/重试）回调在 chat-core 活着，纸壳无入口',
    isDead: () =>
      !/editUserMessage|resendUserMessage|retryAssistant|copyText/.test(
        readAllTs(APP, ['chat-core.ts']) +
          readAllTs(join(BUILTIN, 'paper-shell')) +
          readAllTs(join(BUILTIN, 'compose-dock')) +
          readAllTs(join(BUILTIN, 'canvas-nav')) +
          readAllTs(join(BUILTIN, 'settings-domain')),
      ),
  },
  {
    id: 'dataflow-display',
    note: '#6 dataflow 信号退役：dataflow-store.ts 已删除（DataflowPanel 随 chrome 退役，死信号不再养）',
    isDead: () => existsSync(join(SRC, 'state', 'dataflow-store.ts')),
  },
  {
    id: 'slash-at-composer',
    note: '#7 斜杠命令 / @提及注册槽"待纸壳复用"未兑现，composer 是裸 textarea——Stage-4 后斜杠在创作坞（ComposerDock）',
    isDead: () => {
      const pp = read(join(BUILTIN, 'paper-shell', 'PaperPanel.tsx'));
      const dock = read(join(BUILTIN, 'compose-dock', 'ComposerDock.tsx'));
      return !/slash|AtAuto/i.test(pp) && !/slash|AtAuto/i.test(dock);
    },
  },
  {
    id: 'plan-mode-ui-switch',
    note: '#8 虚承诺已删：plan-tools/prompt-sections 不再宣称「界面可直接切换执行模式」',
    isDead: () => {
      const pt = read(join(PLAN_DIR, 'plan-tools.ts'));
      const ps = read(join(SRC, 'composition', 'prompt-sections.ts'));
      return pt.includes('界面直接切换') || ps.includes('或界面切换');
    },
  },
];

/** 已知断链登记表——施工单修复一条就删一条，直到清空。 */
const KNOWN_DEAD: string[] = [];

/* ═══ 展示面守护（硬锚，永远全绿）═══ */

describe('纸壳展示面承接（硬锚）', () => {
  it('8 种 part kind 全有内置渲染器（展示面不缺，断层全在交互面）', () => {
    const kinds = new Set(builtinRendererDefs().map((r) => r.kind));
    const expected = ['user', 'markdown', 'reasoning', 'diff', 'tool', 'code', 'plan', 'notice'] as const;
    for (const k of expected) {
      expect(kinds.has(k), `缺少 kind 渲染器: ${k}`).toBe(true);
    }
  });

  it('chat-stream 覆盖全部 11 个 EventKind（事件面不缺 case）', () => {
    const src = read(join(SRC, 'ui', 'chat-stream.ts'));
    const kinds = [
      'TurnStarted',
      'Reasoning',
      'Text',
      'Message',
      'ToolDispatch',
      'ToolResult',
      'ToolProgress',
      'Usage',
      'Notice',
      'SessionChanged',
      'PlanReview',
    ] as const;
    for (const k of kinds) {
      expect(src.includes(`case EventKind.${k}:`), `chat-stream 缺 ${k} 分支`).toBe(true);
    }
  });
});

/* ═══ 交互面死链登记（KNOWN_DEAD 收敛）═══ */

describe('纸壳交互面承接（死链收敛，施工单 docs/plans/paper-interaction-handoff.md）', () => {
  it('实际断链 ⊆ 已知断链（新增断链未登记会红——先修代码，无法容忍就登记进 KNOWN_DEAD 并写明理由）', () => {
    const actualDead = PROBES.filter((p) => p.isDead()).map((p) => p.id);
    const unknown = actualDead.filter((id) => !KNOWN_DEAD.includes(id));
    expect(unknown, `发现未登记的断链：${unknown.join(', ')}`).toEqual([]);
  });

  it('已知断链逐条确认仍是断链（修复后从 KNOWN_DEAD 移除该 id 销账）', () => {
    const fixed = KNOWN_DEAD.filter((id) => {
      const probe = PROBES.find((p) => p.id === id);
      return probe ? !probe.isDead() : true;
    });
    const detail = fixed
      .map((id) => {
        const probe = PROBES.find((p) => p.id === id);
        return `  - ${id}: ${probe?.note ?? ''}`;
      })
      .join('\n');
    expect(fixed, `这些断链已修复但仍在 KNOWN_DEAD（请销账）：\n${detail}`).toEqual([]);
  });
});
