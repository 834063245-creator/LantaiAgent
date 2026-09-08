// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 附图粘贴门禁组件测试（multimodal-image-plan B2——D-8②）：
// - vision 模型（目录声明 input 含 'image'）：贴图 → core.intakeImageFiles 直呼；
// - 文本模型：贴图 → 不入卷 + localNotice 提示（D-8② paste 弹提示）；
// - 纯文本粘贴零影响：intake 不触发、提示不出现。
// harness 镜像 composer-dock-keyboard.test.tsx（fakeCore + mountDock）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { PaperDockContext, type PaperDockContextValue } from '../src/paper/overlay-context';
import { ComposerDock } from '../src/plugins/builtin/compose-dock/ComposerDock';
import * as catalog from '../src/provider/catalog';
import { resetCanvasStoresForTests } from '../src/state/canvas-store';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';
import { getChatStore } from '../src/ui/chat-store';

vi.mock('../src/provider/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/provider/catalog')>();
  return {
    ...actual,
    // 组件经 host.ts 直连本模块（开发/测试域 re-export 活绑定）——getModel
    // 覆写后按 model id 出「目录声明」：vision-x 声明图片输入，其余文本。
    getModel: vi.fn((id: string) =>
      id === 'vision-x'
        ? ({
            id,
            name: 'Vision X',
            kind: 'openai',
            vendor: 'v',
            baseUrl: '',
            reasoning: false,
            input: ['text', 'image'],
            contextWindow: 128000,
            maxTokens: 8192,
          } as ReturnType<typeof actual.getModel>)
        : actual.getModel(id),
    ),
  };
});

function fakeCore(panelId: string): ChatCore {
  return {
    panelId,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    openFilePicker: vi.fn(),
    attachIntakePaths: vi.fn(),
    intakeImageFiles: vi.fn(),
    intakeImagePaths: vi.fn(),
    registerComposer: vi.fn(),
    executeCommand: vi.fn(),
  } as unknown as ChatCore;
}

const DOCK_CONTEXT: PaperDockContextValue = {
  activeSessionId: '1',
  inputLocked: false,
  setInputLocked: vi.fn(),
  flyToPoint: vi.fn(),
};

/** 装配 core + 播种 compose 模型偏好 + 渲染 ComposerDock。返回 fake core。 */
async function mountDock(model: string, container: HTMLDivElement): Promise<ChatCore> {
  const core = fakeCore(`paste-test-${Date.now()}`);
  useCoreStore.getState().setChatCore(core);
  getChatStore(core.panelId).sess.setState({
    sessions: [{ id: 1, label: '案卷一' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
  });
  getComposeStore(core.panelId).setState({
    sessions: { '1': { providerName: 'p', model, thinking: '' } },
  });
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(createElement(PaperDockContext.Provider, { value: DOCK_CONTEXT }, createElement(ComposerDock)));
  });
  await act(async () => {});
  return core;
}

/** 在 textarea 上触发 paste（鸭子 clipboardData——React 合成 onPaste 读原事件属性）。 */
function pasteOn(ta: HTMLTextAreaElement, items: Array<{ kind: string; type?: string } | null>): void {
  act(() => {
    const evt = new Event('paste', { bubbles: true, cancelable: true });
    (evt as Event & { clipboardData: unknown }).clipboardData = {
      items: items.map((e) => ({
        kind: e?.kind ?? 'string',
        getAsFile: () => (e && e.kind === 'file' && e.type ? new File(['x'], 'f', { type: e.type }) : null),
      })),
    };
    ta.dispatchEvent(evt);
  });
}

const IMAGE_ITEM = { kind: 'file', type: 'image/png' };
const TEXT_ITEM = { kind: 'string' };

describe('附图粘贴门禁（B2 · D-8②）', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    vi.mocked(catalog.getModel).mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    resetComposeStoresForTests();
    resetCanvasStoresForTests();
    localStorage.removeItem('hologram_settings'); // B5 种子清场（不渗后测）
  });

  it('vision 模型：贴图入附图道（intakeImageFiles 直呼），无提示', async () => {
    const core = await mountDock('vision-x', container);
    const ta = container.querySelector('textarea');
    expect(ta).not.toBeNull();
    pasteOn(ta as HTMLTextAreaElement, [IMAGE_ITEM, IMAGE_ITEM]);
    expect(core.intakeImageFiles).toHaveBeenCalledTimes(1);
    const files = (core.intakeImageFiles as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as File[];
    expect(files).toHaveLength(2);
    expect(files[0]?.type).toBe('image/png');
    expect(container.querySelector('.pp-local-notice')).toBeNull();
  });

  it('文本模型：贴图不入卷，localNotice 提示（当前模型不支持图片输入）', async () => {
    const core = await mountDock('text-only-model', container);
    const ta = container.querySelector('textarea');
    pasteOn(ta as HTMLTextAreaElement, [IMAGE_ITEM]);
    expect(core.intakeImageFiles).not.toHaveBeenCalled();
    const notice = container.querySelector('.pp-local-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('当前模型不支持图片输入');
  });

  it('纯文本粘贴零影响：intake 不触发、无提示', async () => {
    const core = await mountDock('vision-x', container);
    const ta = container.querySelector('textarea');
    pasteOn(ta as HTMLTextAreaElement, [TEXT_ITEM, { kind: 'file', type: 'text/plain' }]);
    expect(core.intakeImageFiles).not.toHaveBeenCalled();
    expect(container.querySelector('.pp-local-notice')).toBeNull();
  });

  it('B5：ModelOverrides.input 补声明——目录外自定义 vision 模型贴图放行', async () => {
    // GLM-4V 类目录外 vision 款：catalog 无条目（getModel undefined），靠
    // 设置页参数面板的覆盖声明开附图道（modelInput 合并链：覆盖 ?? 目录）
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({
        activeProvider: 'p',
        providers: [
          {
            kind: 'openai',
            name: 'p',
            apiKey: '',
            baseUrl: 'https://gateway.example/v1',
            model: 'glm-4v-custom',
            modelOverrides: { 'glm-4v-custom': { input: ['text', 'image'] } },
          },
        ],
        projectPath: '.',
        agent: {},
        display: { language: 'zh', fontScale: 1 },
      }),
    );
    const core = await mountDock('glm-4v-custom', container);
    const ta = container.querySelector('textarea');
    pasteOn(ta as HTMLTextAreaElement, [IMAGE_ITEM]);
    expect(core.intakeImageFiles).toHaveBeenCalledTimes(1); // 覆盖声明 → 附图道开
    expect(container.querySelector('.pp-local-notice')).toBeNull();
  });
});
