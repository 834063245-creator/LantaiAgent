// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-registry — 查看器注册面（渲染面补全 B1，2026-09-23）：
//   ① 装载期纪律：重名 id / 跨查看器重名 ext / 空认领 / needsBytes 缺 MIME /
//      非正 maxBytes 一律 throw（带窗文案），不静默覆盖；
//   ② 出厂表：图片 / 视频 / 音频的认领与 MIME 齐备、路由唯一、未命中回落 undefined；
//   ③ disposer：幂等 + 陈旧性守卫（同 ext/id 重注册后旧 disposer 不误删新行）；
//   ④ **measure 镜像对拍**：paper/measure.ts 的图片/音频 ext 表是本层镜像
//      （宿主层不得反向 import 插件产物）——这里把两侧钉在一起，漂了就红。

import { describe, expect, it } from 'vitest';
import { VIEWER_EXTS_BY_CLASS, viewerClassOf } from '../src/paper/viewer-exts';
import { normalizeExt, type ViewerDef, viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { BUILTIN_VIEWERS, registerBuiltinViewers } from '../src/plugins/builtin/renderers/viewers';

// 出厂查看器在**模块装载期**注册（components.tsx 的调用点在渲染产物里）；本文件直接
// 注册一次（重复注册会因重名 throw——这正是「防装配双跑」的判据，见下方案例）。
registerBuiltinViewers();

/** 合成查看器（测试用假 ext，不碰真实路由）。 */
function fakeDef(over: Partial<ViewerDef> & { id: string; exts: string[] }): ViewerDef {
  return {
    needsBytes: false,
    component: () => null,
    ...over,
  };
}

describe('viewer-registry 装载期纪律（重名/缺件一律当场 throw）', () => {
  it('重复 id → throw（带窗文案点名 id）', () => {
    const d = fakeDef({ id: 'tmp-dup-id', exts: ['zz1'] });
    const dispose = viewerRegistry.register(d);
    expect(() => viewerRegistry.register(fakeDef({ id: 'tmp-dup-id', exts: ['zz2'] }))).toThrow(
      /重复注册查看器 "tmp-dup-id"/,
    );
    dispose();
  });

  it('跨查看器重名 ext → throw（文案同时点名两个 id——路由必须唯一）', () => {
    const first = viewerRegistry.register(fakeDef({ id: 'tmp-ext-a', exts: ['zz3'] }));
    expect(() => viewerRegistry.register(fakeDef({ id: 'tmp-ext-b', exts: ['zz3'] }))).toThrow(
      /扩展名 "zz3" 被两个查看器认领：先 "tmp-ext-a" 后 "tmp-ext-b"/,
    );
    first();
  });

  it('出厂表重复注册 → throw（防装配双跑）', () => {
    expect(() => registerBuiltinViewers()).toThrow(/重复注册查看器 "image"/);
  });

  it('空认领 → throw（永远不会被命中的查看器是装配错误）', () => {
    expect(() => viewerRegistry.register(fakeDef({ id: 'tmp-empty', exts: [] }))).toThrow(/未认领任何扩展名/);
    expect(() => viewerRegistry.register(fakeDef({ id: 'tmp-empty', exts: ['  ', '.'] }))).toThrow(/未认领任何扩展名/);
  });

  it('needsBytes 缺 MIME → throw（宿主拼不出 data URI，缺件必须在装载期可见）', () => {
    expect(() => viewerRegistry.register(fakeDef({ id: 'tmp-mime', exts: ['zz4'], needsBytes: true }))).toThrow(
      /需要字节但缺 "zz4" 的 MIME/,
    );
  });

  it('非正 maxBytes → throw', () => {
    expect(() => viewerRegistry.register(fakeDef({ id: 'tmp-max', exts: ['zz5'], maxBytes: 0 }))).toThrow(
      /maxBytes 必须是正数/,
    );
  });

  // ── 兜底认领（B8 新增契约）──
  it('第二个兜底查看器 → throw（出厂 hex 已占位）；兜底者 needsBytes=false → throw（先判自身形状）', () => {
    expect(() =>
      viewerRegistry.register(fakeDef({ id: 'tmp-fall-a', exts: [], catchAll: true, needsBytes: true })),
    ).toThrow(/兜底查看器只能有一个/);
    expect(() => viewerRegistry.register(fakeDef({ id: 'tmp-fall-c', exts: [], catchAll: true }))).toThrow(
      /必须 needsBytes/,
    );
  });

  it('兜底认领可无扩展名（空认领对它是合法的）——出厂 hex 就是「空 exts + catchAll」', () => {
    const hex = viewerRegistry.get('hex');
    expect(hex?.catchAll).toBe(true);
    expect(hex?.exts).toEqual([]);
    // 非兜底的空认领仍然是装配错误（上一条已钉）；这里钉两侧语义不同源
    expect(viewerRegistry.resolve('')).toBeUndefined();
  });

  it('扩展名归一：大小写与前导点都吃（注册与查询同一条判据）', () => {
    expect(normalizeExt('PNG')).toBe('png');
    expect(normalizeExt('.Png')).toBe('png');
    expect(normalizeExt(' png ')).toBe('png');
    const dispose = viewerRegistry.register(fakeDef({ id: 'tmp-norm', exts: ['.ZZ6'] }));
    expect(viewerRegistry.resolve('ZZ6')?.id).toBe('tmp-norm');
    expect(viewerRegistry.resolve('.zz6')?.id).toBe('tmp-norm');
    dispose();
  });

  // ── 文本读取形态（B2 新增契约：bytesKind:'text' + readLines）──
  it('文本查看器缺 readLines → throw（行窗口是「不整份进 IPC」的唯一闸）', () => {
    expect(() =>
      viewerRegistry.register(fakeDef({ id: 'tmp-text-a', exts: ['zz9'], needsBytes: true, bytesKind: 'text' })),
    ).toThrow(/缺 readLines/);
    expect(() =>
      viewerRegistry.register(
        fakeDef({ id: 'tmp-text-a2', exts: ['zz9'], needsBytes: true, bytesKind: 'text', readLines: 0 }),
      ),
    ).toThrow(/缺 readLines/);
  });

  it('bytesKind:text 但 needsBytes=false → throw（不读字节就没有文本）', () => {
    expect(() =>
      viewerRegistry.register(fakeDef({ id: 'tmp-text-b', exts: ['zz10'], bytesKind: 'text', readLines: 10 })),
    ).toThrow(/needsBytes=false/);
  });

  it('非文本查看器带 readLines → throw（字段与语义必须一致）', () => {
    expect(() =>
      viewerRegistry.register(
        fakeDef({
          id: 'tmp-text-c',
          exts: ['zz11'],
          needsBytes: true,
          mimes: { zz11: 'application/octet-stream' },
          readLines: 10,
        }),
      ),
    ).toThrow(/不是 text\/auto 形态/);
  });

  it("bytesKind:'auto'（兜底形态）：缺 readLines 或 needsBytes=false 同样拒", () => {
    expect(() =>
      viewerRegistry.register(fakeDef({ id: 'tmp-auto-a', exts: ['zz13'], needsBytes: true, bytesKind: 'auto' })),
    ).toThrow(/缺 readLines/);
    expect(() =>
      viewerRegistry.register(fakeDef({ id: 'tmp-auto-b', exts: ['zz14'], bytesKind: 'auto', readLines: 10 })),
    ).toThrow(/needsBytes=false/);
  });

  it('文本查看器不要求 mimes（形态是文本，不拼 data URI）；出厂 code 查看器是文本形态', () => {
    const dispose = viewerRegistry.register(
      fakeDef({ id: 'tmp-text-d', exts: ['zz12'], needsBytes: true, bytesKind: 'text', readLines: 10 }),
    );
    expect(viewerRegistry.resolve('zz12')?.id).toBe('tmp-text-d');
    dispose();
    const code = viewerRegistry.get('code');
    expect(code?.bytesKind).toBe('text');
    expect(code?.readLines).toBeGreaterThan(0);
    expect(code?.mimes).toBeUndefined();
  });
});

describe('disposer 幂等 + 陈旧性守卫', () => {
  it('dispose 后路由消失；重复 dispose 不炸', () => {
    const dispose = viewerRegistry.register(fakeDef({ id: 'tmp-disp', exts: ['zz7'] }));
    expect(viewerRegistry.resolve('zz7')?.id).toBe('tmp-disp');
    dispose();
    expect(viewerRegistry.resolve('zz7')).toBeUndefined();
    expect(() => dispose()).not.toThrow();
  });

  it('同 ext 重注册后，旧 disposer 不误删新行（陈旧守卫）', () => {
    const oldDispose = viewerRegistry.register(fakeDef({ id: 'tmp-old', exts: ['zz8'] }));
    oldDispose();
    const newDispose = viewerRegistry.register(fakeDef({ id: 'tmp-new', exts: ['zz8'] }));
    oldDispose(); // 陈旧：不得把 tmp-new 摘掉
    expect(viewerRegistry.resolve('zz8')?.id).toBe('tmp-new');
    newDispose();
    expect(viewerRegistry.resolve('zz8')).toBeUndefined();
  });
});

describe('出厂查看器表（图片 / 视频 / 音频 / 代码）', () => {
  it('认领面与 MIME 齐备：data-uri 形态的每个 ext 都有 MIME，且路由唯一', () => {
    const seen = new Map<string, string>();
    for (const def of BUILTIN_VIEWERS) {
      if (def.catchAll) continue; // 兜底认领：无认领表，MIME 由宿主按二进制兜（下方专测）
      expect(def.exts.length).toBeGreaterThan(0);
      for (const ext of def.exts) {
        expect(normalizeExt(ext)).toBe(ext); // 出厂表本身就归一（不靠装载期兜）
        expect(seen.has(ext), `${ext} 被 ${seen.get(ext)} 与 ${def.id} 同时认领`).toBe(false);
        seen.set(ext, def.id);
        // 文本形态（bytesKind:'text'）不拼 data URI ⇒ 不要求 MIME；其余要字节的必须有
        if (def.needsBytes && def.bytesKind !== 'text') {
          expect(def.mimes?.[ext], `${def.id}.${ext} 缺 MIME`).toBeTruthy();
        }
      }
    }
  });

  it('兜底认领（B8）：出厂表里恰有一个 catchAll，接未命中档，且不进 supportedExts', () => {
    const fallbacks = BUILTIN_VIEWERS.filter((d) => d.catchAll);
    expect(fallbacks.map((d) => d.id)).toEqual(['hex']);
    expect(viewerRegistry.catchAll()?.id).toBe('hex');
    expect(viewerRegistry.resolve('xyz-none')).toBeUndefined(); // 认领表里没有
    expect(viewerRegistry.catchAll()?.needsBytes).toBe(true); // 不读字节无从嗅探
    expect(viewerRegistry.supportedExts()).not.toContain('hex');
  });

  it('resolve 命中（含大小写/点号宽容）与未命中回落 undefined', () => {
    expect(viewerRegistry.resolve('mp3')?.id).toBe('audio');
    expect(viewerRegistry.resolve('MP3')?.id).toBe('audio');
    expect(viewerRegistry.resolve('.flac')?.id).toBe('audio');
    expect(viewerRegistry.resolve('png')?.id).toBe('image');
    expect(viewerRegistry.resolve('svg')?.id).toBe('image');
    expect(viewerRegistry.resolve('mov')?.id).toBe('video');
    // 未命中：宿主据此走文件壳（B1 前行为，零变化）
    expect(viewerRegistry.resolve('xyz')).toBeUndefined();
    expect(viewerRegistry.resolve('')).toBeUndefined();
    expect(viewerRegistry.resolve(undefined)).toBeUndefined();
  });

  it('supportedExts() = 各查看器 exts 的并集（排序去重）——未知扩展名的报错窗用它', () => {
    const union = [...new Set(BUILTIN_VIEWERS.flatMap((d) => d.exts.map(normalizeExt)))].sort();
    expect(viewerRegistry.supportedExts()).toEqual(union);
    expect(viewerRegistry.supportedExts()).toContain('mp3');
  });

  it('不支持字节的查看器不设 maxBytes（只看元数据的查看器没有「超限」语义）', () => {
    for (const def of BUILTIN_VIEWERS) {
      if (!def.needsBytes) expect(def.maxBytes).toBeUndefined();
    }
  });
});

describe('认领表与宿主层分类表同源（B2 起：paper/viewer-exts 单一真源）', () => {
  it('每个出厂查看器的认领表 = 该类的宿主层扩展名表（两侧不可能漂）', () => {
    for (const def of BUILTIN_VIEWERS) {
      if (def.catchAll) continue; // 兜底认领没有类（接的是「谁都没认领」）
      const cls = def.id as keyof typeof VIEWER_EXTS_BY_CLASS;
      expect(VIEWER_EXTS_BY_CLASS[cls], `宿主层没有 "${cls}" 类`).toBeDefined();
      expect([...def.exts].sort()).toEqual([...VIEWER_EXTS_BY_CLASS[cls]].sort());
    }
  });

  it('分类表自身：四类互不重叠、类内无重复（认领唯一性的宿主层一半）', () => {
    const seen = new Map<string, string>();
    for (const [cls, exts] of Object.entries(VIEWER_EXTS_BY_CLASS)) {
      expect(new Set(exts).size, `${cls} 类内有重复扩展名`).toBe(exts.length);
      for (const ext of exts) {
        expect(seen.has(ext), `${ext} 同时在 ${seen.get(ext)} 与 ${cls} 类`).toBe(false);
        seen.set(ext, cls);
      }
    }
  });

  it('measure 判据走同一张表（viewerClassOf 的类与认领表一致 + 大小写宽容 + 未认领 undefined）', () => {
    for (const [cls, exts] of Object.entries(VIEWER_EXTS_BY_CLASS)) {
      for (const ext of exts) expect(viewerClassOf(ext), ext).toBe(cls);
      expect(viewerClassOf(exts[0]?.toUpperCase()), '大小写宽容').toBe(cls);
    }
    expect(viewerClassOf('xyz')).toBeUndefined(); // 未认领 → 文件壳档
    expect(viewerClassOf(undefined)).toBeUndefined();
  });
});
