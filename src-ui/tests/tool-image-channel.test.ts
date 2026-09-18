// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具附图通道 P0a（docs/plans/tool-image-context-plan.md）——三段守护：
//   ① 解析真源 parseToolImageOutput（形状/白名单/去重/畸形丢弃，不抛）；
//   ② executor 挂载（imageChannel 门控；旗标按 guardName 归实现工具，域门面路径同效）；
//   ③ 请求期角色泛化（collect/budget/project 对 tool 角色带图与 user 同口径）。

import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';
import { hasImageRefs, parseToolImageOutput } from '../src/agent/tool-images';

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

function refJson(id = SHA, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    path: 'C:/tmp/shots/shot-1.png',
    bytes: 1234,
    image: { id, mediaType: 'image/png', bytes: 1234, width: 720, height: 240, ...extra },
  });
}

/** fs(read) 附图信封（Rust 侧读图输出形状——无 content 键）。 */
function fsImageEnvelope(): string {
  return JSON.stringify({
    path: 'D:/proj/src/pic.png',
    image: { id: SHA, mediaType: 'image/png', bytes: 4321, width: 640, height: 480, name: 'pic.png' },
    attachment: `D:/proj/.lantai/attachments/${SHA}.png`,
    imageNote: '本图已作为附图进入上下文：视觉模型可直接观察（纯文本模型只看到本占位说明）。',
  });
}

describe('parseToolImageOutput — 解析单一真源', () => {
  it('单张 image 引用 → 一条 ChatImageRef（字段逐项映射）', () => {
    const refs = parseToolImageOutput(refJson());
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      id: SHA,
      mediaType: 'image/png',
      bytes: 1234,
      width: 720,
      height: 240,
    });
  });

  it('images 数组形态 + 名字剥路径分隔符', () => {
    const out = JSON.stringify({
      images: [{ id: SHA, mediaType: 'image/jpeg', bytes: 5, width: 10, height: 20, name: 'shots\\a.png' }],
    });
    const refs = parseToolImageOutput(out);
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('a.png');
  });

  it('同 id 去重（内容寻址：同图只送一次）', () => {
    const out = JSON.stringify({
      image: { id: SHA, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      images: [{ id: SHA, mediaType: 'image/png', bytes: 1, width: 1, height: 1 }],
    });
    expect(parseToolImageOutput(out)).toHaveLength(1);
  });

  it('畸形逐条丢弃但不抛：非 JSON / 非对象 / id 非 sha256 / 媒型越界 / 尺寸非正', () => {
    expect(parseToolImageOutput('not json')).toEqual([]);
    expect(parseToolImageOutput('[]')).toEqual([]);
    expect(parseToolImageOutput(JSON.stringify({ image: { id: 'img-a', mediaType: 'image/png' } }))).toEqual([]);
    expect(parseToolImageOutput(refJson(SHA, { mediaType: 'image/bmp' }))).toEqual([]);
    expect(parseToolImageOutput(refJson(SHA, { width: 0 }))).toEqual([]);
    expect(parseToolImageOutput(refJson('A'.repeat(63)))).toEqual([]);
    expect(parseToolImageOutput('')).toEqual([]);
  });

  it('无 image 键的普通工具输出 → 空（截图族以外零影响）', () => {
    expect(parseToolImageOutput(JSON.stringify({ path: 'x', bytes: 1 }))).toEqual([]);
  });

  it('大写 sha 归一为小写（内容寻址口径统一）', () => {
    const refs = parseToolImageOutput(refJson(SHA.toUpperCase()));
    expect(refs[0]?.id).toBe(SHA);
  });
});

describe('executor — 工具附图挂载', () => {
  function toolWith(flag: boolean, output: string): Tool {
    return {
      name: () => (flag ? 'shot_tool' : 'plain_tool'),
      description: () => 't',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      ...(flag ? { imageChannel: true } : {}),
      execute: async () => output,
    };
  }

  it('imageChannel 工具 → PendingResult.images 带上引用（未截断原文解析）', async () => {
    const { StreamingToolExecutor } = await import('../src/agent/streaming-executor');
    const registry = new ToolRegistry();
    registry.register(toolWith(true, refJson()));
    const ex = new StreamingToolExecutor(registry, () => {});
    ex.addTool({ id: 'c1', name: 'shot_tool', arguments: '{}' });
    const [result] = await ex.awaitRemaining();
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0].id).toBe(SHA);
  });

  it('未声明 imageChannel 的工具 → 同样输出也不挂图（门控有效）', async () => {
    const { StreamingToolExecutor } = await import('../src/agent/streaming-executor');
    const registry = new ToolRegistry();
    registry.register(toolWith(false, refJson()));
    const ex = new StreamingToolExecutor(registry, () => {});
    ex.addTool({ id: 'c1', name: 'plain_tool', arguments: '{}' });
    const [result] = await ex.awaitRemaining();
    expect(result.images).toBeUndefined();
  });

  it('域门面路径：旗标按 guardName 归实现工具（截图子工具）', async () => {
    const { StreamingToolExecutor } = await import('../src/agent/streaming-executor');
    const domains = await import('../src/agent/tools/domains');
    // 造一个真域门面：browser(action:"screenshot") → browser_screenshot
    const registry = new ToolRegistry();
    const legacy: Tool = {
      name: () => 'browser_screenshot',
      description: () => 'shot',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      imageChannel: true,
      execute: async () => refJson(),
    };
    registry.register(legacy);
    domains.convergeRegistry(registry);
    const facade = registry.get('browser');
    expect(facade).toBeDefined();
    // 隐藏旧名后模型只能走门面（真实运行形态）
    registry.hide('browser_screenshot');
    const ex = new StreamingToolExecutor(registry, () => {});
    ex.addTool({ id: 'c2', name: 'browser', arguments: JSON.stringify({ action: 'screenshot' }) });
    const [result] = await ex.awaitRemaining();
    expect(result.images).toHaveLength(1);
  });
});

describe('request-images — tool 角色与 user 同口径', () => {
  const TOOL_REF = { id: SHA, mediaType: 'image/png' as const, bytes: 10, width: 8, height: 9 };
  const USER_REF = { id: SHA2, mediaType: 'image/png' as const, bytes: 11, width: 8, height: 9 };

  it('collectImageRefs 收集 tool 角色引用（消息序）', async () => {
    const { collectImageRefs } = await import('../src/agent/request-images');
    const msgs = [
      { role: 'user' as const, content: 'hi', images: [USER_REF] },
      { role: 'tool' as const, content: 'shot', tool_call_id: 'c1', images: [TOOL_REF] },
    ];
    expect(collectImageRefs(msgs).map((r) => r.id)).toEqual([SHA2, SHA]);
  });

  it('文本模型投影：tool 角色带图也换占位文本（不报错）', async () => {
    const { projectImagesForTextModel } = await import('../src/agent/request-images');
    const out = projectImagesForTextModel([
      { role: 'tool' as const, content: 'shot', tool_call_id: 'c1', images: [TOOL_REF] },
    ]);
    expect(out[0].images).toBeUndefined();
    expect(out[0].content).toContain('当前模型不支持图片输入');
  });

  it('请求级预算：工具附图与用户附图共用一份预算（最旧先弃）', async () => {
    const { applyImageBudget } = await import('../src/agent/request-images');
    const out = applyImageBudget(
      [
        { role: 'user' as const, content: 'hi', images: [USER_REF] },
        { role: 'tool' as const, content: 'shot', tool_call_id: 'c1', images: [TOOL_REF] },
      ],
      { maxImages: 1, maxBytes: 1_000_000 },
    );
    // 保新弃旧：tool 侧（较新）留下，user 侧换占位
    expect(out[1].images?.map((r) => r.id)).toEqual([SHA]);
    expect(out[0].images).toBeUndefined();
    expect(out[0].content).toContain('超出请求预算');
  });
});

// ── fs(read) 附图信封 — 按路径读图（2026-09-18）───────────────────────
// 模型 fs(read) 一张图片 → Rust 嗅探字节 → 落内容寻址附件 → 输出带 image 引用；
// 本节钉两端接线：① 包装层（[file:] 焦点回显）放行信封，不把机器可读 JSON 拼坏；
// ② executor 域门面路径（fs → read_file_content）挂图与旗标归位。
describe('fs(read) 附图信封 — 按路径读图', () => {
  it('hasImageRefs：识别信封，普通文本/文本 read JSON 不误报', () => {
    expect(hasImageRefs(fsImageEnvelope())).toBe(true);
    expect(hasImageRefs('plain text')).toBe(false);
    expect(hasImageRefs(JSON.stringify({ path: 'x.ts', content: 'const a = 1;' }))).toBe(false);
  });

  it('fs 域门面：信封不加 [file:] 尾巴（原样返回），焦点照设', async () => {
    const { ownerContext, registerOwnerContext } = await import('../src/agent/session-context');
    const domains = await import('../src/agent/tools/domains');
    registerOwnerContext('owner-img', 'D:\\proj');
    const registry = new ToolRegistry();
    const envelope = fsImageEnvelope();
    const read: Tool = {
      name: () => 'read_file_content',
      description: () => 'read',
      parameters: () => ({ type: 'object', properties: { filePath: { type: 'string' } } }),
      readOnly: () => true,
      imageChannel: true,
      execute: async () => envelope,
    };
    registry.register(read);
    domains.convergeRegistry(registry);
    const fs = registry.get('fs');
    const out = await fs?.execute({ action: 'read', path: 'src/pic.png', _owner_id: 'owner-img' });
    expect(out).toBe(envelope);
    expect(ownerContext('owner-img')?.focusPath).toBe('D:\\proj\\src\\pic.png');
  });

  it('executor 域门面路径：fs(read) 信封 → 工具结果挂图（旗标归 read_file_content）', async () => {
    const { registerOwnerContext } = await import('../src/agent/session-context');
    const { StreamingToolExecutor } = await import('../src/agent/streaming-executor');
    const domains = await import('../src/agent/tools/domains');
    registerOwnerContext('owner-img2', 'D:\\proj');
    const registry = new ToolRegistry();
    const envelope = fsImageEnvelope();
    const read: Tool = {
      name: () => 'read_file_content',
      description: () => 'read',
      parameters: () => ({ type: 'object', properties: { filePath: { type: 'string' } } }),
      readOnly: () => true,
      imageChannel: true,
      execute: async () => envelope,
    };
    registry.register(read);
    domains.convergeRegistry(registry);
    registry.hide('read_file_content'); // 真实运行形态：旧名隐藏，模型只能走门面
    const ex = new StreamingToolExecutor(registry, () => {}, null, null, null, 'owner-img2');
    ex.addTool({ id: 'c-fs-img', name: 'fs', arguments: JSON.stringify({ action: 'read', path: 'src/pic.png' }) });
    const [result] = await ex.awaitRemaining();
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0].id).toBe(SHA);
    // 尾缀未加：解析面完整（信封原样进消息）
    expect(result.output).toBe(envelope);
  });
});
