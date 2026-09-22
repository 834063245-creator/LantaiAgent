// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 附图发送带回归（2026-09-22 读图挂起事故）。
//
// 事故形态（用户操作序列）：让 Agent `fs(read)` 读一张桌面上的 2560×1400 PNG
// （6.46MB）→ 工具附图通道**不经过创作坞准入规整** → 内联成 8.61MB data URI 上线
// → 服务商 30 秒零字节、连试两轮无果 → 用户读成「Agent 挂了」。
//
// 本文件钉四件事：
//   ① 发送带（WIRE_*）取值与「合规图零漂移」——合规图必须逐字节原样，不重复重编码；
//   ② 越界图规整：降采样 + 编码切换（PNG → WebP）直到进带；压不进去抛错；
//   ③ 最后一道闸：解析产物超带 → 摘图换占位（模型知道有图没送到），并发挂起分账；
//   ④ 挂起分账判据（载荷可疑 → 计数预算；无图 → 维持时间预算）。

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn(async () => JSON.stringify({ base64: '' }));
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => mockRpc(...(args as [])),
  invoke: vi.fn(),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import {
  dropImagesOverBudget,
  overBudgetImageText,
  overWireBudgetIds,
  WIRE_IMAGE_CAPS,
  WIRE_MAX_IMAGE_BASE64_CHARS,
  WIRE_MAX_IMAGE_BYTES,
  WIRE_MAX_IMAGE_DIMENSION,
  wireImageChars,
} from '../src/agent/request-images';
import {
  STALL_NOTICE_MARK,
  STALL_RETRY_BUDGET_MS,
  SUSPECT_PAYLOAD_MAX_ATTEMPTS,
  SUSPECT_PAYLOAD_MIN_WIRE_CHARS,
  withinRetryBudget,
} from '../src/agent/retry';
import {
  base64ToBytes,
  bytesToBase64,
  extractImageFiles,
  projectImageForWire,
  readAttachmentForWire,
} from '../src/app/chat/image-intake';
import type { ChatImageRef, Message } from '../src/provider/types';

/** 发送带常量钉值（漂移须显式改本测）。 */
describe('发送带常量（2026-09-22 事故取值）', () => {
  it('单图 2MiB / 长边 2048 / base64 上限按 4/3 膨胀', () => {
    expect(WIRE_MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024);
    expect(WIRE_MAX_IMAGE_DIMENSION).toBe(2048);
    expect(WIRE_MAX_IMAGE_BASE64_CHARS).toBe(Math.ceil((WIRE_MAX_IMAGE_BYTES * 4) / 3) + 4);
    // 事故载荷（6.46MB 源字节 → 8.61MB base64）必须被判越界——这是本闸存在的理由
    expect(8_609_132).toBeGreaterThan(WIRE_MAX_IMAGE_BASE64_CHARS);
  });

  it('载荷分账门槛低于带内上限（带内图也可能触发快停）', () => {
    expect(SUSPECT_PAYLOAD_MIN_WIRE_CHARS).toBeLessThan(WIRE_MAX_IMAGE_BASE64_CHARS);
  });
});

/** 画布替身：按「像素 × 每像素字节」编出确定体量，用来驱动规整轮次（jsdom 无编解码器）。 */
function stubCanvas(bytesPerPixel: (type: string) => number): { calls: string[] } {
  const calls: string[] = [];
  const g = globalThis as unknown as { createImageBitmap?: unknown };
  g.createImageBitmap = async () => ({ width: SRC_W, height: SRC_H, close: () => {} });
  HTMLCanvasElement.prototype.getContext = (() =>
    ({ drawImage: () => {} }) as unknown as CanvasRenderingContext2D) as never;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback, type?: string) {
    const w = this.width;
    const h = this.height;
    calls.push(`${type}@${w}x${h}`);
    const size = Math.max(1, Math.floor(w * h * bytesPerPixel(type ?? '')));
    cb(new Blob([new Uint8Array(size)], { type: type ?? 'image/png' }));
  } as never;
  return { calls };
}

const SRC_W = 2560;
const SRC_H = 1400;

afterEach(() => {
  vi.restoreAllMocks();
});

const TINY_CAPS = { maxBytes: 2000, maxDimension: 2048, maxPixels: 2048 * 2048 };

describe('projectImageForWire', () => {
  it('合规图零漂移：逐字节原样返回，且不触碰画布（不重复重编码）', async () => {
    const bytes = new Uint8Array(500);
    const b64 = bytesToBase64(bytes);
    const { calls } = stubCanvas(() => 1);
    const out = await projectImageForWire(b64, 'image/png', 640, 480, WIRE_IMAGE_CAPS);
    expect(out.data).toBe(b64); // 同一字符串（零漂移）
    expect(out.mediaType).toBe('image/png');
    expect(calls).toHaveLength(0); // 画布一次都没用
  });

  it('越界图逐轮收紧：先按带内尺寸重编码，仍超则 PNG 换 WebP 直到进带', async () => {
    // 源图 2560×1400 = 3.58M 像素；png 每像素 1 字节 → 3.58MB > 2MiB 上限；
    // webp 每像素 0.05 字节 → 2048×1120 时约 114KB，进带。
    const b64 = bytesToBase64(new Uint8Array(3000));
    const { calls } = stubCanvas((type) => (type === 'image/png' ? 1 : 0.05));
    const out = await projectImageForWire(b64, 'image/png', SRC_W, SRC_H, WIRE_IMAGE_CAPS);
    expect(out.mediaType).toBe('image/webp'); // 编码切换发生（媒型必须跟着换）
    expect(calls[0]).toBe('image/png@2048x1120'); // 第一轮：保比降到带内长边
    expect(calls[1]).toBe('image/webp@2048x1120'); // 第二轮：**同尺寸**先换有损编码（先丢压缩率）
    expect(base64ToBytes(out.data).length).toBeLessThanOrEqual(WIRE_MAX_IMAGE_BYTES);
  });

  it('换编码仍超带 → 才开始让步尺寸（先丢压缩率，后丢像素）', async () => {
    // 每像素 0.5 字节：2048×1120 = 1.15MB；把带压到 700KB 逼出第三轮的尺寸让步
    const b64 = bytesToBase64(new Uint8Array(3000));
    const { calls } = stubCanvas(() => 0.5);
    const caps = { maxBytes: 700_000, maxDimension: 2048, maxPixels: 2048 * 2048 };
    const out = await projectImageForWire(b64, 'image/png', SRC_W, SRC_H, caps);
    expect(calls[0]).toBe('image/png@2048x1120');
    expect(calls[1]).toBe('image/webp@2048x1120');
    expect(calls[2]).toBe('image/webp@1536x840'); // 第三轮才缩尺寸
    expect(base64ToBytes(out.data).length).toBeLessThanOrEqual(caps.maxBytes);
  });

  it('四轮仍压不进带 → 抛错（不假装成功）', async () => {
    const b64 = bytesToBase64(new Uint8Array(3000));
    stubCanvas(() => 1); // 任何编码都 1 字节/像素 → 永远超带
    await expect(projectImageForWire(b64, 'image/png', SRC_W, SRC_H, TINY_CAPS)).rejects.toThrow(/发送上限/);
  });

  it('读取腰规整失败 → fail-open 回原字节（不吞图；由 agent 侧预算闸兜底）', async () => {
    const real = bytesToBase64(new Uint8Array(3000));
    mockRpc.mockResolvedValueOnce(JSON.stringify({ base64: real }));
    // 画布不可用（等价 jsdom / 解码失败）→ encodeAt 抛错 → 兜底路径
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ref: ChatImageRef = { id: 'f'.repeat(64), mediaType: 'image/png', bytes: 6456848, width: 2560, height: 1400 };
    const out = await readAttachmentForWire('D:/ws', ref, WIRE_IMAGE_CAPS);
    expect(out.data).toBe(real); // 原字节照发——「送不出去」由 agent 侧闸响亮交代
    expect(out.mediaType).toBe('image/png');
    expect(warn).toHaveBeenCalled();
    mockRpc.mockResolvedValue(JSON.stringify({ base64: '' }));
  });
});

// ── 最后一道闸：超带图摘除 ──

function userMsg(content: string, images: ChatImageRef[]): Message {
  return { role: 'user', content, images };
}

const REF: ChatImageRef = { id: 'a'.repeat(64), mediaType: 'image/png', bytes: 6_456_848, width: 2560, height: 1400 };

describe('单图 wire 预算闸', () => {
  it('超带产物命中；带内产物不命中', () => {
    const over = overWireBudgetIds({
      [REF.id]: { mediaType: 'image/png', data: 'A'.repeat(WIRE_MAX_IMAGE_BASE64_CHARS + 1) },
      other: { mediaType: 'image/png', data: 'A'.repeat(100) },
    });
    expect([...over]).toEqual([REF.id]);
    expect(overWireBudgetIds(undefined).size).toBe(0);
  });

  it('摘图换占位：引用摘除、占位点名尺寸与体量、其余消息零改动', () => {
    const keep: ChatImageRef = { ...REF, id: 'b'.repeat(64), name: 'small.png', bytes: 40_000 };
    const msgs: Message[] = [userMsg('看图', [REF, keep]), { role: 'assistant', content: '好' }];
    const out = dropImagesOverBudget(msgs, new Set([REF.id]));
    expect(out[0]?.images?.map((r) => r.id)).toEqual([keep.id]);
    expect(String(out[0]?.content)).toContain('已省略');
    expect(String(out[0]?.content)).toContain('2560×1400');
    expect(out[1]).toBe(msgs[1]); // 无图消息原对象（零漂移）
  });

  it('占位文案带上限与压缩指引（用户可据以行动）', () => {
    const text = overBudgetImageText(REF);
    expect(text).toContain('2MiB');
    expect(text).toContain('压缩后重发');
  });

  it('wireImageChars 量的是实际要发的 base64 总量（分账判据）', () => {
    expect(wireImageChars(undefined)).toBe(0);
    expect(
      wireImageChars({
        a: { mediaType: 'image/png', data: 'x'.repeat(SUSPECT_PAYLOAD_MIN_WIRE_CHARS + 1) },
      }),
    ).toBeGreaterThan(SUSPECT_PAYLOAD_MIN_WIRE_CHARS);
  });
});

// ── 挂起分账 ──

describe('挂起预算分账（载荷可疑 → 计数预算）', () => {
  const stall = new Error(`${STALL_NOTICE_MARK} [响应超时] 30 秒内未收到服务商任何数据`);

  it('载荷可疑：到 SUSPECT_PAYLOAD_MAX_ATTEMPTS 就停（不盲等 15 分钟）', () => {
    expect(withinRetryBudget(stall, 0, 0, { suspectPayload: true })).toBe(true);
    expect(withinRetryBudget(stall, SUSPECT_PAYLOAD_MAX_ATTEMPTS - 1, 0, { suspectPayload: true })).toBe(false);
    // 时间预算再宽也不放行
    expect(withinRetryBudget(stall, 5, STALL_RETRY_BUDGET_MS / 2, { suspectPayload: true })).toBe(false);
  });

  it('无载荷线索的挂起仍走时间预算（2026-09-12 自愈行为零回归）', () => {
    expect(withinRetryBudget(stall, 10, 60_000)).toBe(true);
    expect(withinRetryBudget(stall, 10, STALL_RETRY_BUDGET_MS)).toBe(false);
  });
});

// ── 粘贴判据（真机失灵：资源管理器复制来的图 type 为空串）──

describe('extractImageFiles 判据（2026-09-22 真机失灵）', () => {
  function item(kind: string, name: string, type: string) {
    return { kind, getAsFile: () => new File(['x'], name, { type }) };
  }

  it('type 为空串但名字是图 → 收（真守门人是下游 magic-byte 嗅探）', () => {
    const files = extractImageFiles([item('file', '4e16acd.png', '')]);
    expect(files).toHaveLength(1);
  });

  it('type 是图 → 收（原判据保留）', () => {
    expect(extractImageFiles([item('file', 'x.png', 'image/png')])).toHaveLength(1);
  });

  it('非图名 + 非图 type → 不收（纯文本粘贴零影响）', () => {
    expect(extractImageFiles([item('file', 'a.pdf', 'application/pdf')])).toHaveLength(0);
    expect(extractImageFiles([item('string', 'a.png', '')])).toHaveLength(0);
  });
});
