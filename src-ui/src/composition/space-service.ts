// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composition/space-service — 画布空间 API（Stage-2 一纸多卷打孔）。
//
// 定位（canvas-space-model-notes.md §7 打孔清单①）：**空间内核 = 平台开放
// API，上层形态 = 第一方插件**——内核只长「空间 API」这一块，书脊/目次带/
// 创作坞全部以插件贡献行消费它，不再动核心。
//
// ctx.space 提供：
//   - 读画布状态：getState() → { regions, activeSessionId }（流区位置 +
//     活跃会话，供插件/工具读）
//   - 订阅：subscribe(cb) → 流区/活跃会话变化即回调（canvas-store +
//     sess store 双订阅）
//   - 空间命令：focus（定位）/ expand（展开）/ collapse（收起）/ place（落位）
//
// 本阶段只打孔不消费完整形态：书脊三手势（阶段 3）、目次带（阶段 4）届时
// 以插件消费本通道；写法范本由 plugins/builtin/canvas-nav 实体接替（space-demo 已退役，2026-08-31）。
//
// 状态权威不变：流区位置唯一真相 = state/canvas-store（工作区级，随
// 工作区画布状态文件落盘，Stage-5）；活跃会话唯一权威 = sess store 的
// activeIdx。本 service 是只读合流 + 命令转发，不持有任何画布状态
// （「创作坞是视图不是容器」同族纪律）。

import { useCoreStore } from '../app/chat/core-instance';
import { useShellStore } from '../app/shell-store';
import { type Context, Service } from '../cordis';
import { defaultRegionFor } from '../paper/space';
import { getCanvasStore, regionFor } from '../state/canvas-store';
import { useCanvasViewStore } from '../state/canvas-view-store';
import { getChatStore } from '../ui/chat-store';

/** 插件/工具可见的流区快照（空间读面单元）。 */
export interface SpaceRegionState {
  sessionId: string;
  label: string;
  anchorX: number;
  anchorY: number;
  width: number;
}

/** ctx.space 读面的完整画布状态。 */
export interface SpaceState {
  regions: SpaceRegionState[];
  activeSessionId: string | null;
}

/** 当前核心面板 id（无 core = null——app 未就绪时空间读面为空态）。 */
function panelIdOf(): string | null {
  return useCoreStore.getState().core?.panelId ?? null;
}

export class SpaceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'space');
    setActiveSpace(this);
  }

  /** 读画布状态（非响应式——React 消费走订阅）。 */
  getState(): SpaceState {
    const panelId = panelIdOf();
    if (!panelId) return { regions: [], activeSessionId: null };
    const sessSt = getChatStore(panelId).sess.getState();
    const activeSid = sessSt.sessions[sessSt.activeIdx]?.id ?? null;
    const regions: SpaceRegionState[] = sessSt.sessions.map((s, i) => {
      const region = regionFor(panelId, String(s.id)) ?? defaultRegionFor(i);
      return {
        sessionId: String(s.id),
        label: s.label,
        anchorX: region.anchorX,
        anchorY: region.anchorY,
        width: region.width,
      };
    });
    return { regions, activeSessionId: activeSid != null ? String(activeSid) : null };
  }

  /** 订阅画布状态变化（流区位置 + 活跃会话）。返回退订函数。 */
  subscribe(cb: () => void): () => void {
    const panelId = panelIdOf();
    if (!panelId) return () => {};
    const unsubs: Array<() => void> = [];
    unsubs.push(getCanvasStore(panelId).subscribe(cb));
    unsubs.push(getChatStore(panelId).sess.subscribe(cb));
    return () => {
      for (const u of unsubs) u();
    };
  }

  /** 空间命令·定位：切到指定会话并标记为活跃流区（书脊左键定位的同族）。 */
  focus(sessionId: string): void {
    const panelId = panelIdOf();
    if (!panelId) return;
    const core = useCoreStore.getState().core;
    const sessSt = getChatStore(panelId).sess.getState();
    const idx = sessSt.sessions.findIndex((s) => String(s.id) === sessionId);
    if (idx < 0) return;
    core?.switchSession(idx);
    getCanvasStore(panelId).getState().setActiveRegion(sessionId);
  }

  /** 空间命令·落位：把流区摆到指定世界坐标（边缘拖拽落定的同族 API）。 */
  place(sessionId: string, anchorX: number, anchorY: number): void {
    const panelId = panelIdOf();
    if (!panelId) return;
    const canvas = getCanvasStore(panelId).getState();
    const cur = regionFor(panelId, sessionId);
    canvas.setRegion(sessionId, {
      anchorX,
      anchorY,
      width: cur?.width ?? defaultRegionFor(0).width,
    });
  }

  /** 空间命令·展开：把磁盘上已有卷摊上画布（未开则开，已开只定位）。
   *  展开绑定视角聚焦（用户拍板：不然落点找不到）——本命令是「摊开 + 定位」
   *  的单一权威入口，调用方**不得**再自己补 requestFocus（见下方失败语义）。 */
  expand(sessionId: string): void {
    const panelId = panelIdOf();
    const core = useCoreStore.getState().core;
    if (!panelId || !core) return;
    const sessSt = getChatStore(panelId).sess.getState();
    const openIdx = sessSt.sessions.findIndex((s) => String(s.id) === sessionId);
    if (openIdx >= 0) {
      // 已摊开：聚焦 + 飞行（位置已在 spread，飞行目标即真位置）
      this.focus(sessionId);
      useCanvasViewStore.getState().requestFocus(sessionId);
      return;
    }
    // 从当前工作区磁盘续开（失败由 loadSessionFromDisk 弹窗可见）
    const ws = useShellStore.getState().projectPath;
    void core
      .loadSessionFromDisk(ws, Number(sessionId))
      .then((opened) => {
        /* 收口（2026-09-10）：**摊开成功才发起定位**。旧实现无条件 requestFocus
         * ——失败卷（文件缺失/墓碑/读失败/代际丢弃）永远不会进摊开集，定位请求
         * 于是永不兑现也永不自清，只能靠用户平移/滚轮顺手清掉（「目标不存在即
         * 悬空」）。失败已由 loadSessionFromDisk 弹「案卷文件读取失败」可见，
         * 此处不留悬空请求。成功时卷已在 sess 里、spread 由落位 effect 补，
         * pending 保持到流区出现由补飞 effect 兑现（R1 语义）。 */
        if (opened) useCanvasViewStore.getState().requestFocus(sessionId);
      })
      // 抛出（读盘/装配链异常）不得静默：旧实现会让它变成无人接的 rejection
      .catch((e) => {
        console.error('[space] expand 续开失败:', sessionId, e);
      });
  }

  /** 空间命令·收起：合卷（流区从画布彻底退场；不自动重排——用户自主）。 */
  collapse(sessionId: string): void {
    const panelId = panelIdOf();
    const core = useCoreStore.getState().core;
    if (!panelId || !core) return;
    const sessSt = getChatStore(panelId).sess.getState();
    const idx = sessSt.sessions.findIndex((s) => String(s.id) === sessionId);
    if (idx < 0) return;
    core.closeSession(idx);
  }
}

// ── S4-1.5 同款「活动服务」间接层（模块级可变态归属 CONVENTIONS §1.10
//    第 3 类：键控自清理，生命周期 = 进程）──

let _activeSpace: SpaceService | null = null;

function setActiveSpace(svc: SpaceService): void {
  _activeSpace = svc;
}

/** 当前空间服务（无服务/未装配 = null——合流点读它，空态由调用方降级）。 */
export function activeSpace(): SpaceService | null {
  return _activeSpace;
}

// ── ctx 通道声明（对齐 panels/commands/tools/providers 的 augmentation）──

declare module '../cordis/context' {
  interface Context {
    /** 画布空间 API（Stage-2）：读画布状态 + 订阅 + 空间命令。 */
    space: SpaceService;
  }
}

/** 空间服务挂载插件（Stage-2）：常驻根上下文，先于任何外部插件装载。
 *  独立成插件而非并入 compositionServicesPlugin——space-service 依赖
 *  chat-store 链（较重），独立插件使组合层四 service 模块保持轻量
 *  （纸壳/组合测试不装载本插件时不必拖入整个 chat-store 导入图）。 */
export const spaceServicePlugin = {
  name: 'hologram/composition-space',
  apply(ctx: Context) {
    new SpaceService(ctx);
  },
};
