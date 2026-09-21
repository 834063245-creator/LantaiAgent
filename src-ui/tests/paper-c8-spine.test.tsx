// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Stage-3 书脊列守护（2026-08-25 用户反馈收敛）：SpineRack = 画布空间导航器。
// 职责：左键定位 / 拖动落位 / hover 合卷（改名·删除在侧边栏，右键菜单已移除）。
// 旧 C8 语义（单击换卷 / 另起一卷 / 双击改名 / 卷目目录）随拆旧迭代拆除；
// 本文件钉当前行为。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import {
  fitLabel,
  labelWeight,
  planSpines,
  SPINE_PAD_V,
  SPINE_SEAM,
  SPINE_THIN_H,
  SpineRack,
  type SpineSlot,
  spineRows,
  spineWantRows,
} from '../src/plugins/builtin/canvas-nav/SpineRack';

/** 一排脊占的总高（含书缝）——分配器判据的同一把尺子。 */
function stackOf(plan: SpineSlot[], pitch: number): number {
  return (
    plan.reduce((s, p) => s + (p.thin ? SPINE_THIN_H : SPINE_PAD_V + p.rows * pitch), 0) +
    SPINE_SEAM * Math.max(0, plan.length - 1)
  );
}

import { getCanvasStore, resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { getChatStore } from '../src/ui/chat-store';

/** 最小 ChatCore 桩：SpineRack 只消费这几个面。listSavedSessions 供卷序
 *  合流（spineOrder，对齐侧边栏排序）——空盘 = 未落盘按卷号新者上。 */
function makeCore(panelId: string) {
  return {
    panelId,
    switchSession: vi.fn(),
    closeSession: vi.fn(),
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSessionFile: vi.fn(),
    listSavedSessions: vi.fn(async () => []),
  } as unknown as ChatCore & Record<string, ReturnType<typeof vi.fn>>;
}

function seedSessions(panelId: string, sessions: Array<{ id: number; label: string }>, activeIdx: number): void {
  getChatStore(panelId).sess.setState({
    sessions,
    activeIdx,
    sessionTokens: {},
    nextSessionId: sessions.length + 1,
  });
}

function bootSpine(panelId: string, sessions: Array<{ id: number; label: string }>, activeIdx: number) {
  const core = makeCore(panelId);
  useCoreStore.getState().setChatCore(core);
  seedSessions(panelId, sessions, activeIdx);
  const ctx = new Context();
  new SpaceService(ctx); // 激活 activeSpace()（书脊命令通道）
  return { core };
}

describe('SpineRack — 画布空间导航器（定位 / 拖落 / hover 合卷）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetCanvasStoresForTests();
    useCanvasViewStore.getState().requestFocus(null);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('恒显：两卷出两条书脊 + 会话侧边栏开关；当前卷 sr-active（卷序对齐侧边栏：未落盘按卷号新者上）', async () => {
    bootSpine(
      'sr-t1',
      [
        { id: 1, label: '卷首名甲' },
        { id: 2, label: '卷首名乙' },
      ],
      0,
    );
    await act(async () => {
      root?.render(<SpineRack />);
    });
    const spines = container!.querySelectorAll('.sr-spine');
    expect(spines).toHaveLength(2);
    expect(container!.querySelector('.sr-sidebar-toggle')).not.toBeNull(); // 会话侧边栏开关
    // 卷序 = 侧边栏合流序（savedAt 缺省 → 卷号倒序）：乙(2) 在前，甲(1) 当前
    expect(spines[0].className).not.toContain('sr-active');
    expect(spines[1].className).toContain('sr-active');
    const labels = [...container!.querySelectorAll('.sr-label')].map((e) => e.textContent);
    expect(labels).toEqual(['卷首名乙', '卷首名甲']);
  });

  it('单卷也是一条脊（恒显语义）', async () => {
    bootSpine('sr-t2', [{ id: 1, label: '案卷 1' }], 0);
    await act(async () => {
      root?.render(<SpineRack />);
    });
    expect(container!.querySelectorAll('.sr-spine')).toHaveLength(1);
  });

  it('会话树「枝」：有父卷的脊带「枝」标（血缘来自清单投影的盘上行），根卷不带', async () => {
    const { core } = bootSpine(
      'sr-branch',
      [
        { id: 1, label: '父卷' },
        { id: 2, label: '枝卷' },
      ],
      0,
    );
    core.listSavedSessions.mockResolvedValue([
      { id: 1, label: '父卷', msgCount: 2, savedAt: '2026-01-01T00:00:00Z' },
      { id: 2, label: '枝卷', msgCount: 1, savedAt: '2026-02-01T00:00:00Z', parentId: 1 },
    ]);
    await act(async () => {
      root?.render(<SpineRack />);
    });
    await act(async () => {}); // listSavedSessions promise flush
    const tags = [...container!.querySelectorAll('.sr-spine .sr-branch-tag')];
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toBe('枝');
    // 卷序仍按合流序（savedAt 倒序：枝卷在前），枝标跟着它自己的脊走
    const labels = [...container!.querySelectorAll('.sr-label')].map((e) => e.textContent);
    expect(labels).toEqual(['枝卷', '父卷']);
    const branchSpine = tags[0].closest('.sr-spine');
    expect(branchSpine?.querySelector('.sr-label')?.textContent).toBe('枝卷');
    expect(branchSpine?.querySelector('.sr-spine-main')?.getAttribute('title')).toContain('（枝）');
  });

  it('左键 = 定位器：切活跃会话 + 发定位请求（当前卷也飞）', async () => {
    const { core } = bootSpine(
      'sr-t3',
      [
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
        { id: 3, label: 'c' },
      ],
      2,
    );
    await act(async () => {
      root?.render(<SpineRack />);
    });
    const mains = [...container!.querySelectorAll('.sr-spine-main')] as HTMLElement[];
    act(() => {
      mains[1].click(); // 卷 id=2 → idx 1
    });
    expect(core.switchSession).toHaveBeenCalledWith(1);
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('2');
    // 点当前卷（id=3，新序渲染在首位）：定位器语义 = 仍发定位请求（飞回当前流区）
    act(() => {
      mains[0].click();
    });
    expect(useCanvasViewStore.getState().pendingFocusId).toBe('3');
  });

  it('右键不弹菜单（书脊右键已移除——改名/删除归侧边栏）', async () => {
    bootSpine('sr-t4', [{ id: 7, label: '旧名' }], 0);
    await act(async () => {
      root?.render(<SpineRack />);
    });
    const main = container!.querySelector('.sr-spine-main') as HTMLElement;
    act(() => {
      main.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(container!.querySelector('.sr-menu')).toBeNull();
  });

  it('hover 小卡合卷：悬停某脊 → 架级单卡出该卷全名 + 点合卷 → core.closeSession(idx)', async () => {
    // 2026-09-21 重做批：小卡由「每脊一枚」改**架级单卡**（住 .sr-list 之外）——
    // 每脊一枚有两处结构病（卡在滚动容器里撑大 scrollHeight；脊一裁题名就把
    // 定位在脊外的卡一并裁掉）。用户操作序列不变：悬停一根脊 → 出卡 → 点合卷。
    const { core } = bootSpine(
      'sr-t5',
      [
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
      ],
      0,
    );
    await act(async () => {
      root?.render(<SpineRack />);
    });
    expect(container!.querySelector('.sr-card')).toBeNull(); // 未悬停不出卡
    const mains = [...container!.querySelectorAll('.sr-spine-main')] as HTMLElement[];
    act(() => {
      mains[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // 新序 b(id=2) 在前位
    });
    expect(container!.querySelector('.sr-hover-title')?.textContent).toBe('b');
    const close = container!.querySelector('.sr-close-btn') as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    act(() => {
      close.click(); // store idx 1
    });
    expect(core.closeSession).toHaveBeenCalledWith(1);
  });

  it('运行中卷：小卡合卷钮禁用（不可半途 dispose agent）', async () => {
    const { core } = bootSpine(
      'sr-t6',
      [
        { id: 1, label: '跑着的' },
        { id: 2, label: '闲的' },
      ],
      0,
    );
    const exec = createExecState();
    act(() => {
      agentSessionState.setExec('sr-t6', 1, exec);
    });
    await act(async () => {
      root?.render(<SpineRack />);
    });
    act(() => {
      exec.beginRun('turn'); // v43：运行态 = 账上的活记录
    });
    const mains = [...container!.querySelectorAll('.sr-spine-main')] as HTMLElement[];
    act(() => {
      mains[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // 新序：跑着的(id=1) 在后位
    });
    const close = container!.querySelector('.sr-close-btn') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    act(() => {
      close.click();
    });
    // 运行中点击（disabled 按钮不触发 onClick）不得触达 closeSession
    expect(core.closeSession).not.toHaveBeenCalled();
    act(() => {
      exec.stopAll();
    });
  });

  it('合卷应答竞态：在途旧应答迟到——被合卷的卷不得闪回书脊（2026-09-14 实机）', async () => {
    // 合卷一瞬会连发数次磁盘清单拉取（exec/agent/space/sess 四条订阅各触发一次
    // resync），而 listSavedSessions 内部是「list_volumes + 每卷并行读文件」的多跳
    // 异步——先发的应答完全可能后到。旧实现把合流结果直接写进 sessions，且异步续体
    // 里用的是**发起那一刻捕获的摊开集**：迟到的旧应答把「还没合卷」的清单写回 →
    // 被合卷的书脊闪回一下（用户实机所见）。
    // 2026-09-18 起拉取另加单飞（并发事件合并为一次，尾随补一次）——本用例同时钉
    // 两件事：①迟到旧应答不得回灌；②被合并掉的那次触发有尾随补拉（清单终会收敛）。
    const core = makeCore('sr-race');
    type Saved = { id: number; label: string; msgCount: number; savedAt: string };
    const pending: Array<(rows: Saved[]) => void> = [];
    core.listSavedSessions = vi.fn(
      () =>
        new Promise<Saved[]>((resolve) => {
          pending.push(resolve);
        }),
    );
    useCoreStore.getState().setChatCore(core);
    seedSessions(
      'sr-race',
      [
        { id: 1, label: '甲' },
        { id: 2, label: '乙' },
      ],
      0,
    );
    new SpaceService(new Context()); // 激活 activeSpace()（书脊命令通道）

    await act(async () => {
      root?.render(<SpineRack />);
    });
    expect(container!.querySelectorAll('.sr-spine')).toHaveLength(2);
    expect(pending).toHaveLength(1); // 首拉在途

    // 合卷甲（真实路径 core.closeSession 最终也只落 sess store 这一写）
    await act(async () => {
      seedSessions('sr-race', [{ id: 2, label: '乙' }], 0);
    });
    expect(container!.querySelectorAll('.sr-spine')).toHaveLength(1);
    // 单飞：在途期间的触发不另发请求（旧实现这里会连发第二次）
    expect(pending).toHaveLength(1);

    // 先发的旧应答（含被合卷的甲）迟到落地 → 书脊不得把甲写回来
    await act(async () => {
      pending[0]([
        { id: 1, label: '甲', msgCount: 3, savedAt: '2026-09-14T02:00:00.000Z' },
        { id: 2, label: '乙', msgCount: 3, savedAt: '2026-09-13T02:00:00.000Z' },
      ]);
      await Promise.resolve();
    });
    expect([...container!.querySelectorAll('.sr-label')].map((e) => e.textContent)).toEqual(['乙']);

    // 尾随补拉：被合并的那次触发在首拉 settle 后补齐（清单收敛，不靠下一次用户动作）
    await act(async () => {
      await Promise.resolve();
    });
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]([{ id: 2, label: '乙', msgCount: 4, savedAt: '2026-09-13T02:00:00.000Z' }]);
      await Promise.resolve();
    });
    expect([...container!.querySelectorAll('.sr-label')].map((e) => e.textContent)).toEqual(['乙']);
  });

  it('拖动落位：抽书放桌——松手 place 到吸附网格空列', async () => {
    bootSpine('sr-t7', [{ id: 1, label: 'a' }], 0);
    await act(async () => {
      root?.render(<SpineRack />);
    });
    // 画布坐标源（书脊跨组件读取 .pp-canvas 视口 rect——React root 会清空
    // 容器，所以渲染后再铺画布元素）
    const canvas = document.createElement('div');
    canvas.className = 'pp-canvas';
    container!.appendChild(canvas);
    const main = container!.querySelector('.sr-spine-main') as HTMLElement;
    act(() => {
      main.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 20 }));
    });
    expect(container!.querySelector('.sr-drag-ghost')).not.toBeNull(); // 幽灵预览
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 2600, clientY: 30 }));
    });
    // 世界 x=2600 空位（无重叠）→ 拖到哪落哪（P6 区间模型，不吸附）；y=用户落点 30
    expect(getCanvasStore('sr-t7').getState().spread['1']).toEqual({
      anchorX: 2600,
      anchorY: 30,
      width: 1440,
    });
  });

  /* ── 2026-09-21 四批（设计感复原 · 戊·墨缘题签脊）契约 ─────────────────
   * 二批的「脊高四档 px」换成**行数**：像素高 = 8px 内距 + 整数行 × 栏距，
   * 行数由「内容需要几行」与「列高够几行」共同定。 */

  it('脊行四档：按题名权重分行（CJK 1 字、拉丁 0.55 字），边界落在档位上', () => {
    expect(labelWeight('哈喽？')).toBe(3);
    expect(labelWeight('test')).toBeCloseTo(2.2, 5);
    expect(spineWantRows('哈喽？')).toBe(3); // 3 字
    expect(spineWantRows('测试，能看到图吗')).toBe(3); // 8 字（≤9 档）
    expect(spineWantRows('看看你手里有多少个工具')).toBe(4); // 10 字（9–15 档）
    expect(spineWantRows('测试渲染效果，输出一些极其复杂的数学公式给我')).toBe(5); // 21 字（15–22 档）
    expect(spineWantRows('测试，kind工具全部拿来给我生成出来个样板，内容自定，…')).toBe(6); // >22 档
  });

  it('分配器①自然档 / ②降档档：宽敞不动它，挤了按行降档（永不半行），13 卷 1010px 落②全 3 行', () => {
    // 真值：列高 946 = 1010 − 顶底内距 12 − 案卷扣 46 − 扣下书缝 6；栏距 19.5。
    const wants = [
      4,
      4,
      3,
      6,
      6,
      3,
      5,
      3,
      3,
      6,
      5,
      3,
      6, // 13 卷自然行数（真卷名）
    ];
    const plan = planSpines(wants, 946, 19.5, 4);
    expect(plan.every((p) => !p.thin)).toBe(true); // 走②，不该书口化
    expect(plan.every((p) => p.rows === 3)).toBe(true);
    expect(stackOf(plan, 19.5)).toBeLessThanOrEqual(946);
    // 宽裕时保持自然行数（不无谓降档）
    expect(planSpines([4, 3, 5], 400, 19.5, 0).map((p) => p.rows)).toEqual([4, 3, 5]);
  });

  it('分配器③书口档：连下限都放不下 ⇒ 活跃卷整脊 + 其余书口（20 卷 1010px 由滚 498px 变零滚）', () => {
    // 20 卷 / 1010px：②全 3 行 = 20×66.5 + 19×6 = 1444 > 946 ⇒ 旧行为整列滚 498px
    const wants = new Array(20).fill(4) as number[];
    const plan = planSpines(wants, 946, 19.5, 6);
    expect(plan[6].thin).toBe(false); // 活跃卷永不书口化
    expect(plan[6].rows).toBe(4); // 且保持**自然高**（不是下限）
    expect(plan.filter((p) => p.thin)).toHaveLength(19);
    expect(stackOf(plan, 19.5)).toBeLessThanOrEqual(946); // 一屏放得下 ⇒ 零滚
    // 没有活跃卷（activeIdx 越界）时保首位整脊，不出现「全是书口」
    const noActive = planSpines(wants, 946, 19.5, -1);
    expect(noActive.filter((p) => !p.thin)).toHaveLength(1);
  });

  it('分配器③书口档：极端密度（24 卷 620px 矮窗）仍放不下 ⇒ 交给列内滚，但先省下一大截', () => {
    const wants = new Array(24).fill(4) as number[];
    const before = 24 * (SPINE_PAD_V + 3 * 19.5) + 23 * SPINE_SEAM; // 旧行为（全 3 行）
    const plan = planSpines(wants, 556, 19.5, 0);
    expect(plan.filter((p) => p.thin)).toHaveLength(23);
    expect(stackOf(plan, 19.5)).toBeLessThan(before); // 省下一大截（仍需滚，但滚得少）
    expect(plan[0].rows).toBe(4);
  });

  it('题名截字：容量 = 2 栏 × 行数，放不下留一格给省略号（竖排 ellipsis 不生效）', () => {
    expect(fitLabel('哈喽？', 3)).toBe('哈喽？'); // 3 ≤ 5 格，原样
    expect(fitLabel('看看你手里有多少个工具', 4)).toBe('看看你手里有多…'); // 7 格 + 省略号
    expect(fitLabel('哈喽？', 3)).not.toContain('…');
    // 拉丁半角算 0.55 格：'test test' 权重 4.95 → 5 格内放得下
    expect(fitLabel('test test', 3)).toBe('test test');
    // 3 行档容量 5 格：'测试，kind…' 的 k/i/n 各 0.55 格，d 越界
    expect(fitLabel('测试，kind工具全部拿来给我生成出来个样板', 3)).toBe('测试，kin…');
  });

  it('spineRows：盘上块数/落盘时间/血缘不被内存摊开集盖掉（内存只给 {id,label}）', () => {
    // 病灶：调用点曾填死 msgCount: 0，而 0 不是 nullish ⇒ mergeSessionRows 的
    // `o.msgCount ?? prev?.msgCount` 把盘上真值整个盖掉（小卡「Nº 7 · 0 块」）。
    const rows = spineRows(
      [
        { id: 7, label: '内存新名' },
        { id: 9, label: '未落盘' },
      ],
      [{ id: 7, label: '盘上旧名', msgCount: 563, savedAt: '2026-09-20T11:41:34.593Z', parentId: 3 }],
    );
    expect(rows.find((r) => r.id === 7)).toMatchObject({
      name: '内存新名', // 内存最新优先
      msgCount: 563, // 盘上真值不得被 0 盖掉
      branch: true, // 血缘只在盘上那一源
      savedAt: '2026-09-20T11:41:34.593Z',
    });
    expect(rows.find((r) => r.id === 9)).toMatchObject({
      name: '未落盘',
      msgCount: 0,
      branch: false,
      savedAt: '',
    });
  });

  it('档号恒显：每条脊都有 .sr-num（题名被两栏截断后唯一可靠的身份）', async () => {
    bootSpine('sr-num', [{ id: 21, label: '来，帮我统计领先远端多少commit和对应的改动量' }], 0);
    await act(async () => {
      root?.render(<SpineRack />);
    });
    expect([...container!.querySelectorAll('.sr-spine .sr-num')].map((e) => e.textContent)).toEqual(['21']);
  });
});
