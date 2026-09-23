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
import { VIEWER_AUDIO_EXTS, VIEWER_IMAGE_EXTS } from '../src/paper/measure';
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

  it('扩展名归一：大小写与前导点都吃（注册与查询同一条判据）', () => {
    expect(normalizeExt('PNG')).toBe('png');
    expect(normalizeExt('.Png')).toBe('png');
    expect(normalizeExt(' png ')).toBe('png');
    const dispose = viewerRegistry.register(fakeDef({ id: 'tmp-norm', exts: ['.ZZ6'] }));
    expect(viewerRegistry.resolve('ZZ6')?.id).toBe('tmp-norm');
    expect(viewerRegistry.resolve('.zz6')?.id).toBe('tmp-norm');
    dispose();
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

describe('出厂查看器表（图片 / 视频 / 音频）', () => {
  it('认领面与 MIME 齐备：needsBytes 的每个 ext 都有 MIME，且路由唯一', () => {
    const seen = new Map<string, string>();
    for (const def of BUILTIN_VIEWERS) {
      expect(def.exts.length).toBeGreaterThan(0);
      for (const ext of def.exts) {
        expect(normalizeExt(ext)).toBe(ext); // 出厂表本身就归一（不靠装载期兜）
        expect(seen.has(ext), `${ext} 被 ${seen.get(ext)} 与 ${def.id} 同时认领`).toBe(false);
        seen.set(ext, def.id);
        if (def.needsBytes) expect(def.mimes?.[ext], `${def.id}.${ext} 缺 MIME`).toBeTruthy();
      }
    }
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

describe('measure 镜像对拍（宿主层 ext 表 ↔ 插件认领表）', () => {
  it('图片 ext 表两侧一致（漂了 = 静态测高与渲染面分家）', () => {
    expect([...VIEWER_IMAGE_EXTS].sort()).toEqual(
      [...(viewerRegistry.get('image')?.exts ?? [])].map(normalizeExt).sort(),
    );
  });

  it('音频 ext 表两侧一致（音频是固定盒高档，漂了 = 块高算错）', () => {
    expect([...VIEWER_AUDIO_EXTS].sort()).toEqual(
      [...(viewerRegistry.get('audio')?.exts ?? [])].map(normalizeExt).sort(),
    );
  });
});
