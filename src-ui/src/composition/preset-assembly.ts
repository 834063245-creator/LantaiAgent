// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// preset 装配解析层（S4-1a）—— 会话怎么拿到自己的组合（设计件 §2.2）。
//
// 职责：
//   1. 用户层 patch 登记：patch-loader 成功路径把校验后的 CompositionPatch
//      顺手登记（preset 解析的用户层输入——不能用 composition-store.resolved
//      当用户层，那是已叠加产物；preset 叠层必须回到 factory 之上重叠
//      「用户层 + preset 层」两层）；
//   2. 引用稳定 cache：key = presetId + 用户层内容 hash + preset patch 内容
//      hash（两个失效触发器：用户层变更（S4-2 热重载）/ preset 内容变更
//      （discovery 重扫）——任一变化 → 新 key → 新组合，R13）；
//   3. 选择同步：settings.composition.preset ↔ preset-store.selected（boot 期
//      settings → store；selectPreset 反向写回 settings）；
//   4. boot 应用：applyDefaultPreset 把「factory + 用户层 + preset 层」的
//      解析产物写回 composition-store（S2 store 原样复用——preset 只是
//      多了一层 patch 输入）。
//
// 纯度纪律：本文件不 fetch 不读盘（远端在 preset-discovery）；store 写入只
// 发生在显式入口（applyDefaultPreset / syncPresetSelectionFromSettings /
// selectPreset）。永不抛出（坏 preset 的可见面在 discovery 的行级 error；
// 语义层失败（未知 id → resolveRoster 内部）由 resolvePresetComposition 的
// factory 兜底语义吸收）。
//
// 模块级可变态归属（CONVENTIONS §1.10）：userPatchRegistry / cache 属第 3 类
// （键控自清理——用户层 hash 变化即整表失效，无跨工作区所有权问题）。

import { loadSettings, saveSettings } from '../settings';
import { useCompositionStore } from '../state/composition-store';
import { usePresetStore } from '../state/preset-store';
import { builtinPresetById, resolvePresetComposition } from './presets';
import type { CompositionPatch, ResolvedComposition } from './roster';

// ── 用户层 patch 登记 ──

/** 用户层 patch 登记（S4-1a）——patch-loader 成功路径写入；null = 无/被拒。
 *  内容随 loader 重载整体替换（键控单键，生命周期 = 进程）。 */
const userPatchRegistry: { patch: CompositionPatch | null } = { patch: null };

/** patch-loader 成功解析用户层 patch 后登记（供 preset 叠层解析用）。 */
export function registerUserPatch(patch: CompositionPatch): void {
  userPatchRegistry.patch = patch;
}

/** 用户层 patch 被拒/不存在时清登记（loader 的 error/404 路径调用）。 */
export function clearUserPatch(): void {
  userPatchRegistry.patch = null;
}

/** 当前登记的用户层 patch（诊断/测试面）。 */
export function registeredUserPatch(): CompositionPatch | null {
  return userPatchRegistry.patch;
}

// ── 引用稳定 cache ──

/** 内容 hash——纯 JSON 形状的 stable 序列化 + FNV-1a 32bit（无碰撞安全
 *  诉求，只为失效判定；短、零依赖）。 */
function hashJson(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null';
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** preset 解析缓存：key → ResolvedComposition。用户层 hash 变化 → 整表
 *  失效；键含 preset patch 内容 hash → discovery 重扫（内容变）自动失效。 */
const cache = new Map<string, ResolvedComposition>();
let lastUserHash = '';

/** 当前生效组合解析入口（§2.2 装配粒度：workspace Agent 装配 / 占位 Agent /
 *  子 Agent 三处读同一默认 preset）。
 *
 *  presetId 缺省 = preset-store.selected（boot 经 settings 同步的运行时真源）。
 *  返回引用稳定：同 (presetId, 用户层内容, preset 内容) 的多次调用返回同一对象。 */
export function resolveCurrentComposition(presetId?: string): ResolvedComposition {
  const id = presetId ?? usePresetStore.getState().selected;
  const userPatch = userPatchRegistry.patch;
  const userHash = hashJson(userPatch);
  if (userHash !== lastUserHash) {
    cache.clear(); // 用户层内容变更 → 全表失效（R13：改用户层后新装配用新组合）
    lastUserHash = userHash;
  }
  const roster = usePresetStore.getState().roster.filter((p) => !p.builtin);
  const preset = builtinPresetById(id) ?? roster.find((p) => p.id === id);
  const key = id + ':' + userHash + ':' + hashJson(preset?.patch ?? null);
  const hit = cache.get(key);
  if (hit) return hit;
  const resolved = resolvePresetComposition(id, { userPatch, userPresets: roster });
  if (cache.size >= 32) cache.clear(); // 防御性上限（preset 数量级远小于此）
  cache.set(key, resolved);
  return resolved;
}

/** cache 失效入口（测试用——生产路径经内容 hash 变化自然失效）。 */
export function invalidatePresetCache(): void {
  cache.clear();
  lastUserHash = '';
}

/** 当前生效 preset id（S4-1b 会话记录消费）：preset-store 选择态的只读面。
 *  值恒为字符串（store 缺省 'standard'）——调用方（Agent 构造首事件）
 *  不需要 null 语义。 */
export function currentPresetId(): string {
  return usePresetStore.getState().selected;
}

// ── 选择同步 ──

/** boot 期同步：settings.composition.preset → preset-store.selected。
 *  缺省容错：旧存储无 composition 字段（DEFAULTS 合并补 standard）或显式
 *  空串 → standard。 */
export function syncPresetSelectionFromSettings(): void {
  const raw = loadSettings().composition?.preset;
  const preset = typeof raw === 'string' && raw.trim() !== '' ? raw : 'standard';
  const store = usePresetStore.getState();
  if (store.selected !== preset) store.select(preset);
}

/** 切换 preset（设置面板/未来选择器入口）：store 同步 + settings 持久化。
 *  生效时机（§2.1）：装配作用域下次装配生效；壳作用域重启生效（壳行无
 *  dispose 语义，S2 裁定不变）。返回 false = settings 写失败（store 已切——
 *  内存态先行，持久化失败可见，下次启动回退旧值）。 */
export function selectPreset(presetId: string): boolean {
  usePresetStore.getState().select(presetId);
  try {
    saveSettings({ ...loadSettings(), composition: { preset: presetId } });
    return true;
  } catch (e) {
    console.warn('[preset] preset 选择持久化失败:', e);
    return false;
  }
}

// ── boot 应用（穿线终点）──

/** boot 期应用默认 preset 层：resolved = factory + 用户层 + preset 层 →
 *  composition-store.setResolved（S2 store 原样复用）。
 *
 *  跳过语义（零漂移保证）：
 *  - 用户层 error 态 → 跳过（错误可见优先，factory 兜底态不被 preset 悄悄
 *    改写——S2 all-or-nothing 的可见面保持）；
 *  - 生效 preset patch 为空/缺失（standard / 未知 id / broken 行）→ 跳过
 *    （composition-store 保持 loadCompositionPatch 的产物——standard 下
 *    store 状态字节不变）；
 *  - 未知 id（非 standard）console.warn 可见（不静默吞选择错误）。
 *  永不抛出。 */
export function applyDefaultPreset(): void {
  const comp = useCompositionStore.getState();
  if (comp.status === 'error') return;
  const { selected, roster } = usePresetStore.getState();
  const preset = builtinPresetById(selected) ?? roster.find((p) => p.id === selected && !p.builtin);
  if (!preset && selected !== 'standard') {
    console.warn('[composition] 未知/损坏 preset "' + selected + '"——保持用户层组合');
  }
  const patch = preset?.patch;
  if (!patch || Object.keys(patch).length === 0) return; // 空 patch = 无增量 = 不触碰
  const resolved = resolveCurrentComposition(selected);
  const origin = comp.patchOrigin ? comp.patchOrigin + ' + preset:' + selected : 'preset:' + selected;
  useCompositionStore.getState().setResolved(resolved, origin);
}
