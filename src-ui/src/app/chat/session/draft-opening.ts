// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// draft-opening — **开卷的几何编排**（新卷出生面，2026-11-14 立卷 UX）。
//
// 为什么单独立文件：这三件事都是「把一张纸变成一张卷」的**空间动作**，与
// ChatCore 的会话编排（发号/装配/消息流）不是同一层的知识。它们也各自踩过真机坑：
//
//   ① **落位**：待题纸开在哪，卷就落哪（纸不跳位）。落位是画布状态的**唯一真源写入**
//      ——绝不许写成 `activeSpace()?.place(...)`：空间服务不在场时可选链会静默吞掉
//      整件事，随后落位 effect 的 `nearestFreeRegion` 接管；空画布上两个算法恰好同值
//      （测不出来），用户平移过画布立刻分家：纸在这儿，呼吸灯与匣脚引线在那儿。
//   ② **出生 = 一种展开**：新卷必须被标成**活跃流区**（`activeSessionKey` 是匣脚引线 /
//      目录带 / 创作坞三处的判据），并**确保它在眼前**。
//      这一条曾被可选链吞掉（ChatCore 压根没有 `requestFocus` 能力位）——症状是
//      「引线整层不画 + 坞对着上一卷」，用户读作「定位全错」。
//      **2026-11-16 收窄**：定位不再无条件发起 —— 落纸那一刻镜头已经把纸带到视野里
//      （见 DraftSheet 的落纸一拍），纸与卷同锚点同宽 ⇒ 再飞一次只是让视线在交接那一拍
//      自己动一下。现在按 `volumeInSight` 判：在眼前 = 只标活跃；不在眼前 = 照旧请求飞行。
//   ③ **倾斜的卷级覆盖**：题签里的模型/思考只在**显式题过**时写会话覆盖。

import { worldToScreen } from '../../../paper/canvas-math';
import { STREAM_REGION } from '../../../paper/space';
import type { StoredThinking } from '../../../provider/thinking';
import { getCanvasStore } from '../../../state/canvas-store';
import { useCanvasViewStore } from '../../../state/canvas-view-store';
import { getComposeStore } from '../../../state/compose-store';
import { armRiseVolume, clearRiseVolume } from '../../../state/draft-sheet-store';
import type { PermissionMode } from '../../../state/mode-store';
import { useModeStore } from '../../../state/mode-store';
import { getChatStore } from '../../../ui/chat-store';
import { createSessionWithPreset } from '../session-composition';
import type { SessionContext } from './session-types';

/** 造模式的开场白真源转发面（**单一真源** = session-composition 的
 *  CREATOR_OPENING_PROMPT；待题纸开卷后填它，不各写一份）。 */
export { CREATOR_OPENING_PROMPT } from '../session-composition';

/** 落位：卷落在待题纸所在的那个锚点（宽度沿用该卷已有值 / 流区统一宽）。 */
export function placeDraftRegion(
  panelId: string,
  sessionId: string,
  region: { anchorX: number; anchorY: number },
): void {
  const canvas = getCanvasStore(panelId).getState();
  const width = canvas.getRegion(sessionId)?.width ?? STREAM_REGION.width;
  canvas.setRegion(sessionId, { anchorX: region.anchorX, anchorY: region.anchorY, width });
}

/** 出生 = 一种展开：标活跃流区 + 请求定位（null = 清悬空定位）。 */
export function focusBornVolume(panelId: string, sessionId: string | null): void {
  if (sessionId === null) {
    useCanvasViewStore.getState().requestFocus(null);
    return;
  }
  getCanvasStore(panelId).getState().setActiveRegion(sessionId);
  useCanvasViewStore.getState().requestFocus(sessionId);
}

/** 这一卷**已经在眼前**吗（= 落纸那一刻镜头已经把它带到视野里了）。
 *
 *  判据 = 该卷锚点（最新块底边）投到屏幕后落在画布矩形之内。开卷时若它已经在
 *  眼前，就**只标活跃、不再飞**：纸与卷同锚点同宽，再飞一次等于让视线在交接那一拍
 *  自己动一下（屏上的东西没变，画面却抖了一格）。卷不在眼前（视口被拖走 / 窗口极小）
 *  才回落到请求飞行——「出生即展开」要的是**一定能看见**，不是「一定要飞」。
 *
 *  ⚠ 读的是**画布状态里的落位**（不是屏幕矩形）：`placeRegion` 已把卷写到纸的锚点上，
 *  两侧用的是同一份坐标，不存在「纸在这儿、卷在那儿」的分家。 */
export function volumeInSight(panelId: string, sessionId: number): boolean {
  const region = getCanvasStore(panelId).getState().spread[String(sessionId)];
  if (!region) return false; // 还没落位 = 无从判可见 ⇒ 当它不在眼前（回落飞行）
  const cvs = useCanvasViewStore.getState();
  const screen = worldToScreen(cvs.view, region.anchorX, region.anchorY);
  return screen.x >= 0 && screen.x <= cvs.canvasSize.w && screen.y >= 0 && screen.y <= cvs.canvasSize.h;
}

/** 题签的模型/思考：**只在显式题过**时写会话覆盖（全默认 = 零覆盖，照常跟随全局）。 */
export function applyDraftPicks(
  panelId: string,
  sessionId: number,
  picks: {
    providerName: string;
    model: string;
    thinking: StoredThinking | undefined;
    /** 题签第四格（2026-11-28 卷级权限批）：null = 跟随工作区，不落覆盖。 */
    permission?: PermissionMode | null;
  },
  fallback: { providerName: string; model: string },
): void {
  /* 权限先落（它自成一条账：即使模型/思考全默认也要写）——卷级覆盖只在题过时才存在。 */
  if (picks.permission != null) {
    useModeStore.getState().setSessionMode(sessionId, picks.permission);
  }
  if (picks.providerName === fallback.providerName && picks.model === fallback.model && picks.thinking === undefined) {
    return;
  }
  const compose = getComposeStore(panelId).getState();
  compose.setModel(String(sessionId), picks.providerName, picks.model);
  if (picks.thinking !== undefined) compose.setThinking(String(sessionId), picks.thinking);
}

// ── 开卷编排（V2：发送即开卷的唯一实现）────────────────────────────────

/** 开卷入参（题签三笔 + 纸的锚点）。 */
export interface DraftOpenOpts {
  /** 组合（null = 跟随全局默认，不落卷级登记）。 */
  presetId: string | null;
  /** 题签的模型/思考（只在**显式题过**时写会话覆盖）。 */
  picks: { providerName: string; model: string; thinking: StoredThinking | undefined };
  /** 「新卷出生默认」——零覆盖判据的另一半（与 picks 同一把尺子）。 */
  fallback: { providerName: string; model: string };
  /** 纸的锚点（null = 纸还没落过位：不写落位，让既有落位 effect 用同一把尺子接管）。 */
  anchor: { anchorX: number; anchorY: number } | null;
}

export type DraftOpenResult = { ok: true; sessionId: number } | { ok: false; reason: string };

/** 把纸变成卷所需的三个空间动作（由 ChatCore 注入——本模块不持有 core）。 */
export interface DraftOpenHooks {
  placeRegion: (sessionId: string, region: { anchorX: number; anchorY: number }) => void;
  requestFocus: (sessionId: string | null) => void;
  applyDraftPicks: (
    sessionId: number,
    picks: { providerName: string; model: string; thinking: StoredThinking | undefined },
    fallback: { providerName: string; model: string },
  ) => void;
}

/**
 * **开卷**：待题纸按发送那一刻的唯一实现（2026-11-15 V2）。
 *
 * 顺序（错一步就出现「纸已撤、卷没个准位置」）：
 *   ① 存正文 → 起卷（带组合，出生即按它装配）→ 还正文；
 *   ② 落位（纸在哪，卷就落哪）；
 *   ③ 出生 = 一种展开（标活跃流区；**不在眼前**才请求定位飞行——落纸那一拍已经把
 *      镜头带到纸上，卷与纸同锚点同宽，再飞一次只是让视线在交接拍自己动一下）；
 *   ④ 题签的另两笔落到会话覆盖上（全默认 = 零覆盖）。
 *
 * 为什么 ① 要先存正文：`createNewSession` 会 `restoreSessionDraft`（新卷无草稿槽）
 * ⇒ 不清即丢；纸上的正文就是即将发出的那一句。
 * 为什么 ④ 放在最后：它写的是「这一卷的会话覆盖」，必须等卷号存在。
 */
export async function openDraftVolume(
  panelId: string,
  ctx: SessionContext,
  opts: DraftOpenOpts,
  hooks: DraftOpenHooks,
  /** 这一卷此刻在不在眼前（判据 = `volumeInSight`；由 ChatCore 的能力位注入）。 */
  inSight: (sessionId: number) => boolean = (sid) => volumeInSight(panelId, sid),
): Promise<DraftOpenResult> {
  const input = getChatStore(panelId).input;
  const pendingText = input.getState().inputText;
  /* **发号之前**挂「出生即交接」账（2026-11-15 化卷批）：卷开合两窗的判据在**渲染期**跑，
   * 账晚一步（effect / 发号之后）那一卷就已经被当成普通摊开记进 played，落墨窗再也不开。
   * 见 state/draft-sheet-store 的 isRiseVolume 头注。 */
  armRiseVolume();
  const r = await createSessionWithPreset(ctx, opts.presetId ?? undefined);
  if (!r.ok) clearRiseVolume(); // 起卷失败 = 这一张纸没化成任何卷
  if (!r.ok) return r;
  if (pendingText) input.getState().setInputText(pendingText);
  const sid = String(r.sessionId);
  if (opts.anchor) hooks.placeRegion(sid, opts.anchor);
  /* ③ 在眼前 = 只标活跃（不再飞）：落纸那一拍已经把镜头带到这张纸上，而卷与纸
   *    **同锚点同宽**——再飞一次的画面变化 = 视线在交接拍自己挪一小格。不在眼前
   *    （视口被拖走 / 窗口极小）才回落请求飞行，「出生即展开」的底线是不许看不见。 */
  getCanvasStore(panelId).getState().setActiveRegion(sid);
  if (!inSight(r.sessionId)) hooks.requestFocus(sid);
  hooks.applyDraftPicks(r.sessionId, opts.picks, opts.fallback);
  return r;
}
