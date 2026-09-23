// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-open-system — P2 的两条宿主面行为（B5 系统打开出口 + 尺寸预检）：
//   ① 尺寸预检：`fs_cap stat` 说超限 ⇒ **根本不读**字节（不整份进 IPC）；
//   ② 系统打开：点「用系统程序打开」⇒ `fs_cap open_with_system`（用户通道）；
//      失败 ⇒ 可读错误行；「未知 action」= 能力位缺席（旧 exe 换新产物）⇒ 按钮本会话收起；
//   ③ 预检能力缺席 ⇒ 回落旧行为（读回来再判），不挡路。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

type Call = [string, Record<string, unknown>];

function callsOf(method: string, action: string): Call[] {
  return (vi.mocked(typedRpc).mock.calls as Call[]).filter((c) => c[0] === method && c[1]?.action === action);
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  await fn();
  await f3.dispose();
  await f2.dispose();
  await f1.dispose();
}

function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

describe('P2 宿主面：尺寸预检 + 系统打开出口', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function renderFile(payload: unknown, settle = 2): Promise<void> {
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    for (let i = 0; i < settle; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it('尺寸预检：stat 说超限 ⇒ 不读字节 + 可读错误 + 文件壳（大文件不进 IPC）', async () => {
    vi.mocked(typedRpc).mockImplementation(async (_m: string, params: Record<string, unknown>) => {
      if (params.action === 'stat') return JSON.stringify({ path: 'D:/a.mp3', size: 40 * 1024 * 1024, is_dir: false });
      throw new Error(`不该发生的读取：${String(params.action)}`);
    });
    await withRenderers(async () => {
      // mp3 的 maxBytes = 16 MiB ⇒ 40 MiB 必被拦
      await renderFile({ filePath: 'D:/a.mp3', ext: 'mp3', label: '大曲' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('已在读取前拦下');
      expect(err).toContain('超过「audio」查看器的');
      expect(container.querySelector('.pp-media-file')).not.toBeNull();
      expect(callsOf('fs_cap', 'read_base64')).toHaveLength(0);
      expect(callsOf('fs_cap', 'stat')).toHaveLength(1);
    });
  });

  it('预检通过 ⇒ 正常读取（stat 一次 + read_base64 一次）', async () => {
    vi.mocked(typedRpc).mockImplementation(async (_m: string, params: Record<string, unknown>) => {
      if (params.action === 'stat') return JSON.stringify({ path: 'D:/a.mp3', size: 1024, is_dir: false });
      return JSON.stringify({ path: 'D:/a.mp3', base64: 'QUJD' });
    });
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.mp3', ext: 'mp3', label: '曲' });
      expect(container.querySelector('.pp-viewer-audio-el')).not.toBeNull();
      expect(callsOf('fs_cap', 'stat')).toHaveLength(1);
      expect(callsOf('fs_cap', 'read_base64')).toHaveLength(1);
    });
  });

  it('预检能力缺席（stat 报错，旧 exe）⇒ 回落旧行为：照读、超限走读后判据', async () => {
    vi.mocked(typedRpc).mockImplementation(async (_m: string, params: Record<string, unknown>) => {
      if (params.action === 'stat') throw new Error("fs_cap: 未知 action 'stat'");
      return JSON.stringify({ path: 'D:/a.mp3', base64: 'QUJD' });
    });
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.mp3', ext: 'mp3', label: '曲' });
      expect(callsOf('fs_cap', 'read_base64')).toHaveLength(1);
      expect(container.querySelector('.pp-viewer-audio-el')).not.toBeNull();
    });
  });

  it('系统打开：按钮在（有路径）⇒ 点击走 fs_cap open_with_system（用户通道）', async () => {
    vi.mocked(typedRpc).mockImplementation(async (_m: string, params: Record<string, unknown>) => {
      if (params.action === 'stat') return JSON.stringify({ path: 'D:/a.mp3', size: 1024, is_dir: false });
      if (params.action === 'open_with_system') return JSON.stringify({ path: 'D:/a.mp3' });
      return JSON.stringify({ path: 'D:/a.mp3', base64: 'QUJD' });
    });
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.mp3', ext: 'mp3', label: '曲' });
      const btn = container.querySelector('.pp-viewer-open-system') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn?.textContent).toContain('用系统程序打开');
      await act(async () => {
        btn!.click();
      });
      const calls = callsOf('fs_cap', 'open_with_system');
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ file_path: 'D:/a.mp3', is_agent: false });
      expect(container.querySelector('.pp-viewer-error')).toBeNull();
    });
  });

  it('系统打开失败 ⇒ 可读错误行（不静默）', async () => {
    vi.mocked(typedRpc).mockImplementation(async (_m: string, params: Record<string, unknown>) => {
      if (params.action === 'stat') return JSON.stringify({ path: 'D:/a.mp3', size: 1024, is_dir: false });
      if (params.action === 'open_with_system') throw new Error('ShellExecuteW 返回 2');
      return JSON.stringify({ path: 'D:/a.mp3', base64: 'QUJD' });
    });
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.mp3', ext: 'mp3', label: '曲' });
      await act(async () => {
        (container.querySelector('.pp-viewer-open-system') as HTMLButtonElement).click();
      });
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain(
        '用系统程序打开失败：ShellExecuteW 返回 2',
      );
    });
  });

  it('能力位缺席（未知 action）⇒ 按钮本会话收起（不反复报同一句）', async () => {
    vi.mocked(typedRpc).mockImplementation(async (_m: string, params: Record<string, unknown>) => {
      if (params.action === 'stat') return JSON.stringify({ path: 'D:/a.mp3', size: 1024, is_dir: false });
      if (params.action === 'open_with_system') throw new Error("fs_cap: 未知 action 'open_with_system'");
      return JSON.stringify({ path: 'D:/a.mp3', base64: 'QUJD' });
    });
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.mp3', ext: 'mp3', label: '曲' });
      await act(async () => {
        (container.querySelector('.pp-viewer-open-system') as HTMLButtonElement).click();
      });
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('用系统程序打开失败');
      expect(container.querySelector('.pp-viewer-open-system')).toBeNull();
    });
  });

  it('没有路径 ⇒ 不出按钮（免得点了没反应）', async () => {
    await withRenderers(async () => {
      await renderFile({ ext: 'xyz', label: 'x' });
      expect(container.querySelector('.pp-viewer-open-system')).toBeNull();
    });
  });
});
