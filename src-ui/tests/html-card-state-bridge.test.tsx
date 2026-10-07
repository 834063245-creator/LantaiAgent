// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// html 卡状态桥（2026-10-07 asset-state）——沙箱 iframe 里的用户操作经 postMessage
// 写回内核状态表：
//   - 本 iframe 的 patch → 内核表更新；卸载重挂载（滚走滚回）→ 值还在；
//   - 非本 iframe 来源 / 未知 type / 畸形消息 → 忽略、不炸、不写；
//   - 无会话定位（不在案卷里的卡）→ 拒绝而不是假装成功。
// 模拟方式：直接向 window 派发 MessageEvent（source = iframe.contentWindow）——
// iframe 内部脚本在 jsdom 不执行，桥的父侧（HtmlBody）是唯一被测面。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { clearAssetStateForTests, getAssetState, patchAssetState } from '../src/agent/asset-state';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { assetRendererComponents } from '../src/plugins/builtin/renderers/components';

const KEY = { projectPath: '/proj', sessionId: '7' };

function htmlBlock(): SourcedBlock {
  return {
    ...createBlock('html', { code: '<b>hi</b>' } as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'html', title: 't', finalised: true },
  };
}

describe('html 卡状态桥（iframe ↔ 内核）', () => {
  const Comp = assetRendererComponents().html;
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    clearAssetStateForTests();
    const k = H.kernelFs;
    if (!k) throw new Error('kernelFs mock 未就绪');
    k.fs.files.clear();
    k.fs.writes.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  /** 挂载一张 html 卡（默认带会话定位——即「在已打开的案卷里」）。 */
  async function mount(props: { sessionProjectPath?: string; sessionId?: string } = {}): Promise<HTMLIFrameElement> {
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Comp, { block: htmlBlock(), ...props }));
    });
    const iframe = container.querySelector('iframe');
    if (!iframe) throw new Error('iframe 未渲染');
    return iframe as HTMLIFrameElement;
  }

  /** 模拟「来自该 iframe」的一条消息。 */
  function send(iframe: HTMLIFrameElement, data: unknown): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow as unknown as MessageEventSource,
        data,
      }),
    );
  }

  it('卡里输入 → 内核表更新；卸载重挂载（滚走滚回）→ 值还在', async () => {
    const iframe = await mount({ sessionProjectPath: '/proj', sessionId: '7' });
    await act(async () => {
      send(iframe, { type: 'lantai.card-state', req: 1, op: 'patch', patch: { memo: 'a' } });
    });
    expect(getAssetState(KEY, 'as_1')).toEqual({ memo: 'a' });

    // 滚走（卸载）再滚回（重挂载）——状态不随组件生命周期消失
    await act(async () => {
      root?.unmount();
    });
    root = null;
    await mount({ sessionProjectPath: '/proj', sessionId: '7' });
    expect(getAssetState(KEY, 'as_1')).toEqual({ memo: 'a' });
  });

  it('get 有回复：ok + 已存状态', async () => {
    patchAssetState(KEY, 'as_1', { memo: 'x' });
    const iframe = await mount({ sessionProjectPath: '/proj', sessionId: '7' });
    const received: Array<Record<string, unknown>> = [];
    iframe.contentWindow?.addEventListener('message', (e) => {
      received.push(e.data as Record<string, unknown>);
    });
    await act(async () => {
      send(iframe, { type: 'lantai.card-state', req: 7, op: 'get' });
      await new Promise((r) => setTimeout(r, 0));
    });
    const hit = received.find((d) => d?.type === 'lantai.card-state' && d.req === 7);
    expect(hit).toBeDefined();
    expect(hit?.ok).toBe(true);
    expect(hit?.state).toEqual({ memo: 'x' });
  });

  it('非本 iframe 来源的消息 → 忽略', async () => {
    await mount({ sessionProjectPath: '/proj', sessionId: '7' });
    // 缺 source（null）
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'lantai.card-state', req: 1, op: 'patch', patch: { a: 1 } } }),
    );
    expect(getAssetState(KEY, 'as_1')).toBeNull();
    // 另一个 iframe 的 source
    const other = document.createElement('iframe');
    document.body.appendChild(other);
    send(other, { type: 'lantai.card-state', req: 2, op: 'patch', patch: { a: 1 } });
    expect(getAssetState(KEY, 'as_1')).toBeNull();
    other.remove();
  });

  it('未知 type / 畸形 payload → 不炸、不写', async () => {
    const iframe = await mount({ sessionProjectPath: '/proj', sessionId: '7' });
    await act(async () => {
      send(iframe, { type: 'lantai.whatever' });
      send(iframe, { type: 'lantai.card-state' });
      send(iframe, { type: 'lantai.card-state', req: 1, op: 'nope' });
      send(iframe, { type: 'lantai.card-state', req: 2, op: 'patch', patch: 'not-an-object' });
    });
    expect(getAssetState(KEY, 'as_1')).toBeNull();
  });

  it('无会话定位（不在案卷里）→ 拒绝，内核不写', async () => {
    const iframe = await mount();
    await act(async () => {
      send(iframe, { type: 'lantai.card-state', req: 1, op: 'patch', patch: { a: 1 } });
    });
    expect(getAssetState(KEY, 'as_1')).toBeNull();
  });
});
