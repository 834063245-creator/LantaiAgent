// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-model3d — 3D 模型查看器（渲染面补全 P2 · B9，2026-09-23）：
//
// jsdom **没有 WebGL**（`new WebGLRenderer` 构造即抛）⇒ 本文件的判据全部落在「不需要 GPU 的
// 那半边」，一条都不假装：解析（STLLoader / OBJLoader / GLTFLoader.parse）是**纯计算**，
// 读数（格式 / 三角面 / 顶点 / 包围盒）走真解析、逐值断言；渲染那半边只测**降级面**
// （可读提示 + 读数行照显）。静态首帧真出像素 / 浮层 rAF 循环 / OrbitControls 手势 /
// 线框的视觉结果这几条要真 GL，**不 mock three 去伪造绿灯**（未覆盖项列在文件末尾）。
//
//   ① 装载面：default 导出 = 重依赖取件键 `model3d`（`app/paper/viewers/*.tsx` 目录即
//      白名单，真经 `loadHeavyViewer` 取到同一函数）、认领表 = 宿主层分类表；
//   ② 无 WebGL 降级：极小 ASCII STL → 提示行 + 读数行（三角面 / 顶点 / 包围盒逐值）；
//   ③ 真实解析：极小 OBJ 文本（同族第二格式，钉住「按 ext 分派 loader」）；
//   ④ 压缩扩展：glTF `extensionsRequired` 命中 DRACO/KTX2 ⇒ 具名可读错误（不出空场景）；
//   ⑤ 解析失败：坏 glTF JSON ⇒ 可读错误；
//   ⑥ 空 bytes ⇒ 空态；空文件（0 字节）⇒ 可读错误；
//   ⑦ 宿主路径：`resolveAssetBlock('file','media')` → 宿主桥 `loadViewer('model3d')` 真取件
//      并渲染；取件失败（临时 def 的 `heavy:'不存在'`）⇒「重装载失败」可读错误；
//   ⑧ 两态：流内可点（`onOpenOverlay` 被调）；浮层有线框切换（`aria-pressed` 翻转）。

import { Buffer } from 'node:buffer';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heavyViewerIds, loadHeavyViewer } from '../src/app/paper/viewers';
import Model3dViewer from '../src/app/paper/viewers/model3d';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_MODEL_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import {
  type ViewerBytes,
  type ViewerDef,
  type ViewerProps,
  viewerRegistry,
} from '../src/plugins/builtin/renderers/viewer-registry';
import { model3dViewer } from '../src/plugins/builtin/renderers/viewers/model3d';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/* ── 极小 fixture（真解析、可逐值断言） ────────────────────────────── */

/** 四面体 ASCII STL：4 个 facet、12 个顶点（STL 无索引）、包围盒 1×1×1。 */
const TETRA_STL = [
  'solid tetra',
  'facet normal 0 0 -1',
  '  outer loop',
  '    vertex 0 0 0',
  '    vertex 0 1 0',
  '    vertex 1 0 0',
  '  endloop',
  'endfacet',
  'facet normal 0 -1 0',
  '  outer loop',
  '    vertex 0 0 0',
  '    vertex 1 0 0',
  '    vertex 0 0 1',
  '  endloop',
  'endfacet',
  'facet normal -1 0 0',
  '  outer loop',
  '    vertex 0 0 0',
  '    vertex 0 0 1',
  '    vertex 0 1 0',
  '  endloop',
  'endfacet',
  'facet normal 1 1 1',
  '  outer loop',
  '    vertex 1 0 0',
  '    vertex 0 1 0',
  '    vertex 0 0 1',
  '  endloop',
  'endfacet',
  'endsolid tetra',
].join('\n');

/** 同一个四面体的 OBJ 文本：4 个三角面、非索引（12 个 position 顶点）。 */
const TETRA_OBJ = [
  '# tetra',
  'v 0 0 0',
  'v 1 0 0',
  'v 0 1 0',
  'v 0 0 1',
  'f 1 2 3',
  'f 1 3 4',
  'f 1 4 2',
  'f 2 4 3',
].join('\n');

/** 用了 DRACO 压缩的 glTF（JSON 形态，本查看器不接解码器 ⇒ 必须具名报错）。 */
const DRACO_GLTF = JSON.stringify({
  asset: { version: '2.0' },
  extensionsUsed: ['KHR_draco_mesh_compression'],
  extensionsRequired: ['KHR_draco_mesh_compression'],
  scene: 0,
  scenes: [{ nodes: [] }],
  nodes: [],
});

/** 坏 JSON（截断）——解析必然失败。 */
const BROKEN_GLTF = '{ "asset": { "version": "2.0"';

/** 文本 → data URI（宿主给查看器的就是这一形态：`fs_cap read_base64` 的 base64）。 */
function dataUri(mime: string, text: string): ViewerBytes {
  return { kind: 'data-uri', value: `data:${mime};base64,${Buffer.from(text, 'utf8').toString('base64')}` };
}

/* ── 渲染脚手架 ────────────────────────────────────────────────── */

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
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

/** 让 promise 链 + React 提交都落地（动态取件 / 解析 / effect 各一轮）。 */
async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 「无 WebGL」环境（jsdom 的真实处境）——两件事都只为去掉**预期内**的输出噪声，
 *  一条也不改被测行为：
 *  ① `getContext` 走 jsdom 的 not-implemented 分支后本就是**返回 null**，这里直接给同一个
 *     null（省掉 virtualConsole 那行噪声）；three 拿到 null 抛
 *     「Error creating WebGL context.」这条路**照旧真走**（不是 mock three）；
 *  ② three 构造失败时自己 `console.error('THREE.WebGLRenderer: …')` 并重抛——这是**预期内**
 *     的诊断日志（同一句话已落进 DOM 提示行，用例照样断言），按前缀精确吞掉，
 *     其它 console.error（React 告警等）照常放行。
 *  用完还原（同 composer-dock-rack.test.tsx 的 getContext 桩先例）。 */
function withoutWebgl(): () => void {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalConsoleError = console.error;
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  console.error = (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && args[0].includes('THREE.WebGLRenderer')) return;
    originalConsoleError(...args);
  };
  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    console.error = originalConsoleError;
  };
}

function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

interface DirectProps {
  ext: string;
  bytes?: ViewerBytes;
  mode?: 'stream' | 'overlay';
  label?: string;
  onOpenOverlay?: () => void;
}

/** 直挂组件（不经宿主）：props 形状与宿主传参逐字一致。 */
async function renderDirect(props: DirectProps): Promise<void> {
  const filePath = `D:/models/a.${props.ext}`;
  const viewerProps: ViewerProps = {
    block: mediaBlock({ filePath, ext: props.ext, label: props.label ?? `a.${props.ext}` }),
    label: props.label ?? `a.${props.ext}`,
    ext: props.ext,
    filePath,
    mode: props.mode ?? 'stream',
  };
  if (props.bytes !== undefined) viewerProps.bytes = props.bytes;
  if (props.onOpenOverlay !== undefined) viewerProps.onOpenOverlay = props.onOpenOverlay;
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Model3dViewer, viewerProps));
  });
  await settle();
}

/** 读数行逐项（顺序 = 渲染序：三角面 / 顶点 / 包围盒）。 */
function statLines(): string[] {
  return [...container.querySelectorAll('.pp-viewer-3d-stat')].map((el) => el.textContent ?? '');
}

function textOf(selector: string): string {
  return container.querySelector(selector)?.textContent ?? '';
}

/* ── ① 装载面（认领 / 取件键） ───────────────────────────────────── */

describe('3D 模型查看器 · 装载面（P2 · B9）', () => {
  it('default 导出 = 取件键 `model3d`：目录即白名单，`loadHeavyViewer` 取到的就是它', async () => {
    expect(typeof Model3dViewer).toBe('function');
    expect(heavyViewerIds()).toContain('model3d');
    expect(await loadHeavyViewer('model3d')).toBe(Model3dViewer);
  });

  it('认领表 = 宿主层分类表；产物侧 def 声明 heavy 取件键 + 每个 ext 都有 MIME', () => {
    expect([...VIEWER_MODEL_EXTS]).toEqual(['glb', 'gltf', 'obj', 'stl']);
    for (const ext of VIEWER_MODEL_EXTS) expect(viewerClassOf(ext), ext).toBe('model3d');
    expect(model3dViewer.id).toBe('model3d');
    expect(model3dViewer.heavy).toBe('model3d');
    expect(model3dViewer.needsBytes).toBe(true);
    for (const ext of VIEWER_MODEL_EXTS) expect(model3dViewer.mimes?.[ext], ext).toBeTruthy();
    // 本查看器不认领别类扩展名（认领唯一性由注册面兜底，这里钉住「不越界」）
    for (const ext of ['pdf', 'png', 'mp3', 'csv', 'ttf']) expect(VIEWER_MODEL_EXTS.includes(ext), ext).toBe(false);
  });
});

/* ── ②③ 真解析读数 + 无 WebGL 降级 ─────────────────────────────── */

describe('3D 模型查看器 · 解析读数与无 WebGL 降级（P2 · B9）', () => {
  it('ASCII STL：无 WebGL ⇒ 可读提示，且读数行照显（格式 / 三角面 / 顶点 / 包围盒）', async () => {
    const restore = withoutWebgl();
    try {
      await renderDirect({ ext: 'stl', bytes: dataUri('model/stl', TETRA_STL), label: '四面体.stl' });
    } finally {
      restore();
    }
    // 文件身份行（名 / 格式 / 体积）
    expect(textOf('.pp-viewer-3d-meta-name')).toBe('四面体.stl');
    expect(textOf('.pp-viewer-3d-meta-ext')).toBe('stl');
    expect(textOf('.pp-viewer-3d-meta-size')).not.toBe('字节数未知');
    // 无 WebGL：一行可读提示（不空白、不崩）
    expect(textOf('.pp-viewer-note')).toContain('当前环境不支持 WebGL，无法预览 3D');
    expect(container.querySelector('.pp-viewer-3d-canvas')).not.toBeNull();
    // 读数仍显示：真解析出来的值（4 facet / 12 顶点 / 1×1×1）
    expect(statLines()).toEqual(['三角面 4', '顶点 12', '包围盒 1.00 × 1.00 × 1.00']);
  });

  it('OBJ 文本：按 ext 分派 OBJLoader，读数逐值正确（非索引 ⇒ 12 顶点）', async () => {
    const restore = withoutWebgl();
    try {
      await renderDirect({ ext: 'obj', bytes: dataUri('model/obj', TETRA_OBJ), label: '四面体.obj' });
    } finally {
      restore();
    }
    expect(textOf('.pp-viewer-3d-meta-ext')).toBe('obj');
    expect(statLines()).toEqual(['三角面 4', '顶点 12', '包围盒 1.00 × 1.00 × 1.00']);
    expect(textOf('.pp-viewer-note')).toContain('当前环境不支持 WebGL，无法预览 3D');
  });

  it('流内（mode=stream）：点一下走 onOpenOverlay（浮层由宿主渲染）', async () => {
    const restore = withoutWebgl();
    const onOpenOverlay = vi.fn();
    try {
      await renderDirect({
        ext: 'stl',
        bytes: dataUri('model/stl', TETRA_STL),
        onOpenOverlay,
      });
    } finally {
      restore();
    }
    const open = container.querySelector<HTMLButtonElement>('.pp-viewer-3d-open');
    expect(open).not.toBeNull();
    await act(async () => {
      open?.click();
    });
    expect(onOpenOverlay).toHaveBeenCalledTimes(1);
  });

  it('浮层（mode=overlay）：有线框切换（aria-pressed 翻转）、无「放大」按钮', async () => {
    const restore = withoutWebgl();
    try {
      await renderDirect({ ext: 'stl', bytes: dataUri('model/stl', TETRA_STL), mode: 'overlay' });
    } finally {
      restore();
    }
    expect(container.querySelector('.pp-viewer-3d-open')).toBeNull();
    const tool = container.querySelector<HTMLButtonElement>('.pp-viewer-3d-tool');
    expect(tool?.textContent).toBe('线框');
    expect(tool?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      tool?.click();
    });
    expect(tool?.getAttribute('aria-pressed')).toBe('true');
    // 读数在两种载体里都在
    expect(statLines()).toEqual(['三角面 4', '顶点 12', '包围盒 1.00 × 1.00 × 1.00']);
  });
});

/* ── ④⑤⑥ 失败面（压缩扩展 / 坏 JSON / 空） ────────────────────── */

describe('3D 模型查看器 · 失败面（P2 · B9）', () => {
  it('DRACO/KTX2 压缩：具名可读错误，不静默出空场景', async () => {
    await renderDirect({ ext: 'gltf', bytes: dataUri('model/gltf+json', DRACO_GLTF), label: '压缩模型.gltf' });
    const err = textOf('.pp-viewer-error');
    expect(err).toContain('该模型使用了 DRACO/KTX2 压缩');
    expect(err).toContain('KHR_draco_mesh_compression');
    expect(err).toContain('未启用解码器');
    // 不静默出空场景：既不画布也不给假读数
    expect(container.querySelector('.pp-viewer-3d-stage')).toBeNull();
    expect(statLines()).toEqual([]);
    // 文件身份行照显（失败不吞元信息）
    expect(textOf('.pp-viewer-3d-meta-name')).toBe('压缩模型.gltf');
  });

  it('坏 glTF JSON ⇒ 可读错误（带原因，不空白）', async () => {
    await renderDirect({ ext: 'gltf', bytes: dataUri('model/gltf+json', BROKEN_GLTF), label: '坏文件.gltf' });
    const err = textOf('.pp-viewer-error');
    expect(err).toContain('3D 模型不可预览');
    expect(err.length).toBeGreaterThan('3D 模型不可预览：'.length);
    expect(container.querySelector('.pp-viewer-3d-stage')).toBeNull();
  });

  it('空 bytes（宿主没给内容）⇒ 空态 + 文件身份行，不空白', async () => {
    await renderDirect({ ext: 'stl', label: '没有内容.stl' });
    expect(textOf('.pp-viewer-empty')).toContain('未提供模型内容');
    expect(textOf('.pp-viewer-3d-meta-name')).toBe('没有内容.stl');
    expect(container.querySelector('.pp-viewer-3d-stage')).toBeNull();
  });

  it('空文件（0 字节 data URI）⇒ 可读错误，不当成空模型渲染', async () => {
    await renderDirect({ ext: 'stl', bytes: { kind: 'data-uri', value: 'data:model/stl;base64,' } });
    expect(textOf('.pp-viewer-error')).toContain('文件为空（0 字节）');
    expect(container.querySelector('.pp-viewer-3d-stage')).toBeNull();
  });

  it('字节形态不是 data URI（text）⇒ 可读错误（本查看器只收二进制）', async () => {
    await renderDirect({ ext: 'stl', bytes: { kind: 'text', value: TETRA_STL } });
    expect(textOf('.pp-viewer-error')).toContain('字节形态不是 data URI');
  });
});

/* ── ⑦ 宿主路径（重依赖取件 + 取件失败降级） ───────────────────── */

/** 起组合服务 + 装载出厂渲染器行（`components.tsx` 模块装载期注册出厂查看器表）。 */
async function withHostSurface(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  try {
    await fn();
  } finally {
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
  }
}

/** 宿主 `MediaBody` → 渲染一个媒体块（字节走 `fs_cap read_base64`，故先打桩）。 */
async function renderThroughHost(payload: unknown): Promise<void> {
  const Comp = resolveAssetBlock('file', 'media');
  if (!Comp) throw new Error('media 行未注册——前置装配失败');
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Comp, { block: mediaBlock(payload) }));
  });
  await settle(4);
}

describe('3D 模型查看器 · 宿主路径（P2 · B9）', () => {
  it('宿主桥 `loadViewer` 真取件 → 真渲染本件（读数行 + 无 WebGL 提示）', async () => {
    const restore = withoutWebgl();
    vi.mocked(typedRpc).mockResolvedValue(
      JSON.stringify({ path: 'D:/models/a.stl', base64: Buffer.from(TETRA_STL, 'utf8').toString('base64') }),
    );
    try {
      await withHostSurface(async () => {
        await renderThroughHost({ filePath: 'D:/models/a.stl', ext: 'stl', label: '茶壶.stl' });
      });
    } finally {
      restore();
    }
    expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
      action: 'read_base64',
      file_path: 'D:/models/a.stl',
      is_agent: false,
    });
    expect(container.querySelector('.pp-viewer')).not.toBeNull();
    expect(textOf('.pp-viewer-3d-meta-ext')).toBe('stl');
    expect(statLines()).toEqual(['三角面 4', '顶点 12', '包围盒 1.00 × 1.00 × 1.00']);
    expect(textOf('.pp-viewer-note')).toContain('当前环境不支持 WebGL，无法预览 3D');
  });

  it('重依赖取件失败（heavy 键不存在）⇒「重装载失败」可读错误（宿主降级链）', async () => {
    const temp: ViewerDef = {
      id: 'test-model3d-missing',
      exts: ['zzmodel'],
      mimes: { zzmodel: 'model/stl' },
      needsBytes: true,
      heavy: '不存在的重查看器',
    };
    const dispose = viewerRegistry.register(temp);
    vi.mocked(typedRpc).mockResolvedValue(
      JSON.stringify({ path: 'D:/models/a.zzmodel', base64: Buffer.from(TETRA_STL, 'utf8').toString('base64') }),
    );
    try {
      await withHostSurface(async () => {
        expect(viewerRegistry.resolve('zzmodel')?.id).toBe('test-model3d-missing');
        await renderThroughHost({ filePath: 'D:/models/a.zzmodel', ext: 'zzmodel', label: '临时.stl' });
        const err = textOf('.pp-viewer-error');
        expect(err).toContain('重查看器「不存在的重查看器」装载失败');
        expect(err).toContain('未注册的重查看器');
      });
    } finally {
      dispose();
    }
    expect(viewerRegistry.get('test-model3d-missing')).toBeUndefined();
    expect(viewerRegistry.resolve('zzmodel')).toBeUndefined();
  });
});

/* 未覆盖（jsdom 无 GL，且不 mock three 伪造）：静态首帧真出像素、浮层 rAF 循环、
 * OrbitControls 手势、线框切换的视觉结果、dispose 的运行时观测（同一 effect 清理里
 * renderer / 环境贴图 / controls / rAF / RO + 对象树成对释放，见源码注释）。 */
