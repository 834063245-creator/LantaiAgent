// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Stage-3 画布导航：纯函数（合流/相对时间/落位判据/定位视口）+ 插件面板贡献。
// 覆盖验收「侧边栏/书脊以贡献行注册、消费 ctx.space 对拍」。

import { describe, expect, it } from 'vitest';
import { panelDefs } from '../src/app/panels/panel-def';
import { compositionServicesPlugin } from '../src/composition/services';
import { spaceServicePlugin } from '../src/composition/space-service';
import { Context } from '../src/cordis';
import { identityView, viewFocusRegion, viewportCenterWorld } from '../src/paper/canvas-math';
import { pickDropAnchor } from '../src/paper/space';
import { canvasNavPlugin } from '../src/plugins/builtin/canvas-nav';
import {
  bucketClosed,
  CLOSED_BUCKET_LABEL,
  closedBucket,
  filterRows,
  mergeSessionRows,
  relativeTime,
  type SessionStatus,
  type SidebarRow,
  sessionMeta,
  splitSections,
  statusLabel,
} from '../src/plugins/builtin/canvas-nav/session-sidebar-model';
import { useDockStore } from '../src/state/dock-store';

async function bootCanvasNav() {
  const root = new Context();
  const f1 = root.plugin(compositionServicesPlugin);
  await f1;
  const f2 = root.plugin(spaceServicePlugin);
  await f2;
  const f3 = root.plugin(canvasNavPlugin);
  await f3;
  return { root, f1, f2, f3 };
}

describe('session-sidebar-model（DSH 合流）', () => {
  it('mergeSessionRows：未摊开磁盘卷为底，摊开会话覆盖 label；摊开优先排序', () => {
    const rows = mergeSessionRows(
      [
        { id: 2, label: '内存新名', msgCount: 3 },
        { id: 5, label: '', msgCount: 0 },
      ],
      [
        { id: 1, label: '盘卷甲', msgCount: 8, savedAt: '2026-08-24T00:00:00Z' },
        { id: 2, label: '盘卷乙', msgCount: 1, savedAt: '2026-08-23T00:00:00Z' },
      ],
    );
    expect(rows.map((r) => r.id)).toEqual([2, 5, 1]); // 摊开在前，同组 savedAt 倒序（未落盘新卷在后）
    const r2 = rows.find((r) => r.id === 2)!;
    expect(r2.label).toBe('内存新名'); // 内存覆盖盘上旧名
    expect(r2.open).toBe(true);
    expect(rows.find((r) => r.id === 1)!.open).toBe(false);
  });

  it('relativeTime：刚刚 / 分钟 / 小时 / 天；缺省 —', () => {
    const now = Date.parse('2026-08-25T12:00:00Z');
    expect(relativeTime('2026-08-25T11:59:30Z', now)).toBe('刚刚');
    expect(relativeTime('2026-08-25T11:00:00Z', now)).toBe('1 小时前');
    expect(relativeTime('2026-08-25T09:00:00Z', now)).toBe('3 小时前');
    expect(relativeTime('2026-07-27T00:00:00Z', now)).toBe('29 天前');
    expect(relativeTime('', now)).toBe('—');
    expect(relativeTime('bad', now)).toBe('—');
  });

  it('statusLabel：pending/running/done/idle 文案', () => {
    expect(statusLabel('pending' satisfies SessionStatus)).toBe('等待交互');
    expect(statusLabel('running')).toBe('运行中');
    expect(statusLabel('done')).toBe('已完成');
    expect(statusLabel('idle')).toBe('空闲');
  });
});

describe('session-sidebar-model（注疏重排：检索/分节/机读注记）', () => {
  const mk = (id: number, label: string, open: boolean): SidebarRow => ({
    id,
    label,
    savedAt: open ? '' : '2026-08-30T00:00:00Z',
    open,
    msgCount: 3,
    status: 'idle',
  });

  it('filterRows：空 query 全量；匹配卷名（大小写无关）或卷号', () => {
    const rows = [mk(1, 'Cordis 生命周期', true), mk(2, '盘卷乙', false)];
    expect(filterRows(rows, '')).toHaveLength(2);
    expect(filterRows(rows, '  ')).toHaveLength(2); // 纯空白 = 空 query
    expect(filterRows(rows, 'cordis').map((r) => r.id)).toEqual([1]); // 大小写无关
    expect(filterRows(rows, '2').map((r) => r.id)).toEqual([2]); // 卷号数字
    expect(filterRows(rows, '不存在的卷')).toHaveLength(0);
  });

  it('splitSections：摊开中在前、已合卷在后，节内保持合流排序', () => {
    const rows = [mk(1, '甲', true), mk(2, '乙', true), mk(3, '丙', false), mk(4, '丁', false)];
    const { open, closed } = splitSections(rows);
    expect(open.map((r) => r.id)).toEqual([1, 2]);
    expect(closed.map((r) => r.id)).toEqual([3, 4]);
  });

  it('sessionMeta：块数 · 相对时间（**卷号已退**，2026-09-21）；未落盘出「未存」段', () => {
    const now = Date.parse('2026-08-25T12:00:00Z');
    expect(sessionMeta({ msgCount: 8, savedAt: '2026-08-25T11:00:00Z' }, now)).toBe('8 块 · 1 小时前');
    expect(sessionMeta({ msgCount: 0, savedAt: '' }, now)).toBe('0 块 · 未存');
  });
});

describe('session-sidebar-model（已合卷时间分桶，2026-09-02 UX 批）', () => {
  const mk = (id: number, savedAt: string): SidebarRow => ({
    id,
    label: `卷${id}`,
    savedAt,
    open: false,
    msgCount: 1,
    status: 'idle',
  });

  it('closedBucket：同日历日 = today；7 天内 = week；更早/坏值 = earlier', () => {
    const now = new Date(2026, 8, 2, 12, 0, 0).getTime(); // 2026-09-02 本地午
    expect(closedBucket(new Date(2026, 8, 2, 0, 0, 1).toISOString(), now)).toBe('today'); // 同日历日（跨午夜也算今天）
    expect(closedBucket(new Date(2026, 8, 1, 23, 0, 0).toISOString(), now)).toBe('week'); // 昨天
    expect(closedBucket(new Date(2026, 7, 28).toISOString(), now)).toBe('week'); // 6 天前
    expect(closedBucket(new Date(2026, 7, 20).toISOString(), now)).toBe('earlier'); // 13 天前
    expect(closedBucket('', now)).toBe('earlier'); // 缺省防御位
    expect(closedBucket('bad', now)).toBe('earlier'); // 坏值防御位
  });

  it('bucketClosed：桶序固定（今天 → 7 天内 → 更早），空桶不出场', () => {
    const now = new Date(2026, 8, 2, 12, 0, 0).getTime();
    const rows = [
      mk(4, new Date(2026, 7, 20).toISOString()), // earlier
      mk(1, new Date(2026, 8, 2, 9, 0, 0).toISOString()), // today
      mk(2, new Date(2026, 8, 1).toISOString()), // week
      mk(3, new Date(2026, 8, 2, 8, 0, 0).toISOString()), // today
    ];
    const buckets = bucketClosed(rows, now);
    expect(buckets.map((b) => b.bucket)).toEqual(['today', 'week', 'earlier']);
    expect(buckets[0].rows.map((r) => r.id)).toEqual([1, 3]); // 桶内保持传入序（合流排序）
    expect(bucketClosed([], now)).toEqual([]); // 全空 → 无桶
  });

  it('CLOSED_BUCKET_LABEL：三桶中文标签', () => {
    expect(CLOSED_BUCKET_LABEL.today).toBe('今天');
    expect(CLOSED_BUCKET_LABEL.week).toBe('7 天内');
    expect(CLOSED_BUCKET_LABEL.earlier).toBe('更早');
  });
});

describe('paper/space pickDropAnchor（拖动落位判据，P6 区间模型）', () => {
  it('无占用：拖到哪落哪（不吸附），y 取用户落点', () => {
    const anchor = pickDropAnchor([], '1', 2600, -300);
    expect(anchor).toEqual({ anchorX: 2600, anchorY: -300, width: 1440 });
  });

  it('与既有流区区间重叠 → 推最近空位（不跟其他流区打架）', () => {
    const existing = [
      { sessionId: '2', anchorX: 0, width: 1440 },
      { sessionId: '3', anchorX: 3120, width: 1440 },
    ];
    // 落点 2600 与 b [2280,3960] 重叠 → 推最近空位
    const anchor = pickDropAnchor(existing, '1', 2600, 50);
    expect(anchor.anchorX).not.toBe(2600);
  });

  it('自身所在位不算占用（拖动中的卷可以留在原位）', () => {
    const existing = [
      { sessionId: '1', anchorX: 3120, width: 1440 },
      { sessionId: '2', anchorX: 1560, width: 1440 },
    ];
    const anchor = pickDropAnchor(existing, '1', 3120, 10);
    expect(anchor.anchorX).toBe(3120); // 原位可留
  });
});

describe('paper/canvas-math viewFocusRegion（定位器视口）', () => {
  it('把流区锚点对到视口中心（rework P1-2：目标轮次落在中心，非底部上方 margin）', () => {
    const v = identityView();
    const target = viewFocusRegion(v, 1600, 900, { x: 2160, y: -500 });
    expect(target.zoom).toBe(1);
    expect(target.panX).toBe(800 - 2160); // 水平居中
    expect(target.panY).toBe(450 - -500); // 垂直中心
  });

  it('viewportCenterWorld：视口中心（屏幕 [w/2, h/2]）的世界坐标', () => {
    const v = identityView();
    expect(viewportCenterWorld(v, 1600, 900)).toEqual({ x: 800, y: 450 });
  });
});

describe('plugins/canvas-nav-plugin（贡献行 + 互斥两态开合，2026-09-02）', () => {
  it('注册书脊/会话侧边栏双面板 + toggle 命令', async () => {
    useDockStore.setState({
      open: { ...useDockStore.getState().open, 'canvas-spine': false, 'canvas-sidebar': false },
    });
    const { root, f1, f2, f3 } = await bootCanvasNav();
    const defs = panelDefs();
    const spine = defs.find((d) => d.id === 'canvas-spine');
    const sidebar = defs.find((d) => d.id === 'canvas-sidebar');
    expect(spine).toBeDefined();
    expect(spine?.side).toBe('left');
    expect(spine?.unmountOnClose).toBe(true);
    expect(sidebar).toBeDefined();
    expect(sidebar?.side).toBe('left');
    expect(sidebar?.unmountOnClose).toBe(true);
    expect(root.commands.get('canvas/sidebar-toggle')).toBeDefined();
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
  });

  it('互斥两态：纸开 → 书脊态起步（侧栏不开）；侧栏开 → 书脊退；侧栏收 → 书脊回；纸关 → 全退', async () => {
    useDockStore.setState({
      open: { ...useDockStore.getState().open, paper: false, 'canvas-spine': false, 'canvas-sidebar': false },
    });
    const { f1, f2, f3 } = await bootCanvasNav();
    useDockStore.getState().openPanel('paper');
    expect(useDockStore.getState().open['canvas-spine']).toBe(true); // 书脊态起步
    expect(useDockStore.getState().open['canvas-sidebar']).toBe(false); // 侧栏不自动展开
    useDockStore.getState().openPanel('canvas-sidebar'); // 用户经「案卷」toggle 唤出
    expect(useDockStore.getState().open['canvas-sidebar']).toBe(true);
    expect(useDockStore.getState().open['canvas-spine']).toBe(false); // 并陈 → 书脊退场
    useDockStore.getState().closePanel('canvas-sidebar'); // 收起侧栏
    expect(useDockStore.getState().open['canvas-spine']).toBe(true); // 书脊回场（收起态默认）
    expect(useDockStore.getState().open.paper).toBe(true);
    useDockStore.getState().closePanel('paper'); // 纸关 → 两者全退
    expect(useDockStore.getState().open['canvas-spine']).toBe(false);
    expect(useDockStore.getState().open['canvas-sidebar']).toBe(false);
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
  });

  it('热替换自愈：装载时遗留「双开」旧态 → 互斥不变量收敛（书脊退场）', async () => {
    useDockStore.setState({
      open: { ...useDockStore.getState().open, paper: true, 'canvas-spine': true, 'canvas-sidebar': true },
    });
    const { f1, f2, f3 } = await bootCanvasNav();
    expect(useDockStore.getState().open['canvas-sidebar']).toBe(true);
    expect(useDockStore.getState().open['canvas-spine']).toBe(false);
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
  });

  it('fiber dispose → 面板贡献干净退出', async () => {
    useDockStore.setState({
      open: { ...useDockStore.getState().open, 'canvas-spine': false, 'canvas-sidebar': false },
    });
    const { root, f1, f2, f3 } = await bootCanvasNav();
    expect(panelDefs().some((d) => d.id === 'canvas-spine')).toBe(true);
    await f3.dispose();
    expect(panelDefs().some((d) => d.id === 'canvas-spine')).toBe(false);
    expect(root.commands.get('canvas/sidebar-toggle')).toBeUndefined();
    await f2.dispose();
    await f1.dispose();
  });
});
