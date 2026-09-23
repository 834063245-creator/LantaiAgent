// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-chem — 化学结构查看器（渲染面补全 P1 · B12 之一，2026-09-23）：
//   ① 认领面：mol/sdf/pdb 路由到 'chem'，且认领表**就是**宿主层分类表（同一常量）；
//   ② 文本读取形态：宿主走 `fs_cap read` 的**行窗口**（limit = readLines + 1 = 6001）；
//   ③ 自绘 SVG（molfile V2000）：原子圆数 = 原子数、键线数 = 键数（双键 = 平行双线）；
//   ④ SDF 多条记录：「第 N / 共 M 条」受控切换逐条渲染；
//   ⑤ PDB：ATOM/HETATM 出图 + 「按文件坐标投影，非化学感知布局」如实标注；
//   ⑥ 失败面：坏记录 ⇒ 可读错误行 + 原文照显（不空白、不 JSON 兜底）；
//   ⑦ 截断不静默：窗口外还有行 ⇒ 吸顶横幅说清「只读前 6000 行」。
//
// 注册纪律：出厂注册行由 `viewers/index.ts` 持有（本批不抢占该文件）；本文件自己
// 注册一次并在收尾 dispose——若 index.ts 的注册行已落地（同一 def 实例已注册），
// 本次注册自动跳过（重名会装载期 throw，那是注册面的防双跑纪律）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_CHEM_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { chemViewer } from '../src/plugins/builtin/renderers/viewers/chem';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/** 读口成功响应（`fs_cap read` 的文本结局：{path, content}）。 */
function readOk(content: string): string {
  return JSON.stringify({ path: 'D:/a.mol', content: content });
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

/* ── fixture：molfile V2000（列位是契约，故原子/键行逐列对齐）── */

/** 乙醇骨架：3 原子 · 2 单键（碳不标符号 ⇒ 图上只有 1 个元素符号 O）。 */
const MOL_ETHANOL = [
  'ethanol',
  '  Lantai test',
  '',
  '  3  2  0  0  0  0            999 V2000',
  '    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    1.2990    0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    2.5980    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0',
  '  1  2  1  0  0  0  0',
  '  2  3  1  0  0  0  0',
  'M  END',
].join('\n');

/** 苯环：6 原子 · 6 键（交替双/单 ⇒ 键线 = 3×2 + 3×1 = 9 条）。 */
const MOL_BENZENE = [
  'benzene',
  '  Lantai test',
  '',
  '  6  6  0  0  0  0            999 V2000',
  '    1.2990    0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    1.2990   -0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    0.0000   -1.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '   -1.2990   -0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '   -1.2990    0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    0.0000    1.5000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '  1  2  2  0  0  0  0',
  '  2  3  1  0  0  0  0',
  '  3  4  2  0  0  0  0',
  '  4  5  1  0  0  0  0',
  '  5  6  2  0  0  0  0',
  '  6  1  1  0  0  0  0',
  'M  END',
].join('\n');

/** 坏记录：counts 声明 6 个原子，原子块只有 2 行（字段不足必须当场可见）。 */
const MOL_BROKEN = [
  'broken',
  '  Lantai test',
  '',
  '  6  1  0  0  0  0            999 V2000',
  '    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    1.2990    0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  'M  END',
].join('\n');

/** SDF：两条记录（第一条 = 乙醇 3 原子，第二条 = O=O 2 原子 1 双键）。 */
const SDF_TWO = [
  MOL_ETHANOL,
  '$$$$',
  [
    'dioxygen',
    '  Lantai test',
    '',
    '  2  1  0  0  0  0            999 V2000',
    '    0.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0',
    '    1.2000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0',
    '  1  2  2  0  0  0  0',
    'M  END',
  ].join('\n'),
  '$$$$',
].join('\n');

/* ── fixture：PDB（列位契约：serial[6,11) x[30,38) y[38,46) 元素[76,78)）── */

function pdbAtomLine(
  serial: number,
  name: string,
  resName: string,
  x: number,
  y: number,
  z: number,
  el: string,
): string {
  return (
    'ATOM  ' +
    String(serial).padStart(5) +
    ' ' +
    name.padEnd(4).slice(0, 4) +
    ' ' +
    resName.padEnd(3).slice(0, 3) +
    ' ' +
    'A' +
    '   1' +
    ' ' +
    '   ' +
    x.toFixed(3).padStart(8) +
    y.toFixed(3).padStart(8) +
    z.toFixed(3).padStart(8) +
    '  1.00' +
    '  0.00' +
    ' '.repeat(10) +
    el.padStart(2)
  );
}

function pdbConectLine(serials: number[]): string {
  return `CONECT${serials.map((s) => String(s).padStart(5)).join('')}`;
}

const PDB_WATER = [
  'HEADER    LANTAI TEST',
  pdbAtomLine(1, 'O', 'HOH', 0.0, 0.0, 0.0, 'O'),
  pdbAtomLine(2, 'H', 'HOH', 0.957, 0.0, 0.0, 'H'),
  pdbAtomLine(3, 'H', 'HOH', -0.24, 0.927, 0.0, 'H'),
  pdbConectLine([1, 2, 3]),
  pdbConectLine([2, 1]),
  pdbConectLine([3, 1]),
  'END',
].join('\n');

/** 本文件全程持有注册（**文件级**——挂在某个 describe 上会随该块收尾被 dispose，
 *  后面的渲染用例就落到兜底查看器上去了）。 */
let disposeChem: (() => void) | null = null;

beforeAll(() => {
  if (!viewerRegistry.get(chemViewer.id)) disposeChem = viewerRegistry.register(chemViewer);
});

afterAll(() => {
  disposeChem?.();
  disposeChem = null;
});

describe('化学查看器 · 认领面（B12）', () => {
  it('认领表就是宿主层分类表（同一常量引用，两侧不可能漂）', () => {
    expect(chemViewer.exts).toBe(VIEWER_CHEM_EXTS);
    expect([...VIEWER_CHEM_EXTS]).toEqual(['mol', 'sdf', 'pdb']);
    for (const ext of ['mol', 'sdf', 'pdb']) {
      expect(viewerClassOf(ext), ext).toBe('chem');
      expect(viewerRegistry.resolve(ext)?.id, ext).toBe('chem');
    }
  });

  it('文本形态 + 行窗口 + 体积闸（与 code 查看器同一条纪律）', () => {
    expect(chemViewer.bytesKind).toBe('text');
    expect(chemViewer.readLines).toBe(6000);
    expect(chemViewer.maxBytes).toBe(2 * 1024 * 1024);
    expect(chemViewer.mimes).toBeUndefined(); // 文本形态不拼 data URI
  });
});

describe('化学查看器 · 自绘与失败面（B12）', () => {
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

  async function renderChem(payload: unknown): Promise<void> {
    const Comp = resolveAssetBlock('file', 'media')!;
    root?.unmount();
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('文本读取走 fs_cap read 的**行窗口**（limit = readLines + 1 = 6001），题名行在', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(MOL_ETHANOL));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/ethanol.mol', ext: 'mol', label: 'ethanol.mol' });
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/ethanol.mol',
        limit: 6001,
        is_agent: false,
      });
      expect(container.querySelector('.pp-viewer-chem')).not.toBeNull();
      expect(container.querySelector('.pp-viewer-label')?.textContent).toBe('ethanol.mol');
    });
  });

  it('① 小 molfile 出 SVG：原子圆数 = 原子数（3）、键线数 = 键数（2）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(MOL_ETHANOL));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/ethanol.mol', ext: 'mol', label: 'ethanol.mol' });
      expect(container.querySelector('.pp-viewer-chem-svg')).not.toBeNull();
      expect(container.querySelectorAll('.pp-viewer-chem-atom').length).toBe(3);
      expect(container.querySelectorAll('.pp-viewer-chem-bond').length).toBe(2);
      expect(container.querySelectorAll('.pp-viewer-chem-bond-line').length).toBe(2);
      // 碳不标符号，杂原子标：3 个原子里只有 O 出一个文字标签
      expect(container.querySelectorAll('.pp-viewer-chem-symbol').length).toBe(1);
      expect(container.querySelector('.pp-viewer-chem-symbol')?.textContent).toBe('O');
      // 单条记录：读数行恒在，切换按钮不出现
      expect(container.querySelector('.pp-viewer-chem-pos')?.textContent).toBe('第 1 / 共 1 条');
      expect(container.querySelectorAll('.pp-viewer-chem-nav button').length).toBe(0);
      expect(container.querySelector('.pp-viewer-chem-meta')?.textContent).toContain('3 原子 · 2 键');
    });
  });

  it('键级照画：苯环 6 键（3 双 3 单）⇒ 9 条线（双键 = 平行双线）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(MOL_BENZENE));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/benzene.mol', ext: 'mol', label: 'benzene.mol' });
      expect(container.querySelectorAll('.pp-viewer-chem-atom').length).toBe(6);
      expect(container.querySelectorAll('.pp-viewer-chem-bond').length).toBe(6);
      expect(container.querySelectorAll('.pp-viewer-chem-bond-line').length).toBe(9);
    });
  });

  it('② SDF 两条记录：出读数行 + 受控切换（上下条各自渲染）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(SDF_TWO));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/two.sdf', ext: 'sdf', label: 'two.sdf' });
      expect(container.querySelector('.pp-viewer-chem-pos')?.textContent).toBe('第 1 / 共 2 条');
      expect(container.querySelectorAll('.pp-viewer-chem-atom').length).toBe(3);
      const buttons = container.querySelectorAll<HTMLButtonElement>('.pp-viewer-chem-nav button');
      expect(buttons.length).toBe(2);
      expect(buttons[0].disabled).toBe(true); // 首条：上一条禁用
      await act(async () => {
        buttons[1].click();
      });
      expect(container.querySelector('.pp-viewer-chem-pos')?.textContent).toBe('第 2 / 共 2 条');
      expect(container.querySelectorAll('.pp-viewer-chem-atom').length).toBe(2);
      expect(container.querySelectorAll('.pp-viewer-chem-bond-line').length).toBe(2); // 双键两条线
      expect(container.querySelector('.pp-viewer-chem-meta')?.textContent).toContain('dioxygen');
      await act(async () => {
        container.querySelectorAll<HTMLButtonElement>('.pp-viewer-chem-nav button')[0].click();
      });
      expect(container.querySelector('.pp-viewer-chem-pos')?.textContent).toBe('第 1 / 共 2 条');
      expect(container.querySelectorAll('.pp-viewer-chem-atom').length).toBe(3);
    });
  });

  it('③ PDB：ATOM/HETATM 出图 + CONECT 成键去重 + 如实标注「投影、非化学感知」', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(PDB_WATER));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/water.pdb', ext: 'pdb', label: 'water.pdb' });
      expect(container.querySelectorAll('.pp-viewer-chem-atom').length).toBe(3);
      // CONECT 两侧都列（1→2 与 2→1）⇒ 去重成 2 条键
      expect(container.querySelectorAll('.pp-viewer-chem-bond').length).toBe(2);
      expect(container.querySelectorAll('.pp-viewer-chem-symbol').length).toBe(3); // O/H/H 都标
      const meta = container.querySelector('.pp-viewer-chem-meta')?.textContent ?? '';
      expect(meta).toContain('PDB');
      expect(meta).toContain('投影');
      expect(meta).toContain('非化学感知');
    });
  });

  it('④ 坏 molfile → 可读错误行 + 原文照显（不空白、不 JSON 兜底）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(MOL_BROKEN));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/broken.mol', ext: 'mol', label: 'broken.mol' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('无法绘制第 1 条记录');
      expect(err).toContain('原子块不完整');
      expect(err).toContain('6 个原子');
      // 原文照显（窗口内）——不是空白，也不是 JSON 兜底
      const raw = container.querySelector('.pp-viewer-chem-pre')?.textContent ?? '';
      expect(raw).toContain('6  1  0  0  0  0');
      expect(raw).toContain('M  END');
      expect(container.querySelector('.pp-viewer-chem-svg')).toBeNull(); // 坏记录不画图
      expect(container.querySelector('.pp-viewer-chem-raw')).not.toBeNull();
    });
  });

  it('非 molfile 文本（比如把 JSON 存成 .mol）→ 可读错误 + 原文，不 JSON 兜底', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('{"atoms": 3}'));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/x.mol', ext: 'mol', label: 'x.mol' });
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('不足 4 行');
      expect(container.querySelector('.pp-viewer-chem-pre')?.textContent).toContain('{"atoms": 3}');
    });
  });

  it('空文件 → 明说「文件为空（0 行）」，不留空白盒', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(''));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/a.mol', ext: 'mol', label: 'a.mol' });
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('文件为空');
      expect(container.querySelector('.pp-viewer-chem')).toBeNull();
    });
  });

  it('无 M  END 结束标记 → 读数行如实提示「可能被截断」（不静默照画）', async () => {
    const noEnd = MOL_ETHANOL.split('\n').slice(0, -1).join('\n'); // 去掉末行 M  END
    vi.mocked(typedRpc).mockResolvedValue(readOk(noEnd));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/no-end.mol', ext: 'mol', label: 'no-end.mol' });
      expect(container.querySelector('.pp-viewer-chem-meta')?.textContent).toContain('没有 M  END 结束标记');
      expect(container.querySelectorAll('.pp-viewer-chem-atom').length).toBe(3);
    });
  });

  it('PDB 有 MODEL 块却没有任何坐标行 → 可读错误 + 原文（不落空盒）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('MODEL        1\nENDMDL\nEND\n'));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/empty.pdb', ext: 'pdb', label: 'empty.pdb' });
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('没有读到 ATOM/HETATM 行');
      expect(container.querySelector('.pp-viewer-chem-pre')?.textContent).toContain('MODEL');
      expect(container.querySelector('.pp-viewer-chem-svg')).toBeNull();
    });
  });

  it('⑦ 窗口外还有行 → 吸顶横幅说清「只读前 6000 行」（截断不静默）', async () => {
    const many = Array.from({ length: 900 }, () => MOL_ETHANOL).join('\n$$$$\n');
    vi.mocked(typedRpc).mockResolvedValue(readOk(many));
    await withRenderers(async () => {
      await renderChem({ filePath: 'D:/many.sdf', ext: 'sdf', label: 'many.sdf' });
      const note = container.querySelector('.pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('已截断：只读前 6000 行（文件更长）');
      expect(container.querySelectorAll('.pp-viewer-chem-atom').length).toBe(3);
    });
  });
});
