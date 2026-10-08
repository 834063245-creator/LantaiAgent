// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 案卷侧栏**行操作几何稳定性**守护（2026-09-20 用户报「侧边栏点操作会话的功能按钮时经常跳变」）。
//
// 病灶（真 Chrome 台架 `prototype/sidebar-ops-jump-ab.html` 出数，290px 栏宽；
// 走位探针 `prototype/sidebar-ops-jump.probe.mjs`，读数见 `.report.before.json`）——**七处跳变，
// 同一条病因**：显隐/武装/提示都拿「在流里增删元素或改宽」表达，而它们全住在同一个 flex 行/列里
// ⇒ 每次交互都触发一次布局重排（指针底下那一行会跑）：
//   ① hover 任一行（案卷视图）：名区起点 50 → 34px（**−16px**），指针移开弹回——勾选格用
//      `visibility`（占位常留）而状态点用 `display:none`（摘出流），**两个槽位各说各话**；
//      枝视图同语义走单槽 `.ss-mark` ⇒ 位移 **0px**（同一件事两视角两种实现 = 病灶定位）。
//   ② 点「改」：行高 53.8 → 42px（**−11.8px**），该行之下所有行整体上移；动作行整块消失
//      （Δ左 −201px）、名区被输入件顶替。
//   ③ 点「删」第一击：「正在核对血缘」通知条挂在**列表之外**的 flex 列里 ⇒ 列表顶 +49px、
//      列表高 −49px，**列表内所有行整体下移 49px**；900ms 后核对返回又整体弹回。
//   ④ 核对返回（武装）：动作行 76 → 115.6px、左缘 −39.6px；长名行名宽 185 → 145.4px
//      （**省略号位移**）——武装文案「删」→「确删 N 卷?」在流里改宽。
//   ⑤ 点「确删」第二击：行删除（下移一行高 = 应有语义）与通知条重新挂载（+49px）**反向叠加**。
//   ⑥ 点勾选格：脚部批量条挂载 ⇒ 列表高 **−51px**。
//   ⑦ 枝视图：`▾ N 枝` 汇总与动作行同槽叠放，hover 即 `display:none` ⇒ 探针实测**同一坐标**
//      (583,328) 停栏外是 `.ss-kids`、移到其上（点击必经的 hover）是 **`.ss-del`「删」**——
//      瞄着折枝点下去，打中的是删除钮；且该钮鼠标**永不可达**（指针进influence行就把它藏了）。
//
// 本文件钉的是**纪律**（数值可调，结构不许回退）：
//   甲 标记列：常态 = 状态点独居（勾选格不显、hover 永不改几何）；整理态 = 勾选框 + 状态点
//      并排（2026-10-08 丙案，让位制退役——「黑方块 hover 变中空框」病灶的根治形态）。
//   乙 动作行宽度恒定：武装态只换色（连坐数写进行内机读注记行），不许改文案宽度。
//   丙 改名态不动骨架：两行式仍在，输入件落在名行**之内**，动作行常驻。
//   丁 通知条是**浮件**（绝对定位覆盖），不进本栏高度流水；批量条已随整理模式退役
//      （2026-10-08 丙案，动作移入顶部整理条）。
//   戊 可点件不许共享同一坐标：折枝汇总与动作行**并排**，不许按 hover 换租客。
//   己 武装有**代际**：核对在途期间任何其它意图作废旧应答——一击不许被读成「第二次确认」。
//      （同批顺带根治：`onDelete` 第一击的异步核对应答回来时，用户可能已点到别处，
//       旧实现照样武装 ⇒ 再点一次「删」= **一次点击直接删除**。）
//
// 修法读数（同台架复跑，`.report.after.json`）：① −16 → 0px；② −11.8 → 0px；③ ±49 → 0px；
// ④ −39.6 → 0px；⑥ −51 → 0px；⑦ 坐标归属恒定。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { useShellStore } from '../src/app/shell-store';
import { SpaceService } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { SessionSidebar } from '../src/plugins/builtin/canvas-nav/SessionSidebar';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { useCanvasViewStore } from '../src/state/canvas-view-store';
import { getChatStore } from '../src/ui/chat-store';

const SIDEBAR_CSS = readFileSync(
  join(__dirname, '..', 'src', 'plugins', 'builtin', 'canvas-nav', 'session-sidebar.css'),
  'utf8',
);
/** 剥注释的整份 CSS：断「某段规则不存在」必须用这一份（批注里就带着旧选择器字面）。 */
const CSS_CODE = SIDEBAR_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
/** 取一条规则的声明体（纸壳/侧栏 CSS 无嵌套）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i)).replace(/\/\*[\s\S]*?\*\//g, '');
}

const T1 = '2026-01-01T00:00:00Z';
const T2 = '2026-02-01T00:00:00Z';

describe('案卷侧栏行操作：显隐 / 武装 / 提示不得改变盒模型', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let panelId: string;

  function fakeCore(saved: Array<Record<string, unknown>>): ChatCore {
    return {
      panelId,
      listSavedSessions: vi.fn(async () => saved),
      createNewSession: vi.fn(),
      renameSession: vi.fn(),
      renameSavedSession: vi.fn(async () => {}),
      closeSession: vi.fn(),
      loadSessionFromDisk: vi.fn(async () => true),
      switchSession: vi.fn(),
      planBranchDelete: vi.fn(async () => ({ roots: [], order: [], blocked: [], branchCount: 2 })),
      deleteSessionWithBranches: vi.fn(async () => ({ deleted: [], blocked: [], failed: [] })),
    } as unknown as ChatCore;
  }

  beforeEach(() => {
    panelId = `test-ss-jump-${Math.random().toString(36).slice(2)}`;
    resetCanvasStoresForTests();
    useShellStore.getState().setProjectPath('');
    useCanvasViewStore.getState().requestFocus(null);
    localStorage.removeItem('lantai.sidebar.folds');
    localStorage.removeItem('lantai.sidebar.width');
    localStorage.removeItem('lantai.sidebar.view');
    new SpaceService(new Context());
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  const SAVED = [
    { id: 1, label: '父卷', msgCount: 2, savedAt: T1 },
    { id: 2, label: '枝卷', msgCount: 1, savedAt: T2, parentId: 1 },
  ];

  async function mount(core: ChatCore): Promise<void> {
    getChatStore(panelId).sess.setState({ sessions: [], activeIdx: 0, sessionTokens: {}, nextSessionId: 99 });
    useCoreStore.getState().setChatCore(core);
    await act(async () => {
      root?.unmount();
      root = createRoot(container);
      root.render(<SessionSidebar />);
    });
    await act(async () => {});
  }

  const rowOf = (id: number) => container.querySelector(`.ss-row[data-id="${id}"]`) as HTMLElement;
  const click = async (el: Element | null | undefined) => {
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const switchToTree = async () => {
    await click([...container.querySelectorAll('.ss-views button')][1]);
  };

  it('甲 · 标记列：常态勾选格不显（hover 零形变），整理态勾选框 + 状态点并排', async () => {
    await mount(fakeCore(SAVED));
    // DOM 面：两视角行首都有勾选格与状态点两件（勾选格常态不可见由 CSS 管）
    expect(container.querySelector('.ss-list')?.getAttribute('data-view')).toBe('case');
    expect(container.querySelectorAll('.ss-bare')).toHaveLength(0);
    expect(rowOf(1).querySelector('.ss-mark .ss-check')).toBeTruthy();
    expect(rowOf(1).querySelector('.ss-mark .ss-dot')).toBeTruthy();
    await switchToTree();
    expect(rowOf(1).querySelector('.ss-mark .ss-check')).toBeTruthy();
    // CSS 面：让位制退役（2026-10-08 丙案）——不再有「hover / focus / 选中即显形 / 让位」
    // 的规则；`.ss-bare` 两槽制也不回来（列宽只由模式决定，hover 永不改几何）
    expect(CSS_CODE).not.toContain('.ss-bare');
    expect(CSS_CODE).not.toContain('\n.ss-row:hover .ss-check');
    expect(CSS_CODE).not.toContain('\n.ss-row:focus-within .ss-check');
    expect(CSS_CODE).not.toContain('\n.ss-row.selected .ss-check');
    expect(CSS_CODE).not.toContain('\n.ss-row:hover .ss-dot');
    // 形态：常态 = 16px 单槽（状态点独居）；整理态 = 27px 双件并排（框 + 点）
    expect(ruleBody(CSS_CODE, '\n.ss-mark {')).toContain('flex: 0 0 16px');
    const arranged = ruleBody(CSS_CODE, '.ss-sidebar.arranging .ss-mark {');
    expect(arranged).toContain('width: 27px');
    expect(arranged).toContain('display: flex');
    expect(ruleBody(CSS_CODE, '.ss-sidebar.arranging .ss-check {')).toContain('visibility: visible');
  });

  it('乙 · 「删」钮武装只换色：文案不变（动作行宽度恒定，名区不被压缩）', async () => {
    const core = fakeCore(SAVED);
    await mount(core);
    const del = rowOf(1).querySelector('.ss-actions button:last-child') as HTMLButtonElement;
    expect(del.textContent).toBe('删');
    await click(del); // 第一击 = 核对血缘（异步）后武装
    expect(core.planBranchDelete).toHaveBeenCalled();
    const armed = rowOf(1).querySelector('.ss-actions .ss-danger') as HTMLButtonElement;
    expect(armed).toBeTruthy();
    // 宽度恒定的充分条件：文案不变（旧实现改写成「确删 N 卷?」⇒ 动作行 76 → 115.6px）
    expect(armed.textContent).toBe('删');
    // 连坐信息改由**行内机读注记行**承接（不可逆动作的知情权留在行内，但不挤按钮宽度）
    const meta = rowOf(1).querySelector('.ss-meta') as HTMLElement;
    expect(meta.className).toContain('ss-meta-confirm');
    expect(meta.textContent).toContain('2 枝');
  });

  it('丙 · 改名态不动骨架：两行式仍在，输入件落在名行之内，动作行常驻', async () => {
    await mount(fakeCore(SAVED));
    const before = rowOf(1).querySelectorAll('.ss-actions button').length;
    await click(rowOf(1).querySelector('.ss-actions button:nth-child(1)')); // 改
    const main = rowOf(1).querySelector('.ss-row-main');
    expect(main).toBeTruthy(); // 旧实现整块换成输入件 ⇒ 行高 53.8 → 42px，下面所有行弹一下
    expect(main?.querySelector('.ss-rename-input')).toBeTruthy();
    expect(rowOf(1).querySelectorAll('.ss-actions button')).toHaveLength(before); // 动作行不许撤下
    expect(rowOf(1).querySelector('.ss-meta')).toBeTruthy(); // 机读注记行仍在
  });

  it('丁 · 通知条是浮件（不进高度流水）；批量条随整理模式退役、动作移入顶部整理条', () => {
    // 旧实现通知条住 flex 列里 ⇒ 挂载即挤压列表（实测 ±49px，列表内容整体位移）
    expect(ruleBody(SIDEBAR_CSS, '.ss-notice {')).toContain('position: absolute');
    // 批量条退役（2026-10-08 丙案）：底部浮件不再存在，动作在顶部整理条（流水内件）
    expect(CSS_CODE).not.toContain('.ss-batch');
    expect(ruleBody(CSS_CODE, '.ss-arrange-bar {')).toContain('display: none');
    expect(ruleBody(CSS_CODE, '.ss-sidebar.arranging .ss-arrange-bar {')).toContain('display: flex');
    // 浮件锚在本栏（`.ss-sidebar` 是定位上下文 = 真机上的 position:fixed 已成立，不再依赖它）
    expect(ruleBody(SIDEBAR_CSS, '.ss-sidebar {')).toContain('position: fixed');
  });

  it('戊 · 折枝汇总与动作行并排：可点件不许共享同一坐标', async () => {
    // CSS 面：汇总钮不许绝对定位叠在动作行上（旧实现 right:0 + hover 即 display:none
    // ⇒ 探针实测同一坐标 hover 后归属从 `.ss-kids` 变成 `.ss-del`）
    expect(ruleBody(SIDEBAR_CSS, '.ss-kids {')).not.toContain('position: absolute');
    expect(CSS_CODE).not.toContain('.ss-row:hover .ss-kids');
    expect(CSS_CODE).not.toContain('.ss-row:focus-within .ss-kids');
    // DOM 面：两者并排在同一个尾部槽里，汇总在左、动作行在右
    await mount(fakeCore(SAVED));
    await switchToTree();
    const tail = rowOf(1).querySelector('.ss-tail') as HTMLElement;
    expect([...tail.children].map((c) => c.className)).toEqual(['ss-kids', 'ss-actions']);
  });

  it('己 · 核实在途期间点到别处 ⇒ 旧应答不再武装（一击不该变成「第二次确认」）', async () => {
    // 病史：第一击要逐卷读头行核对血缘（几百卷几秒），应答回来时用户可能已经点到别处
    // （disarmAll）。旧实现无代际守卫 ⇒ 旧应答照样把该行武装上，用户再点一次「删」
    // 就被读作第二次确认，**一次点击直接删除**。
    const core = fakeCore(SAVED);
    let release: (v: unknown) => void = () => {};
    (core.planBranchDelete as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    await mount(core);
    const del = rowOf(2).querySelector('.ss-actions button:last-child') as HTMLButtonElement;
    await click(del); // 第一击：核对在途
    await click(rowOf(1)); // 期间点了别的行 = 其它意图（解武 + 清提示）
    await act(async () => {
      release({ roots: [], order: [], blocked: [], branchCount: 2 }); // 旧应答这才回来
    });
    expect(container.querySelector('.ss-danger')).toBeNull(); // 不许被旧应答武装
  });
});
