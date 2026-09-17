// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper 内核无头测试 — 走查弹三层（块模型/画布数学/转译）纯逻辑对拍。
// vitest jsdom 环境下不触 DOM——本套只测数学与映射。

import { describe, expect, it } from 'vitest';
import {
  createBlock,
  DEFAULT_BLOCK_WIDTH,
  movePinned,
  pinBlock,
  resetBlockIdCounterForTests,
  unpinBlock,
  writingBlockIdOf,
} from '../src/paper/block-model';
import {
  ANCHOR,
  AUTO_PAN_MAX_SPEED,
  autoPanVector,
  identityView,
  layoutFlow,
  nextZoomStep,
  panBy,
  screenToWorld,
  wheelFactor,
  worldToScreen,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
} from '../src/paper/canvas-math';
import {
  splitFencedSegments,
  translateMessages,
  translateMessagesCached,
  USER_BLOCK_WIDTH,
} from '../src/paper/translate';
import type { AssistantMessage, ChatMessage, UserMessage } from '../src/ui/message-model';

/* ── 测试数据构造（真实 message-model 形状，非 mock 接口——数据是本地产物） ── */

function userMsg(id: string, text: string): UserMessage {
  return { role: 'user', _id: id, text, sessionIndex: 0 };
}

function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}

/* ═══ 块模型 ═══ */

describe('paper/block-model', () => {
  it('createBlock 默认 flow（D-R1-2）', () => {
    resetBlockIdCounterForTests();
    const b = createBlock('markdown', { text: 'hi' }, { messageId: 'm1', part: null });
    expect(b.state).toBe('flow');
    expect(b.w).toBe(DEFAULT_BLOCK_WIDTH);
  });

  it('pinBlock/unpinBlock 状态与坐标往返', () => {
    resetBlockIdCounterForTests();
    const b = createBlock('markdown', { text: 'x' }, { messageId: 'm1', part: null });
    const p = pinBlock(b, 120, -340);
    expect(p.state).toBe('pinned');
    expect(p.x).toBe(120);
    expect(p.y).toBe(-340);
    // 幂等：同坐标再 pin 返回同一引用
    expect(pinBlock(p, 120, -340)).toBe(p);
    const back = unpinBlock(p);
    expect(back.state).toBe('flow');
    // flow 再 unpin 幂等
    expect(unpinBlock(back)).toBe(back);
  });

  it('movePinned 只改坐标不改状态', () => {
    resetBlockIdCounterForTests();
    const b = pinBlock(createBlock('user', { text: 'a' }, { messageId: 'm1', part: null }), 0, 0);
    const m = movePinned(b, 5, 5);
    expect(m.x).toBe(5);
    expect(m.state).toBe('pinned');
  });

  it('块 id 单调唯一', () => {
    resetBlockIdCounterForTests();
    const a = createBlock('notice', { text: '', level: 'info' }, { messageId: 'm', part: null });
    const b = createBlock('notice', { text: '', level: 'info' }, { messageId: 'm', part: null });
    expect(a.id).not.toBe(b.id);
  });

  /* ── 湿墨判定（2026-09-06 纸面运行态）：writingBlockIdOf ── */

  it('writingBlockIdOf：取最末未干墨块（finalised===false 的 part 源）', () => {
    resetBlockIdCounterForTests();
    const dry = { type: 'text' as const, text: '已写完', finalised: true };
    const wet = { type: 'text' as const, text: '正在写', finalised: false };
    const blocks = [
      createBlock('markdown', { text: '来文背景' }, { messageId: 'm', part: null }),
      createBlock('markdown', { text: dry.text }, { messageId: 'm', part: dry }),
      createBlock('markdown', { text: wet.text }, { messageId: 'm', part: wet }),
    ];
    expect(writingBlockIdOf(blocks)).toBe(blocks[2].id);
  });

  it('writingBlockIdOf：未干墨 part 在前、后续有干块 → 仍指向它（书写头不因后继失位）', () => {
    resetBlockIdCounterForTests();
    const wet = { type: 'text' as const, text: '流式中', finalised: false };
    const toolPart = {
      type: 'tool' as const,
      toolId: 't',
      name: 'fs',
      label: 'fs',
      args: '{}',
      readOnly: false,
      status: 'running' as const,
    };
    const blocks = [
      createBlock('markdown', { text: wet.text }, { messageId: 'm', part: wet }),
      createBlock(
        'tool',
        { toolId: 't', name: 'fs', label: 'fs', args: '{}', status: 'running' },
        { messageId: 'm', part: toolPart },
      ),
    ];
    expect(writingBlockIdOf(blocks)).toBe(blocks[0].id);
  });

  it('writingBlockIdOf：全干/空集 → null', () => {
    resetBlockIdCounterForTests();
    const dry = { type: 'text' as const, text: 'a', finalised: true };
    expect(writingBlockIdOf([])).toBeNull();
    expect(writingBlockIdOf([createBlock('markdown', { text: 'a' }, { messageId: 'm', part: dry })])).toBeNull();
    // part 为 null 的块（user/notice）不误判
    expect(writingBlockIdOf([createBlock('user', { text: '问' }, { messageId: 'm', part: null })])).toBeNull();
  });
});

/* ═══ 画布数学 ═══ */

describe('paper/canvas-math', () => {
  it('world↔screen 互逆', () => {
    const v = { panX: 100, panY: 200, zoom: 1.5 };
    const s = worldToScreen(v, 40, -60);
    const w = screenToWorld(v, s.x, s.y);
    expect(w.x).toBeCloseTo(40);
    expect(w.y).toBeCloseTo(-60);
  });

  it('zoomAt 以光标为锚（锚点屏幕坐标不变）', () => {
    const v = identityView();
    const at = { x: 300, y: 200 };
    const z = zoomAt(v, at.x, at.y, 1.25);
    const s = worldToScreen(
      z,
      ...(() => {
        const w = screenToWorld(v, at.x, at.y);
        return [w.x, w.y];
      })(),
    );
    expect(s.x).toBeCloseTo(at.x);
    expect(s.y).toBeCloseTo(at.y);
  });

  it('zoomAt 夹在 [ZOOM_MIN, ZOOM_MAX]（无限画布但有缩放护栏）', () => {
    let v = identityView();
    for (let i = 0; i < 50; i++) v = zoomAt(v, 0, 0, 1.3);
    expect(v.zoom).toBeLessThanOrEqual(ZOOM_MAX);
    for (let i = 0; i < 50; i++) v = zoomAt(v, 0, 0, 0.5);
    expect(v.zoom).toBeGreaterThanOrEqual(ZOOM_MIN);
  });

  it('wheelFactor：deltaY 正 → 缩小', () => {
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
  });

  it('panBy 纯位移', () => {
    const v = panBy(identityView(), 10, -20);
    expect(v.panX).toBe(10);
    expect(v.panY).toBe(-20);
  });

  it('autoPanVector（拖选自动滚屏，2026-09-07）：带外零速 / 带内线性爬坡 / 越界封顶 1.5× / 方向对画布四缘', () => {
    // 视口中心：带外零速
    const mid = autoPanVector(600, 400, 1200, 800);
    expect(mid.dx).toBe(0);
    expect(mid.dy).toBe(0);
    // 贴下缘（入带 16px）：向下追内容（panY 减小）——线性爬坡 16/36 × 26
    const bottom = autoPanVector(600, 780, 1200, 800);
    expect(bottom.dy).toBeCloseTo(-AUTO_PAN_MAX_SPEED * (16 / 36));
    expect(bottom.dx).toBe(0);
    // 贴上缘：向上追（panY 增大）
    const top = autoPanVector(600, 20, 1200, 800);
    expect(top.dy).toBeCloseTo(AUTO_PAN_MAX_SPEED * (16 / 36));
    // 贴左缘：panX 增大；贴右缘：panX 减小
    expect(autoPanVector(20, 400, 1200, 800).dx).toBeCloseTo(AUTO_PAN_MAX_SPEED * (16 / 36));
    expect(autoPanVector(1180, 400, 1200, 800).dx).toBeCloseTo(-AUTO_PAN_MAX_SPEED * (16 / 36));
    // 正好在缘线上（深度 = 全带）：满速
    expect(autoPanVector(600, 800, 1200, 800).dy).toBeCloseTo(-AUTO_PAN_MAX_SPEED);
    // 越出画布：封顶 1.5×
    expect(autoPanVector(600, 900, 1200, 800).dy).toBeCloseTo(-AUTO_PAN_MAX_SPEED * 1.5);
    // 双带重叠（画布窄于 2×带宽）取深侧不互抵：pos 10/40 贴左带更深（26 vs 6）
    const tiny = autoPanVector(10, 400, 40, 800);
    expect(tiny.dx).toBeCloseTo(AUTO_PAN_MAX_SPEED * (26 / 36));
  });

  it('nextZoomStep（缩放阶梯，2026-09-08）：档位迈步 / 档间取该方向下一档 / 端点夹持', () => {
    // 档上迈步：1 → 上 1.5 / 下 0.75
    expect(nextZoomStep(1, 1)).toBe(1.5);
    expect(nextZoomStep(1, -1)).toBe(0.75);
    // 档间值迈步 = 取该方向的下一档（上调恒升、下调恒降——0.8 上调 → 1，下调 → 0.75）
    expect(nextZoomStep(0.8, 1)).toBe(1);
    expect(nextZoomStep(0.8, -1)).toBe(0.75);
    expect(nextZoomStep(1.2, 1)).toBe(1.5);
    expect(nextZoomStep(1.2, -1)).toBe(1);
    // 端点夹持：顶上调不动（2.4），底下调不动（0.35）
    expect(nextZoomStep(2.4, 1)).toBe(ZOOM_MAX);
    expect(nextZoomStep(0.35, -1)).toBe(ZOOM_MIN);
    // 越出端点的极端值：仍夹回端点
    expect(nextZoomStep(5, 1)).toBe(ZOOM_MAX);
    expect(nextZoomStep(0.1, -1)).toBe(ZOOM_MIN);
  });

  it('layoutFlow：最新块底边贴锚点（y=0），流向上生长（D-R1-3）', () => {
    const laid = layoutFlow([
      { id: 'old', h: 100 },
      { id: 'mid', h: 80 },
      { id: 'new', h: 60 },
    ]);
    // 最新块底边 = 0
    expect(laid.get('new')?.y).toBe(-60);
    // 中块底边 = 新块顶 - gap
    expect(laid.get('mid')?.y).toBe(-60 - ANCHOR.blockGap - 80);
    // 最旧块再往上
    expect(laid.get('old')?.y).toBe(-60 - ANCHOR.blockGap - 80 - ANCHOR.blockGap - 100);
    // 所有块居中窄带：块中心 x = 0
    for (const p of laid.values()) expect(p.x).toBe(-360); // 默认宽 720
  });

  it('layoutFlow：单块高 NaN → 按 0 兜底不级联（「从坏点起全乱」的防御）', () => {
    // 回归：坏块（h=NaN）在中间，上方旧块必须仍拿到有限坐标
    const laid = layoutFlow([
      { id: 'old', h: 100 },
      { id: 'bad', h: Number.NaN }, // 测量异常的来文块
      { id: 'mid', h: 80 },
      { id: 'new', h: 60 },
    ]);
    const ys = ['old', 'bad', 'mid', 'new'].map((id) => laid.get(id)?.y);
    for (const y of ys) expect(Number.isFinite(y)).toBe(true);
    // 坏块按 0 高：mid 底边 = new 顶 - gap，bad 落在 mid 顶 - gap，old 再往上
    expect(laid.get('bad')?.y).toBe(laid.get('mid')!.y - ANCHOR.blockGap);
    // 坏块宽也兜底默认 720（x 不 NaN）
    for (const p of laid.values()) expect(Number.isFinite(p.x)).toBe(true);
  });

  it('layoutFlow：块宽 NaN → 兜底默认宽（x 不污染）', () => {
    const laid = layoutFlow([
      { id: 'a', h: 50, w: Number.NaN },
      { id: 'b', h: 50, w: 720 },
    ]);
    expect(laid.get('a')?.x).toBe(-360); // 默认宽 720
    expect(laid.get('b')?.x).toBe(-360);
  });
});

/* ═══ 转译层 ═══ */

describe('paper/translate', () => {
  it('user/notice 消息 1:1 转译；user 块窄', () => {
    resetBlockIdCounterForTests();
    const msgs: ChatMessage[] = [userMsg('u1', '修个 bug'), { role: 'notice', _id: 'n1', text: '提示', level: 'info' }];
    const blocks = translateMessages(msgs);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('user');
    expect(blocks[0].payload).toEqual({ text: '修个 bug' });
    expect(blocks[0].w).toBe(USER_BLOCK_WIDTH);
    expect(blocks[0].id).toBe('pb:u1');
    expect(blocks[1].kind).toBe('notice');
  });

  it('assistant parts 顺序映射为块序列（含 tool 状态直映）', () => {
    resetBlockIdCounterForTests();
    const msgs: ChatMessage[] = [
      asstMsg('a1', [
        { type: 'text', text: '开头', finalised: true },
        {
          type: 'tool',
          toolId: 't1',
          name: 'read_file_content',
          label: '读文件',
          args: '{}',
          readOnly: true,
          status: 'done',
          output: 'abc',
        },
        { type: 'text', text: '结尾', finalised: true },
      ]),
    ];
    const blocks = translateMessages(msgs);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'tool', 'markdown']);
    const tool = blocks[1];
    expect(tool.payload).toMatchObject({ name: 'read_file_content', status: 'done', output: 'abc' });
    // 稳定 id：消息 id + part 序号
    expect(blocks[0].id).toBe('pb:a1:0');
    expect(tool.id).toBe('pb:a1:1');
    // 活引用：source.part 是原 part 对象
    expect(tool.source.part).toBe(msgs[0].parts[1]);
  });

  it('tool/code 块透传 startedAt（行走秒计时源，2026-09-06 纸面运行态）', () => {
    resetBlockIdCounterForTests();
    const stamp = 1_757_000_000_000;
    const msgs: ChatMessage[] = [
      asstMsg('a1', [
        {
          type: 'tool',
          toolId: 't1',
          name: 'fs',
          label: '读文件',
          args: '{}',
          readOnly: true,
          status: 'running',
          startedAt: stamp,
        },
        {
          type: 'tool',
          toolId: 'c1',
          name: 'code_execution',
          label: '跑程序',
          args: '{"code":"1+1"}',
          readOnly: false,
          status: 'running',
          startedAt: stamp,
        },
        {
          type: 'tool',
          toolId: 't2',
          name: 'fs',
          label: '历史卡',
          args: '{}',
          readOnly: true,
          status: 'running',
        },
      ]),
    ];
    const blocks = translateMessages(msgs);
    expect(blocks.map((b) => b.kind)).toEqual(['tool', 'code', 'tool']);
    expect((blocks[0].payload as { startedAt?: number }).startedAt).toBe(stamp);
    expect((blocks[1].payload as { startedAt?: number }).startedAt).toBe(stamp);
    // 无 startedAt（历史卡）不造字段——渲染层降级为纯「行」
    expect('startedAt' in blocks[2].payload).toBe(false);
  });

  it('subagent parts 组内折叠（F4 2026-09-01）：组头 + 子块，不再摊平正文流', () => {
    resetBlockIdCounterForTests();
    const subPart = { type: 'text' as const, text: '子产出', finalised: true };
    const msgs: ChatMessage[] = [
      asstMsg('a1', [
        { type: 'subagent', agentId: 'sub-1', description: '调研', status: 'done', parts: [subPart], version: 1 },
      ]),
    ];
    const blocks = translateMessages(msgs);
    expect(blocks.map((b) => b.kind)).toEqual(['subagent', 'markdown']);
    // 组头：id 锚 part 序号（g 尾缀），活引用 items，宽同工具组头族
    const header = blocks[0];
    expect(header.id).toBe('pb:a1:0g');
    expect(header.w).toBe(640);
    expect(header.source.messageId).toBe('a1');
    expect(header.source.part).toBe(msgs[0].parts[0]);
    const hp = header.payload as { agentId: string; description: string; status: string; childIds: string[] };
    expect(hp.agentId).toBe('sub-1');
    expect(hp.description).toBe('调研');
    expect(hp.status).toBe('done');
    expect(hp.childIds).toEqual(['pb:a1:0s0']);
    // 子块：id 带子前缀不撞父消息，内容直映
    expect(blocks[1].id).toBe('pb:a1:0s0');
    expect(blocks[1].payload).toEqual({ text: '子产出' });
  });

  it('重转译按稳定 id 续命钉住态（活引用 D-R2-3）', () => {
    resetBlockIdCounterForTests();
    const msgs: ChatMessage[] = [asstMsg('a1', [{ type: 'text', text: 'v1', finalised: true }])];
    const first = translateMessages(msgs);
    // 用户钉住了这个块
    const pinned = new Map([[first[0].id, { x: 500, y: -300 }]]);
    // 消息更新（文本变长）后重转译
    const msgs2: ChatMessage[] = [asstMsg('a1', [{ type: 'text', text: 'v1（已更新很长）', finalised: true }])];
    const second = translateMessages(msgs2, { pinnedPositions: pinned });
    expect(second[0].id).toBe(first[0].id); // 稳定 id
    expect(second[0].state).toBe('pinned'); // 续命
    expect(second[0].x).toBe(500);
    expect(second[0].payload).toEqual({ text: 'v1（已更新很长）' }); // 内容取新（活引用）
  });

  it('空消息流 → 空块集', () => {
    expect(translateMessages([])).toEqual([]);
  });

  it('围栏拆分：text part 含 ```diff 围栏 → markdown/diff 块序列（走查弹定义三件套补全）', () => {
    resetBlockIdCounterForTests();
    const msgs: ChatMessage[] = [
      asstMsg('a1', [
        {
          type: 'text',
          finalised: true,
          text: '修复如下：\n\n```diff\n- old line\n+ new line\n```\n\n已跑测试。',
        },
      ]),
    ];
    const blocks = translateMessages(msgs);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'diff', 'markdown']);
    expect(blocks[1].payload).toEqual({ lang: 'diff', text: '- old line\n+ new line' });
    // 拆分 id 稳定方案
    expect(blocks[0].id).toBe('pb:a1:0t0');
    expect(blocks[1].id).toBe('pb:a1:0f0');
    expect(blocks[2].id).toBe('pb:a1:0t1');
    // 活引用：同源 part
    expect(blocks[1].source.part).toBe(msgs[0].parts[0]);
  });

  it('围栏拆分·流式生长：围栏未闭合（token 还在到达）照样产出 diff 块', () => {
    const segs = splitFencedSegments('正在生成 diff：\n```diff\n+ 第一行');
    expect(segs.map((s) => s.kind)).toEqual(['markdown', 'diff']);
    expect(segs[1].text).toBe('+ 第一行');
    // 闭合后内容不变（幂等）
    const segs2 = splitFencedSegments('正在生成 diff：\n```diff\n+ 第一行\n```\n');
    expect(segs2.map((s) => s.kind)).toEqual(['markdown', 'diff']);
    expect(segs2[1].text).toBe('+ 第一行');
  });

  it('围栏拆分·纯文本保持 1:1 兼容（无围栏时 id 不变）', () => {
    resetBlockIdCounterForTests();
    const msgs: ChatMessage[] = [asstMsg('a1', [{ type: 'text', text: '普通文本', finalised: true }])];
    const blocks = translateMessages(msgs);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('markdown');
    expect(blocks[0].id).toBe('pb:a1:0');
  });

  it('围栏拆分·流式中 diff 追加：块 id 稳定、diff 内容取新', () => {
    resetBlockIdCounterForTests();
    const part = { type: 'text' as const, finalised: false, text: '看这个改动：\n```diff\n+ first' };
    const msg = asstMsg('a1', [part]);
    const first = translateMessages([msg]);
    expect(first.map((b) => b.kind)).toEqual(['markdown', 'diff']);
    // 流式追加 diff 行
    part.text += '\n+ second\n```\n\n完成。';
    const second = translateMessages([msg]);
    expect(second.map((b) => b.kind)).toEqual(['markdown', 'diff', 'markdown']);
    expect(second[1].id).toBe(first[1].id); // diff 块 id 稳定
    expect(second[1].payload).toEqual({ lang: 'diff', text: '+ first\n+ second' });
    expect(second[2].payload).toEqual({ text: '完成。' });
  });

  it('围栏语言标记直映（```ts → lang=ts）', () => {
    const segs = splitFencedSegments('```ts\nconst a = 1;\n```');
    expect(segs).toEqual([{ kind: 'diff', text: 'const a = 1;', lang: 'ts' }]);
  });

  it('流式更新语义：part.text 原位追加后重转译，块 id 稳定、内容取新、钉住不丢（touchMessage 场景）', () => {
    resetBlockIdCounterForTests();
    // 首帧：流式中的 assistant（text part 正在追加）
    const part = { type: 'text' as const, text: '正在生成', finalised: false };
    const msg = asstMsg('a1', [part]);
    const first = translateMessages([msg]);
    expect(first).toHaveLength(1);
    expect(first[0].payload).toEqual({ text: '正在生成' });

    // 用户在流式中钉住了这个块
    const pinned = new Map([[first[0].id, { x: 300, y: -200 }]]);

    // 流式追加（messages-store 的 in-place 语义：part.text += chunk，messages 引用不变）
    part.text += '……很长的第二段内容，模拟 token 逐个到达';
    const second = translateMessages([msg], { pinnedPositions: pinned });

    // 块 id 稳定（React key 不变，DOM 原地更新）
    expect(second[0].id).toBe(first[0].id);
    // 内容取新（活引用：读的是同一 part 对象）
    expect(second[0].payload).toEqual({ text: part.text });
    // 钉住续命
    expect(second[0].state).toBe('pinned');
    expect(second[0].x).toBe(300);
    // 源引用同一 part
    expect(second[0].source.part).toBe(part);
  });

  it('流式中新增 part（工具调用插入）：块序列自然增长，既有块 id 不变', () => {
    resetBlockIdCounterForTests();
    const t1 = { type: 'text' as const, text: '先读文件', finalised: true };
    const msg = asstMsg('a1', [t1]);
    const first = translateMessages([msg]);
    expect(first.map((b) => b.kind)).toEqual(['markdown']);

    // 流式中插入 tool part（真实时序：text → tool → text）
    msg.parts.push({
      type: 'tool',
      toolId: 't1',
      name: 'read_file_content',
      label: '读文件',
      args: '{}',
      readOnly: true,
      status: 'running',
    });
    const second = translateMessages([msg]);
    expect(second.map((b) => b.kind)).toEqual(['markdown', 'tool']);
    // 既有块 id 稳定
    expect(second[0].id).toBe(first[0].id);
    // running 状态直映
    expect(second[1].payload).toMatchObject({ status: 'running' });

    // 工具完成（原位变更 status/output）
    const toolPart = msg.parts[1] as { status: string; output: string };
    toolPart.status = 'done';
    toolPart.output = 'ok';
    const third = translateMessages([msg]);
    expect(third[1].payload).toMatchObject({ status: 'done', output: 'ok' });
  });
});

/* ═══ 增量转译缓存（性能专项第一刀：流式全量重算 → 只重译被触碰的消息）═══ */

describe('paper/translate 增量缓存', () => {
  it('未变消息块对象引用稳定（流式只重建被触碰消息的块）', () => {
    resetBlockIdCounterForTests();
    const pinned: Record<string, { x: number; y: number }> = {};
    const m1 = userMsg('u1', '稳定用户消息');
    const part = { type: 'text' as const, text: 'v1', finalised: false };
    const m2 = asstMsg('a1', [part]);
    const first = translateMessagesCached([m1, m2], pinned, null);
    // 触碰 m2（touchMessage 语义：浅拷贝该消息，引用变）
    part.text = 'v1……流式变长';
    const m2Touched = { ...m2 };
    const second = translateMessagesCached([m1, m2Touched], pinned, first.cache);
    expect(second.blocks).toHaveLength(2);
    expect(second.blocks[0]).toBe(first.blocks[0]); // m1 块复用同一对象
    expect(second.blocks[1]).not.toBe(first.blocks[1]); // m2 块重建
    expect(second.blocks[1].payload).toEqual({ text: 'v1……流式变长' });
  });

  it('钉住表引用变化 → 缓存全量失效重建', () => {
    resetBlockIdCounterForTests();
    const m = asstMsg('a1', [{ type: 'text', text: 'x', finalised: true }]);
    const pinned1: Record<string, { x: number; y: number }> = {};
    const first = translateMessagesCached([m], pinned1, null);
    const pinned2: Record<string, { x: number; y: number }> = { [first.blocks[0].id]: { x: 1, y: 2 } };
    const second = translateMessagesCached([m], pinned2, first.cache);
    expect(second.blocks[0]).not.toBe(first.blocks[0]);
    expect(second.blocks[0].state).toBe('pinned');
    expect(second.blocks[0].x).toBe(1);
  });

  it('新增消息走缓存补录，既有块引用不动', () => {
    resetBlockIdCounterForTests();
    const pinned: Record<string, { x: number; y: number }> = {};
    const m1 = asstMsg('a1', [{ type: 'text', text: 'old', finalised: true }]);
    const first = translateMessagesCached([m1], pinned, null);
    const m2 = asstMsg('a2', [{ type: 'text', text: 'new', finalised: true }]);
    const second = translateMessagesCached([m1, m2], pinned, first.cache);
    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(second.blocks[1].payload).toEqual({ text: 'new' });
  });

  it('消息数组整体换新引用（会话切换/磁盘恢复）→ 全部重译且缓存不脏', () => {
    resetBlockIdCounterForTests();
    const pinned: Record<string, { x: number; y: number }> = {};
    const m1a = asstMsg('a1', [{ type: 'text', text: 'old', finalised: true }]);
    const first = translateMessagesCached([m1a], pinned, null);
    const m1b = asstMsg('a1', [{ type: 'text', text: 'new', finalised: true }]);
    const second = translateMessagesCached([m1b], pinned, first.cache);
    expect(second.blocks[0]).not.toBe(first.blocks[0]);
    expect(second.blocks[0].payload).toEqual({ text: 'new' });
  });
});
