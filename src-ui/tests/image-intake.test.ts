// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 附图准入纯函数面回归（multimodal-image-plan B1）——magic-byte 嗅探/白名单/
// 尺寸投影/显示名清洗/base64/sha256/GIF 尺寸闸。canvas 规整面 webview 专供
// （jsdom 无 createImageBitmap），不在单测覆盖——真机验收 3 兜底。

import { describe, expect, it } from 'vitest';
import {
  admitImageBytes,
  attachmentFilePath,
  bytesToBase64,
  displayLeafName,
  extOfMediaType,
  extractImageFiles,
  gifDimensions,
  isImagePath,
  NORMALIZED_MAX_DIMENSION,
  NORMALIZED_MAX_PIXELS,
  previewUrlFor,
  projectedDimensions,
  sha256Hex,
  sniffImageMediaType,
  splitIntakePaths,
} from '../src/app/chat/image-intake';

// ── magic-byte 嗅探 ──

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_HEAD = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const GIF_HEAD = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const BMP_HEAD = new Uint8Array([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

describe('sniffImageMediaType', () => {
  it('四种白名单格式按 magic-byte 识别', () => {
    expect(sniffImageMediaType(PNG_HEAD)).toBe('image/png');
    expect(sniffImageMediaType(JPEG_HEAD)).toBe('image/jpeg');
    expect(sniffImageMediaType(WEBP_HEAD)).toBe('image/webp');
    expect(sniffImageMediaType(GIF_HEAD)).toBe('image/gif');
  });

  it('白名单外（bmp）与非图片字节拒绝', () => {
    expect(sniffImageMediaType(BMP_HEAD)).toBeUndefined();
    expect(sniffImageMediaType(new TextEncoder().encode('hello 文本'))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array(0))).toBeUndefined();
  });
});

// ── 白名单映射与限制常量 ──

describe('extOfMediaType / 限制常量', () => {
  it('mediaType → 磁盘扩展名', () => {
    expect(extOfMediaType('image/png')).toBe('png');
    expect(extOfMediaType('image/jpeg')).toBe('jpg');
    expect(extOfMediaType('image/webp')).toBe('webp');
    expect(extOfMediaType('image/gif')).toBe('gif');
  });

  it('限制常量钉值（抄 DSH 默认——漂移须显式改本测）', () => {
    expect(NORMALIZED_MAX_DIMENSION).toBe(2048);
    expect(NORMALIZED_MAX_PIXELS).toBe(2048 * 2048);
  });
});

// ── 尺寸投影（保比、不放大）──

describe('projectedDimensions', () => {
  it('小图不放大——原样通过', () => {
    expect(projectedDimensions(100, 50, 2048, 2048 * 2048)).toEqual({ width: 100, height: 50 });
  });

  it('长边约束绑定：4000×2000 → 2048×1024', () => {
    expect(projectedDimensions(4000, 2000, 2048, 2048 * 2048)).toEqual({ width: 2048, height: 1024 });
  });

  it('像素约束绑定：3000×3000 → 2048×2048', () => {
    expect(projectedDimensions(3000, 3000, 4096, 2048 * 2048)).toEqual({ width: 2048, height: 2048 });
  });

  it('极端长条图：宽度钳到 1 不消失', () => {
    const r = projectedDimensions(1, 100000, 2048, 2048 * 2048);
    expect(r.width).toBe(1);
    expect(r.height).toBe(2048);
  });

  it('非法尺寸抛错', () => {
    expect(() => projectedDimensions(0, 10, 2048, 2048 * 2048)).toThrow();
    expect(() => projectedDimensions(10, -1, 2048, 2048 * 2048)).toThrow();
  });
});

// ── GIF 尺寸头（不走 canvas——动画保护）──

describe('gifDimensions', () => {
  it('小端 u16 解析逻辑屏幕尺寸', () => {
    const gif = new Uint8Array([...GIF_HEAD, 0x00, 0x01, 0xc8, 0x00, 0x00, 0x00]);
    expect(gifDimensions(gif)).toEqual({ width: 256, height: 200 });
  });
});

// ── 显示名清洗 ──

describe('displayLeafName', () => {
  it('剥两种路径分隔符（POSIX 客户端路径不泄漏进 Windows 引用）', () => {
    expect(displayLeafName('C:\\Users\\x\\截图 2026.png')).toBe('截图 2026.png');
    expect(displayLeafName('/a/b/c.jpg')).toBe('c.jpg');
    expect(displayLeafName('裸名.png')).toBe('裸名.png');
  });

  it('控制字符清洗 + 255 上限 + 空名 undefined', () => {
    expect(displayLeafName(`x${String.fromCharCode(7)}y.png`)).toBe('xy.png');
    expect(displayLeafName('a'.repeat(300))?.length).toBe(255);
    expect(displayLeafName('///')).toBeUndefined();
    expect(displayLeafName(undefined)).toBeUndefined();
  });
});

// ── 编码与内容寻址 ──

describe('bytesToBase64 / sha256Hex', () => {
  it('base64 已知向量', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it('sha256 已知向量（内容寻址 id 真源）', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

// ── 落盘路径 ──

describe('attachmentFilePath', () => {
  it('内容寻址路径（尾分隔符归一）', () => {
    expect(attachmentFilePath('D:/ws/', 'abc123', 'image/png')).toBe('D:/ws/.lantai/attachments/abc123.png');
    expect(attachmentFilePath('D:\\ws', 'abc123', 'image/jpeg')).toBe('D:/ws/.lantai/attachments/abc123.jpg');
  });
});

// ── 准入错误路径（canvas 之前——纯同步拒绝）──

describe('admitImageBytes 拒绝路径', () => {
  it('空字节拒绝', async () => {
    await expect(admitImageBytes('D:/ws', new Uint8Array(0))).rejects.toThrow('附图为空文件');
  });

  it('非白名单格式拒绝（magic-byte 不认）', async () => {
    await expect(admitImageBytes('D:/ws', new TextEncoder().encode('hello'))).rejects.toThrow('不是受支持的图片格式');
  });

  it('超大 GIF 尺寸闸（不走 canvas 即拒）', async () => {
    const huge = new Uint8Array([...GIF_HEAD, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00]);
    await expect(admitImageBytes('D:/ws', huge)).rejects.toThrow('GIF 尺寸超限');
  });
});

// ── B2 采集路由（纯函数面）──

describe('isImagePath / splitIntakePaths', () => {
  it('图片扩展名识别（大小写不敏感 + jpeg 别名 + 无扩展名否决）', () => {
    expect(isImagePath('D:/a/截图.PNG')).toBe(true);
    expect(isImagePath('b/c/d.jpg')).toBe(true);
    expect(isImagePath('e.jpeg')).toBe(true);
    expect(isImagePath('f.webp')).toBe(true);
    expect(isImagePath('g.GIF')).toBe(true);
    expect(isImagePath('h.txt')).toBe(false);
    expect(isImagePath('noext')).toBe(false);
    expect(isImagePath('.gitignore')).toBe(false);
  });

  it('分流：allowImages=true 图片入附图道、其余走文件附件老路', () => {
    const r = splitIntakePaths(['a.png', 'b.txt', 'c/d.JPG', 'e.rs'], true);
    expect(r.images).toEqual(['a.png', 'c/d.JPG']);
    expect(r.files).toEqual(['b.txt', 'e.rs']);
  });

  it('分流：allowImages=false 全部走文件附件老路（文本模型零回归）', () => {
    const r = splitIntakePaths(['a.png', 'b.txt'], false);
    expect(r.images).toEqual([]);
    expect(r.files).toEqual(['a.png', 'b.txt']);
  });
});

describe('extractImageFiles（粘贴载荷抽图）', () => {
  const fakeItems = (
    entries: Array<{ kind: string; type?: string } | null>,
  ): Array<{ kind: string; getAsFile: () => File | null }> =>
    entries.map((e) => ({
      kind: e?.kind ?? 'string',
      getAsFile: () => (e && e.kind === 'file' && e.type ? new File(['x'], 'f', { type: e.type }) : null),
    }));

  it('kind=file 且 mime 图片的项抽出；文本/非图片/坏项略过', () => {
    const files = extractImageFiles(
      fakeItems([
        { kind: 'file', type: 'image/png' },
        { kind: 'string' },
        { kind: 'file', type: 'text/plain' },
        null,
        { kind: 'file', type: 'image/jpeg' },
      ]),
    );
    expect(files).toHaveLength(2);
    expect(files[0]?.type).toBe('image/png');
    expect(files[1]?.type).toBe('image/jpeg');
  });

  it('无图片载荷返回空数组（文本粘贴零影响判据）', () => {
    expect(extractImageFiles(fakeItems([{ kind: 'string' }, { kind: 'file', type: 'text/html' }]))).toEqual([]);
  });
});

describe('previewUrlFor（预览种子缓存——未命中降级）', () => {
  it('未种 id 返回 undefined（渲染层降级为占位盒）', () => {
    expect(previewUrlFor('never-seeded-id')).toBeUndefined();
  });
});
