// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state/run-config — **「这一卷打算怎么跑」的单一解析与单一写入层**（2026-11-29 收口批）。
//
// 病灶（用户判词：「题签这东西从根上就没做好」——11-15 落地到 11-20，19 次提交里 12 次是
// 真机 fix，其中 9 次集中在两条根因上）：
//   ① **第二个宿主**：题签行是「坞的第二次挂载」，而那批 hook 一律读 `focusedId` ⇒ 多纸
//      同屏时每张纸都显示焦点那张的四笔，写入也写到别人头上（aacd693c 只补了现场）；
//   ② **一行四种语义、四条写路径**：组合 = 卷级登记（不可晚定）／模型·思考 = 出生默认
//      （可晚定）／权限 = 卷级覆盖／「记住」= 下一张纸的事——四件事散在三个宿主里各写各的，
//      于是每次「修题签」都在重新决定「这一格该写哪儿」。
//
// 本层把这两件事一次定死：
//   · `resolveRunConfig(目标)` —— 目标只有三种（**一张纸 / 一卷 / 无主**），返回值是四笔的
//     **生效值 + 来源**。任何宿主（题签行、纸身输入面、坞的设置行）都只问它，不再自己
//     `?? 兜底`、更不许自己从 `focusedId` 里摸题签。
//   · `patchRunConfig(目标, 补丁)` —— 四笔的**唯一写入口**，按目标分流「这一卷 / 下一卷 /
//     工作区默认」，并把「自动 = 显式 ''（坞/卷）而纸上是 undefined（没题）」这类**不对称
//     语义收在这里**（散在调用点就是下一个 bug）。
//
// 边界（明示）：**卷级组合**（`core.selectSessionPreset`）不归本层——它是异步 + 二道闸
// （空白闸 + 严一档校验 + 当场重建句柄）的卷级登记，入口住在卷首芯片
// `paper-shell/FolioCompositionChip`（坞的 `use-composer-composition` 已随收口批删除：
// 它唯一的读者是题签行，而纸期永远走不到卷级那一支 = 死码）；本层对 `volume` 的组合
// 写请求**具名拒绝**，不静默降级。
//
// 纪律：本文件只碰 store / settings（无 React、无 DOM）。宿主经宿主桥（faceDeps）取用——
// 直连会被 esbuild 内联成第二份 store（landmine-map 的老账）。

import { selectPreset } from '../composition/preset-assembly';
import type { StoredThinking } from '../provider/thinking';
import { loadSettings, rememberedThinking } from '../settings';
import { getComposeStore, resolveNewSessionDefault } from './compose-store';
import { type DraftPicks, useDraftSheetStore } from './draft-sheet-store';
import { type PermissionMode, useModeStore } from './mode-store';
import { usePresetStore } from './preset-store';

/** 解析目标：**只有三种**（多一种就多一处「这一笔该写哪儿」的空白）。
 *  一律带 `panelId`：卷号/纸都是面板内的东西，而 compose-store 是按面板隔离的。 */
export type RunTarget =
  | { kind: 'paper'; paperId: string; panelId: string }
  | { kind: 'volume'; sessionId: string; panelId: string }
  | { kind: 'bare'; panelId: string };

/** 一张待题纸（**必须给纸 id**——「不给就落焦点那张」正是本批要根除的写法）。 */
export function paperTarget(paperId: string, panelId: string): RunTarget {
  return { kind: 'paper', paperId, panelId };
}

/** 一卷（`sessionId` 收 string/number：卷号在两域的既有形态不一致，转换集中于此）。 */
export function volumeTarget(sessionId: string | number, panelId: string): RunTarget {
  return { kind: 'volume', sessionId: String(sessionId), panelId };
}

/** 无主（坞的空态 / 裸挂单件）：四笔全部读「出厂默认」。 */
export function bareTarget(panelId: string): RunTarget {
  return { kind: 'bare', panelId };
}

/** 四笔各自的来源——界面标「（默认）」与「全默认 = 零覆盖」判据都用它。 */
export interface RunSources {
  preset: 'explicit' | 'default';
  model: 'explicit' | 'default';
  /** 思考：`explicit` = 这个目标上显式拨过；`default` = 没有显式选择（自动）。
   *  ⚡ 2026-11-21：`model` 来源随「提供方/模型默认档位」一并退役。 */
  thinking: 'explicit' | 'default';
  permission: 'explicit' | 'default';
}

/** 某个目标的**生效**运行配置（四笔值 + 来源）。 */
export interface RunConfig {
  presetId: string;
  providerName: string;
  model: string;
  /** `undefined` = 这个目标没有显式档位（按模型解析）；`''` = 显式「自动」（关闭思考）。 */
  thinking: StoredThinking | undefined;
  permission: PermissionMode;
  sources: RunSources;
}

/** 解析依赖（宿主可注入的既有读数——只加速，不改变规则）：
 *  - `presetHint`：**卷级**组合读数（`core.sessionComposition` 是异步的，读面归宿主）。 */
export interface RunDeps {
  presetHint?: { presetId: string; source: 'session' | 'global' };
}

/** 读：某个目标此刻四笔各是什么、来自哪里。
 *
 *  优先级（**唯一一份**，别再在宿主里重写）：
 *    paper  ：题签（这张纸的记录）→ 新卷出生默认 → 出厂
 *    volume ：卷级覆盖 → 全局默认（模型/思考走 compose-store 的 resolveEffective）
 *    bare   ：新卷出生默认 → 出厂
 *  思考档只有两层（2026-11-21 收口）：本目标上显式拨的值 / 没有（= 自动）。 */
export function resolveRunConfig(target: RunTarget, deps: RunDeps = {}): RunConfig {
  const fallback = resolveNewSessionDefault();
  const presetSelected = usePresetStore.getState().selected;
  const workspaceMode = useModeStore.getState().permissionMode;

  if (target.kind === 'paper') {
    const paper = useDraftSheetStore.getState().papers.find((p) => p.id === target.paperId);
    /* 纸不在了（迟到渲染 / 已弃）：**按无主读出**，绝不回落到焦点那张（本批根因）。 */
    if (!paper) return bareConfig(fallback, presetSelected, workspaceMode);
    const picks = paper.picks;
    /* 模型/思考的「显式」判据 = **与出生默认逐值不等**（与开卷那一刻 `applyDraftPicks`
     * 的「全默认 = 零覆盖」同一把尺子——纸的题签生来就填好三笔，按「有没有 picks」
     * 判会把每一张纸都读成「用户改过」）。 */
    const modelExplicit =
      picks !== null && (picks.providerName !== fallback.providerName || picks.model !== fallback.model);
    /* 组合同理按**值**判（纸摊开时题签就填了「当时的全局默认」，按「有没有值」判会把
     * 每张纸都读成「本卷自己定的」——行上那枚「默认」记号就再也出不来）。 */
    const presetExplicit = picks?.presetId != null && picks.presetId !== presetSelected;
    const providerName = picks?.providerName ?? fallback.providerName;
    const model = picks?.model ?? fallback.model;
    const thinking = picks?.thinking ?? rememberedThinkingFor(providerName, model);
    return {
      presetId: picks?.presetId ?? presetSelected,
      providerName,
      model,
      thinking,
      permission: picks?.permission ?? workspaceMode,
      sources: {
        preset: presetExplicit ? 'explicit' : 'default',
        model: modelExplicit ? 'explicit' : 'default',
        thinking: picks?.thinking !== undefined ? 'explicit' : 'default',
        permission: picks?.permission != null ? 'explicit' : 'default',
      },
    };
  }

  if (target.kind === 'volume') {
    const compose = getComposeStore(target.panelId).getState();
    const effective = compose.resolveEffective(target.sessionId);
    const explicit = compose.getPrefs(target.sessionId);
    const mode = useModeStore.getState();
    const sessionPermission = mode.sessionModes[target.sessionId];
    const thinking = explicit?.thinking ?? rememberedThinkingFor(effective.providerName, effective.model);
    return {
      presetId: deps.presetHint?.presetId ?? presetSelected,
      providerName: effective.providerName,
      model: effective.model,
      thinking,
      permission: sessionPermission ?? mode.permissionMode,
      sources: {
        preset: deps.presetHint?.source === 'session' ? 'explicit' : 'default',
        model: explicit ? 'explicit' : 'default',
        thinking: explicit?.thinking !== undefined ? 'explicit' : 'default',
        permission: sessionPermission !== undefined ? 'explicit' : 'default',
      },
    };
  }

  return bareConfig(fallback, presetSelected, workspaceMode);
}

/** 该模型「上次用过的档位」（本机记忆；设置页没有手动入口）。无 = undefined（自动）。 */
function rememberedThinkingFor(providerName: string, model: string): StoredThinking | undefined {
  try {
    const p = loadSettings().providers.find((x) => x.name === providerName);
    return p ? rememberedThinking(p, model) : undefined;
  } catch {
    return undefined;
  }
}

/** 无主态（坞的空态 / 裸挂单件）：四笔全是出厂默认。 */
function bareConfig(
  fallback: { providerName: string; model: string; thinking: StoredThinking | undefined },
  presetSelected: string,
  workspaceMode: PermissionMode,
): RunConfig {
  return {
    presetId: presetSelected,
    providerName: fallback.providerName,
    model: fallback.model,
    thinking: rememberedThinkingFor(fallback.providerName, fallback.model),
    permission: workspaceMode,
    sources: { preset: 'default', model: 'default', thinking: 'default', permission: 'default' },
  };
}

/** 写补丁：**只给变的那几笔**。`thinking` 的 `''` = 显式「自动」（关闭思考）。 */
export interface RunPatch {
  /** `null` = 回到全局默认（纸）/ 清卷级覆盖（卷）。 */
  presetId?: string | null;
  model?: { providerName: string; model: string };
  thinking?: StoredThinking;
  permission?: PermissionMode | null;
}

export type RunPatchResult = { ok: true } | { ok: false; reason: string };

/** 写：某个目标的四笔**唯一入口**。按目标分流「这一卷 / 下一卷 / 工作区默认」，
 *  并把「纸上」与「坞里」对「自动」的不同表达收在一处（见头注）。
 *
 *  @returns `{ ok:false, reason }` = **具名拒绝**（不可用的组合 / 卷级组合要二道闸），
 *           调用方负责把原因播给用户；其余分支同步生效。 */
export function patchRunConfig(target: RunTarget, patch: RunPatch): RunPatchResult {
  if (patch.presetId !== undefined && target.kind === 'volume') {
    /* 卷级组合必须经 `core.selectSessionPreset`（空白闸 + 严一档校验 + 当场重建句柄），
     * 本层不碰 core、也不做半截降级——写出去就是「登记了但没生效」。 */
    return { ok: false, reason: '卷级组合要经 core.selectSessionPreset（本层不代写）' };
  }
  /* 顺序即语义：先换模型（换模型 = 思考档重解析），再落档位——反了会把旧档位写进新模型。 */
  if (patch.model) writeModel(target, patch.model);
  if (patch.thinking !== undefined) writeThinking(target, patch.thinking);
  if (patch.permission !== undefined) writePermission(target, patch.permission);
  if (patch.presetId !== undefined) return writePreset(target, patch.presetId);
  return { ok: true };
}

function paperById(paperId: string) {
  return useDraftSheetStore.getState().papers.find((p) => p.id === paperId) ?? null;
}

/** 写「这一张纸」的题签某一笔（纸不在 = 不写；空写会落到别人头上）。 */
function writePaperPicks(paperId: string, patch: Partial<DraftPicks>): boolean {
  const paper = paperById(paperId);
  const picks = paper?.picks;
  if (!paper || !picks) return false;
  useDraftSheetStore.getState().setPicks({ ...picks, ...patch }, paper.id);
  return true;
}

function writeModel(target: RunTarget, model: { providerName: string; model: string }): void {
  if (target.kind === 'paper') {
    /* 换模型 = 思考档重解析（旧档位可能不在新模型声明里）——与「坞里拨模型」同一条语义。
     * 「下一卷」同一笔写成出生默认（2026-11-19「题签要能记住选择」批）。 */
    writePaperPicks(target.paperId, {
      providerName: model.providerName,
      model: model.model,
      thinking: undefined,
    });
    getComposeStore(target.panelId).getState().setGlobalModel(model.providerName, model.model);
    return;
  }
  if (target.kind === 'volume') {
    getComposeStore(target.panelId).getState().setModel(target.sessionId, model.providerName, model.model);
    return;
  }
  getComposeStore(target.panelId).getState().setGlobalModel(model.providerName, model.model);
}

function writeThinking(target: RunTarget, value: StoredThinking): void {
  /* 「自动」的两种表达（本层收口）：纸上是 **undefined**（= 没题，开卷零覆盖）；
   * 坞里/卷上是 **''** 显式值（否则会回落该模型声明的档位——用户选了「自动」又变回去）。 */
  if (target.kind === 'paper') {
    writePaperPicks(target.paperId, { thinking: value === '' ? undefined : value });
    getComposeStore(target.panelId).getState().setGlobalThinking(value);
    return;
  }
  if (target.kind === 'volume') {
    getComposeStore(target.panelId).getState().setThinking(target.sessionId, value);
    return;
  }
  getComposeStore(target.panelId).getState().setGlobalThinking(value);
}

function writePermission(target: RunTarget, mode: PermissionMode | null): void {
  if (target.kind === 'paper') {
    /* 题签第四格（这一卷开卷时落成卷级覆盖）+ 待题纸出厂值（下一张纸预填它）。
     * ⚠ 出厂值**不是**工作区默认：在纸上拨一下不该让所有未覆盖的卷一起变。 */
    writePaperPicks(target.paperId, { permission: mode });
    useModeStore.getState().setSheetPermissionDefault(mode);
    return;
  }
  if (target.kind === 'volume') {
    useModeStore.getState().setSessionMode(target.sessionId, mode);
    return;
  }
  if (mode !== null) useModeStore.getState().setPermissionMode(mode);
}

function writePreset(target: RunTarget, presetId: string | null): RunPatchResult {
  if (target.kind === 'paper') {
    writePaperPicks(target.paperId, { presetId });
    if (presetId === null) return { ok: true };
    /* 同时记成新卷默认（与坞的无主态、设置面板**同一个入口**：含校验与落盘）。
     * 校验不过返回 false 且只把原因留在 preset-store.error 上——那一条由宿主播报。 */
    return selectPreset(presetId)
      ? { ok: true }
      : { ok: false, reason: `组合「${presetId}」不可用（原因见设置 → Agent → 组合）` };
  }
  if (presetId === null) return { ok: false, reason: '无主态没有「跟随默认」可清——直接选一个组合' };
  return selectPreset(presetId)
    ? { ok: true }
    : { ok: false, reason: `组合「${presetId}」不可用（原因见设置 → Agent → 组合）` };
}
