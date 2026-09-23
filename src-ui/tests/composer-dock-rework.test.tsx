// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞返工（P2-2/P2-3）组件测试：
// - P2-2 思考档位收起态显示「思考 · 当前档」；展开为纯中文分段控件；
// - P2-3 权限三档分段控件；点全放弹出居中模态，确定后切到 yolo。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionState } from '../src/agent/agent-session-state';
import { createExecState } from '../src/agent/execution-state';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';
import { useModeStore } from '../src/state/mode-store';
import { getChatStore } from '../src/ui/chat-store';

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    // B6（2026-08-27）：ComposerDock 挂载时注册输入框命令式接口
    registerComposer: vi.fn(),
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  flyToPoint: vi.fn(),
};

/** 装配 core + 播种会话/创作坞偏好，并把 ComposerDock 渲染进 container。
 *  thinking = 会话思考覆盖种子（缺省 high）。 */
async function mountDock(
  panelId: string,
  container: HTMLDivElement,
  onRoot: (r: Root) => void,
  thinking: 'high' | 'off' = 'high',
) {
  useCoreStore.getState().setChatCore(fakeCore(panelId));
  getChatStore(panelId).sess.setState({
    sessions: [{ id: 1, label: '案卷一' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
  });
  // 清输入草稿槽——上个用例可能残留（运行态单钮三态用例手输过），
  // 否则 mount 时本地 inputText 同步到旧值，三态判定被污染
  getChatStore(panelId).input.getState().setInputText('');
  // 播种会话覆盖：deepseek-v4-pro + thinking 档位（方案甲：覆盖制——
  // setThinking 自带「以当前生效配置为底落覆盖」，不再需要 ensurePrefs 预热）
  getComposeStore(panelId).getState().setThinking('1', thinking);

  let root: Root;
  act(() => {
    root = createRoot(container);
    onRoot(root);
    root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
  });
  await act(async () => {});
}

describe('ComposerDock 返工 P2-2（思考档位 pill 下拉，DSH 移植）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  it('收起态 pill 显示当前档中文标签（高）——非恒「思考」文本', async () => {
    await mountDock('p22-collapsed', container, (r) => {
      root = r;
    });
    const pill = container.querySelector<HTMLButtonElement>('.pp-thinking-pill');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('高');
  });

  it('off 档：pill 带 .off 静默类，脑图标划横线（DSH 语义）', async () => {
    await mountDock(
      'p22-off',
      container,
      (r) => {
        root = r;
      },
      'off',
    );
    const pill = container.querySelector<HTMLButtonElement>('.pp-thinking-pill');
    expect(pill?.classList.contains('off')).toBe(true);
    expect(pill?.querySelector('line')).not.toBeNull(); // 脑图标上的划线
  });

  it('点 pill 打开下拉：纯中文档位 + 说明、选中态正确；选「低」写会话覆盖并关闭', async () => {
    await mountDock('p22-open', container, (r) => {
      root = r;
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('.pp-thinking-pill')?.click();
    });
    await act(async () => {});
    const menu = container.querySelector('.pp-thinking-menu');
    expect(menu).not.toBeNull();
    const opts = [...container.querySelectorAll<HTMLButtonElement>('.pp-thinking-opt')];
    expect(opts.length).toBeGreaterThan(0);
    // 无中英混排：档位标签与说明行都是中文（thinkingZhLabel / THINKING_DESC）
    expect(menu?.textContent).not.toMatch(/\(|\)/);
    // 选中态 = 当前档「高」
    const selected = opts.find((b) => b.classList.contains('selected'));
    expect(selected?.textContent).toContain('高');
    // 选「低」→ compose-store 会话覆盖 + 菜单关闭
    const low = opts.find((b) => b.textContent?.includes('低'));
    act(() => {
      low?.click();
    });
    await act(async () => {});
    expect(getComposeStore('p22-open').getState().getPrefs('1')?.thinking).toBe('low');
    expect(container.querySelector('.pp-thinking-menu')).toBeNull();
  });

  it('无目录声明模型：思考 pill 常驻（带「思考」字样），菜单只给自动/关闭安全兜底', async () => {
    await mountDock('p22-fallback', container, (r) => {
      root = r;
    });
    // 把会话模型换成目录外模型（无 thinkingEfforts 声明）——思考控件不应消失
    getComposeStore('p22-fallback').getState().setModel('1', 'deepseek', 'custom-unknown-model');
    await act(async () => {});
    const pill = container.querySelector<HTMLButtonElement>('.pp-thinking-pill');
    expect(pill).not.toBeNull(); // 常驻
    expect(pill?.textContent).toContain('思考'); // 有「思考」字样可辨识
    act(() => {
      pill?.click();
    });
    await act(async () => {});
    const opts = [...container.querySelectorAll<HTMLButtonElement>('.pp-thinking-opt')];
    expect(opts.length).toBeGreaterThan(0);
    // 只给「自动/关闭」——不编造命名档位（P14 不破，assertEffortDeclared 对 ''/off 不拦）
    expect(opts.some((b) => b.textContent?.includes('自动'))).toBe(true);
    expect(opts.some((b) => b.textContent?.includes('关闭'))).toBe(true);
    expect(opts.some((b) => b.textContent?.includes('高'))).toBe(false);
  });
});

describe('ComposerDock 运行中守卫（DSH 移植）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    agentSessionState.removeExec('guard', 1);
  });

  it('活跃卷运行中：模型下拉打开被拦 + localNotice 提示', async () => {
    // 种子运行中的 exec（B7 running 态来源）——须在 mount 前，运行态 effect 才能读到
    const exec = createExecState();
    exec.beginRun('turn'); // v43：运行态 = 账上的活记录
    agentSessionState.setExec('guard', 1, exec);
    await mountDock('guard', container, (r) => {
      root = r;
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    expect(container.querySelector('.ms-dropdown')).toBeNull(); // 没打开（DSH onAttemptOpen veto）
    expect(container.querySelector('.pp-local-notice')?.textContent).toContain('正在运行');
    // 停止 exec 会触发运行态订阅更新——须在 act 内，否则 React 报未包裹更新
    act(() => exec.stopAll());
  });
});

describe('钤印单钮三态（2026-09-03：运行态按钮随输入翻转）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    agentSessionState.removeExec('seal', 1);
  });

  it('空闲 = 拟文；运行中空输入 = 停；打字立即翻回拟文且点它走 sendMessage（插话路径）', async () => {
    const exec = createExecState();
    exec.beginRun('turn'); // v43：运行态 = 账上的活记录
    agentSessionState.setExec('seal', 1, exec);
    await mountDock('seal', container, (r) => {
      root = r;
    });

    // 态一：运行中空输入 → 只有停（朱印），拟文不渲染
    expect(container.querySelector('.pp-stop')).not.toBeNull();
    expect(container.querySelector('.pp-send')).toBeNull();

    // 态二：运行中打字 → 拟文回来、停消失（React 受控 textarea：原型 setter + input 事件）
    const ta = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(ta).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, '插一句');
      ta?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-stop')).toBeNull();
    expect(container.querySelector('.pp-send')).not.toBeNull();

    // 态三：点拟文 = sendMessage（运行中 = 内部走 agent.insertMessage 插入下轮生效）
    const core = useCoreStore.getState().core;
    act(() => {
      container.querySelector<HTMLButtonElement>('.pp-send')?.click();
    });
    await act(async () => {});
    expect(core?.sendMessage).toHaveBeenCalled();
    act(() => exec.stopAll());
  });

  it('mount 后进入运行态：拟文翻停；停钮点了走 abort；清空输入回拟文', async () => {
    const exec = createExecState();
    agentSessionState.setExec('seal', 1, exec); // 先挂 exec（未运行）——mount 时运行态 effect 才会订阅它
    await mountDock('seal', container, (r) => {
      root = r;
    });
    expect(container.querySelector('.pp-send')).not.toBeNull();
    expect(container.querySelector('.pp-stop')).toBeNull();

    // mount 后起一轮 → 订阅活着 → 翻成停
    act(() => exec.beginRun('turn'));
    await act(async () => {});
    expect(container.querySelector('.pp-stop')).not.toBeNull();
    expect(container.querySelector('.pp-send')).toBeNull();

    // 停钮 = abort
    const core = useCoreStore.getState().core;
    act(() => {
      container.querySelector<HTMLButtonElement>('.pp-stop')?.click();
    });
    expect(core?.abort).toHaveBeenCalled();

    // 打字（拟文）→ 清空（回停）——插话草稿清空后中止意图恢复
    const ta = container.querySelector<HTMLTextAreaElement>('textarea');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, '准备插话');
      ta?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-send')).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, '');
      ta?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    expect(container.querySelector('.pp-stop')).not.toBeNull();
    expect(container.querySelector('.pp-send')).toBeNull();
    act(() => exec.stopAll());
  });
});

describe('ComposerDock 运行态同步（2026-09-06 exec 实例迟到订阅根治）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    agentSessionState.removeExec('sync', 1);
  });

  it('mount 时 exec 尚未出生（惰性水合在途）：水合 setExec 后 start，停钮必须出现', async () => {
    // 重启摊开集恢复 → 点卷 → ensureSessionAgent 异步水合未完成的现场：
    // mount 时该卷无任何 exec 实例
    await mountDock('sync', container, (r) => {
      root = r;
    });
    expect(container.querySelector('.pp-stop')).toBeNull();
    expect(container.querySelector('.pp-send')).not.toBeNull();

    // 惰性水合完成——exec 实例迟到（旧捕获式订阅从此永聋的现场）
    const exec = createExecState();
    act(() => {
      agentSessionState.setExec('sync', 1, exec);
    });
    await act(async () => {});
    expect(container.querySelector('.pp-stop')).toBeNull(); // 实例在但未运行——仍是拟文

    // 拟文 → 本卷开始跑 → 停钮出现（回归钉：旧实现 start() 无人通知）
    const run = exec.beginRun('turn');
    act(() => {});
    await act(async () => {});
    expect(container.querySelector('.pp-stop')).not.toBeNull();
    expect(container.querySelector('.pp-send')).toBeNull();

    // 跑完 → 回拟文
    act(() => run.end());
    await act(async () => {});
    expect(container.querySelector('.pp-stop')).toBeNull();
    expect(container.querySelector('.pp-send')).not.toBeNull();
  });
});

describe('ComposerDock 返工 P2-3（权限分段 + 全放模态）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    useModeStore.setState({ permissionMode: 'ask', pendingYolo: false });
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  it('权限三档分段控件：常询/半放/全放，当前档选中高亮', async () => {
    await mountDock('p23-seg', container, (r) => {
      root = r;
    });
    const seg = container.querySelector('.pp-mode-seg');
    expect(seg).not.toBeNull();
    const opts = [...container.querySelectorAll<HTMLButtonElement>('.pp-mode-opt')];
    expect(opts.map((b) => b.textContent?.trim())).toEqual(['常询', '半放', '全放']);
    expect(opts[0]?.classList.contains('selected')).toBe(true);
  });

  it('点全放 → 居中模态出现；点确定 → mode-store 切到 yolo 且模态消失', async () => {
    await mountDock('p23-yolo', container, (r) => {
      root = r;
    });
    act(() => {
      const yoloBtn = [...container.querySelectorAll<HTMLButtonElement>('.pp-mode-opt')].find(
        (b) => b.textContent?.trim() === '全放',
      );
      yoloBtn?.click();
    });
    await act(async () => {});
    /* 2026-09-22：模态改 portal 到 body（坞槽的 transform 会把它关进坞的盒子，
       见 ComposerDock 附图预览处病灶注）⇒ 探针从 container 移到 document，
       并顺带钉住「不在坞子树内」这条不变量。 */
    expect(document.querySelector('.pp-mode-dialog')).not.toBeNull();
    expect(container.querySelector('.pp-mode-dialog')).toBeNull();
    act(() => {
      document.querySelector<HTMLButtonElement>('.pp-mode-dialog-actions .primary')?.click();
    });
    await act(async () => {});
    expect(useModeStore.getState().permissionMode).toBe('yolo');
    expect(document.querySelector('.pp-mode-dialog')).toBeNull();
  });
});

// 2026-09-23 思考下沉：pill 的档位**与档位表**都换源到 provider 作用域描述符
// （覆盖 ?? API 拉取元数据 ?? 目录 seed）——与设置页参数面板、请求期门禁同一把尺子。
// 用户报的病灶：坞里显示/可选的东西与「我到底在给哪个模型设档位」对不上。
describe('ComposerDock 思考档位换源（2026-09-23）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
  });

  /** 播种一行 provider + 未改卷（不落会话覆盖）后挂载坞。 */
  async function mountWithRow(panelId: string, providerRow: Record<string, unknown>): Promise<void> {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: providerRow.name,
        providers: [providerRow],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    useCoreStore.getState().setChatCore(fakeCore(panelId));
    getChatStore(panelId).sess.setState({
      sessions: [{ id: 1, label: '案卷一' }],
      activeIdx: 0,
      sessionTokens: {},
      nextSessionId: 2,
    });
    getChatStore(panelId).input.getState().setInputText('');
    act(() => {
      root = createRoot(container);
      root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
    });
    await act(async () => {});
  }

  const row = (over: Record<string, unknown> = {}) => ({
    kind: 'openai',
    name: 'deepseek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
    thinking: 'low',
    ...over,
  });

  it('无会话覆盖：pill 显示该模型生效的档位（per-model 覆盖压过行值）', async () => {
    await mountWithRow('p23-permodel', row({ modelOverrides: { 'deepseek-v4-pro': { thinking: 'max' } } }));
    const pill = container.querySelector<HTMLButtonElement>('.pp-thinking-pill');
    expect(pill?.textContent).toContain('极限'); // 覆盖值，而不是行值「低」
  });

  it('无覆盖的模型回落行值（本家默认档位）', async () => {
    await mountWithRow('p23-rowvalue', row());
    expect(container.querySelector<HTMLButtonElement>('.pp-thinking-pill')?.textContent).toContain('低');
  });

  it('档位表来自 provider 作用域：API 拉取元数据声明的档位在坞里可选（此前读全局目录 → 拿不到）', async () => {
    await mountWithRow(
      'p23-declared',
      row({
        model: 'gw-model-x',
        thinking: '',
        modelMeta: { 'gw-model-x': { thinkingEfforts: ['minimal', 'low'], fetchedAt: 1 } },
      }),
    );
    act(() => {
      container.querySelector<HTMLButtonElement>('.pp-thinking-pill')?.click();
    });
    const labels = [...container.querySelectorAll('.pp-thinking-opt-label')].map((e) => e.textContent ?? '');
    expect(labels).toContain('最浅'); // 网关模型自己的声明（目录里没有这个模型）
  });
});
