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
// selectPreset / noteSelectionError）。
//
// ⚡ F1 捕获网（2026-09-15 审计修复）——preset 层**任何失败都不许穿出去**：
//   病灶：行 id 不可寻址（写错 / 对应插件被禁用）走 resolveRoster 的
//   all-or-nothing 抛错，而 resolvePresetComposition 只在 patch 为 null 时
//   兜底；异常于是穿到 bootShell（10 条壳行全不 boot = 空壳，且只落 console，
//   ui.log 不可见）与会话工厂（首次拟文炸）。用户层 patch 有 patch-loader 的
//   try/catch + setError 兜底，preset 层没有——这个不对称是缺陷本体。
//   现行语义：
//     - effectiveComposition()：生产唯一解析入口，失败 → 回退「只叠用户层」的
//       组合 + 原因经 preset-store.error 可见（错误不静默）；
//     - selectionError()：选择前校验，selectPreset 据此**拒绝切换**（旧选择与
//       settings 都不动——「选了但没生效」比「拒绝并说明原因」更坏）；
//     - 发现层仍只跑 schema（不解析）：行 id 可寻址性只有真解析才知道，
//       这里才是判据的所在地。
//
// 模块级可变态归属（CONVENTIONS §1.10）：userPatchRegistry / cache 属第 3 类
// （键控自清理——用户层 hash 变化即整表失效，无跨工作区所有权问题）。

import { loadSettings, saveSettings } from '../settings';
import { useCompositionStore } from '../state/composition-store';
import { usePresetStore } from '../state/preset-store';
import { onCapabilityContributionsChanged } from './capability-service';
import { builtinPresetById, type PresetEntry, resolvePresetComposition } from './presets';
import { onPromptContributionsChanged } from './prompt-service';
import { type CompositionPatch, factoryComposition, type ResolvedComposition, resolveRoster } from './roster';
import { onToolContributionsChanged } from './services';

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
 *  失效；键含 preset patch 内容 hash → discovery 重扫（内容变）自动失效；
 *  S4-4 甲起键含贡献代数——插件行/段进组合解析域后，贡献 register/dispose
 *  = 组合输入变更（代数递增 → 新键 → 新解析）。A-3（2026-08-24）：capability
 *  贡献是第三条代数挂点（capabilities 域同属解析域快照）。 */
const cache = new Map<string, ResolvedComposition>();
let lastUserHash = '';

// ── 贡献变更代数（S4-4 甲）──
// factoryComposition() 快照通道装载态进解析域——贡献 register/dispose 即
// 组合输入变更。模块级单键订阅（CONVENTIONS §1.10 第 3 类——plugin-
// tool-rows 的 instanceCache 清理同款先例）：代数递增使 cache 全键失效
// （同用户层 hash 变化的整表失效语义）。bootShell 另经 reapplyComposition
// 把重解析结果回写 composition-store（共享注册表/诊断面读它）。
let contributionsGeneration = 0;
onToolContributionsChanged(() => contributionsGeneration++);
onPromptContributionsChanged(() => contributionsGeneration++);
onCapabilityContributionsChanged(() => contributionsGeneration++);

/** 按 id 取生效 preset 条目（内置优先 → 用户目录；找不到 = undefined）。
 *  内置同 id 胜的判定与 discovery 侧一致（earlier root wins）。 */
function findPresetById(id: string): PresetEntry | undefined {
  return builtinPresetById(id) ?? usePresetStore.getState().roster.find((p) => p.id === id && !p.builtin);
}

/** 当前生效组合解析入口（§2.2 装配粒度：workspace Agent 装配 / 占位 Agent /
 *  子 Agent 三处读同一默认 preset）。
 *
 *  presetId 缺省 = preset-store.selected（boot 经 settings 同步的运行时真源）。
 *  返回引用稳定：同 (presetId, 用户层内容, preset 内容, 贡献代数) 的多次
 *  调用返回同一对象。
 *
 *  ⚠ 可抛出（CompositionPatchError：行 id 不可寻址）——生产路径一律走
 *  effectiveComposition()（捕获网）；本函数保留抛出语义供校验与测试用。 */
export function resolveCurrentComposition(presetId?: string): ResolvedComposition {
  const id = presetId ?? usePresetStore.getState().selected;
  const userPatch = userPatchRegistry.patch;
  const userHash = hashJson(userPatch);
  if (userHash !== lastUserHash) {
    cache.clear(); // 用户层内容变更 → 全表失效（R13：改用户层后新装配用新组合）
    lastUserHash = userHash;
  }
  const roster = usePresetStore.getState().roster.filter((p) => !p.builtin);
  const preset = findPresetById(id);
  const key = id + ':' + userHash + ':' + hashJson(preset?.patch ?? null) + ':' + contributionsGeneration;
  const hit = cache.get(key);
  if (hit) return hit;
  const resolved = resolvePresetComposition(id, { userPatch, userPresets: roster });
  if (cache.size >= 32) cache.clear(); // 防御性上限（preset 数量级远小于此）
  cache.set(key, resolved);
  return resolved;
}

// ── F1 捕获网：校验 + 安全解析 + 错误可见 ──

/** preset 层解析失败原因（null = 可解析）。两类判据：
 *  1. 条目存在但本体装载失败（patch === null——YAML/校验错，发现层已标 broken）
 *     → 直接不可用（选中它只会静默回退出厂组合，等于「选了没生效」）；
 *  2. 行 id / 段 id / seam id 不可寻址 → 用真实出厂组合做一次解析才知道
 *     （发现层只跑 schema，这是判据的唯一所在地）。 */
export function selectionError(presetId?: string): string | null {
  const id = presetId ?? usePresetStore.getState().selected;
  const entry = findPresetById(id);
  if (entry && entry.patch === null) {
    return entry.error ?? 'preset 不可用（roster.patch.yml 装载失败）';
  }
  try {
    resolveCurrentComposition(id);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 该组合 id 是否在册（内置表或用户目录发现结果）。
 *  卷恢复期的可见性判据：未知 id（preset 被删/改名）与不可解析（行 id 失效 /
 *  对应插件被禁用）是两类不同的失败，都要能说出来——否则用户只看到"组合变了"
 *  却不知道为什么。 */
export function isPresetKnown(presetId: string): boolean {
  return findPresetById(presetId) !== undefined;
}

/** 记录/清除 preset 层失败原因（preset-store.error 唯一写入口）。
 *  只在**内容变化**时写 store + 落 console（坏 preset 在每卷装配都会被问一次，
 *  不去重会刷屏）。错误不静默：解析侧回退组合，原因留在 store 里给 UI。 */
function noteSelectionError(err: string | null): void {
  const st = usePresetStore.getState();
  if (err === null) {
    if (st.error !== null) st.setError(null);
    return;
  }
  if (st.error === err) return;
  st.setError(err);
  console.error('[preset] preset 层解析失败（已回退用户层组合）:', err);
}

/** 生产解析入口（永不抛出——F1 捕获网）：失败 → 回退「只叠用户层」的组合
 *  （= resolvePresetComposition 对 patch 为 null 的同款兜底语义），原因经
 *  preset-store.error 可见。会话工厂 / boot 应用面 / 贡献变更重应用一律走这里。 */
export function effectiveComposition(presetId?: string): ResolvedComposition {
  const id = presetId ?? usePresetStore.getState().selected;
  const err = selectionError(id);
  noteSelectionError(err);
  if (err === null) return resolveCurrentComposition(id);
  return resolveRoster(factoryComposition(), [userPatchRegistry.patch ?? {}]);
}

/** cache 失效入口（测试用——生产路径经内容 hash/贡献代数变化自然失效）。 */
export function invalidatePresetCache(): void {
  cache.clear();
  lastUserHash = '';
}

/** 贡献变更后的组合重应用（S4-4 甲——bootShell 的贡献监听调用）。
 *  解析域含通道贡献快照：贡献 register/dispose 后 composition-store 的
 *  resolved 已过时（workspace 共享注册表/UI 诊断面仍读它）——按当前
 *  选择重解析回写。error 态跳过（错误可见优先，不被贡献变更悄悄改写）；
 *  factory 态重新快照（resetToFactory 内的 factoryComposition() 收当前
 *  贡献）。会话级新鲜度不依赖本函数：session factory 每会话经
 *  effectiveComposition 现解析（cache 代数失效），贡献变后新会话必然拿到新面。
 *  F1/F5（2026-09-15）：解析走捕获网（坏 preset 不穿出去）+ 走
 *  applySelectionToStore（非空 preset 层在 factory 态也照样应用——旧实现
 *  在此分支 resetToFactory 会丢掉 preset 层，诊断面与运行面分歧）。 */
export function reapplyComposition(): void {
  const store = useCompositionStore.getState();
  if (store.status === 'error') return;
  applySelectionToStore();
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

/** 把当前选择解析结果落进 composition-store（F5 修复，2026-09-15）。
 *  动机：设置面板「组合」节的只读诊断（用户层 patch 状态 / 禁用行）与 seam
 *  裁剪面（applySeamDisabled 的唯一灌入点是本 store 的三个 setter）都读
 *  composition-store，而 selectPreset 此前只改 preset-store + settings →
 *  切完 preset 后诊断面显示的是上一个组合、seam 裁剪要重启才追得上，
 *  「选了却没生效」的假象由此而来（审计 F5）。
 *  语义（与 boot 的应用面一致）：
 *    - error 态跳过（错误可见优先，不被选择变更悄悄改写）；
 *    - 选择不可解析（F1：行 id 不可寻址）→ 跳过——store 保持
 *      loadCompositionPatch 的产物，**不给回退产物冠以 preset origin**；
 *    - 空 patch（standard）且无用户层 → 回退出厂态（保持 factory 语义零漂移）；
 *    - 其余 → setResolved（含 seamDisabled 灌入 + 诊断面刷新）。 */
function applySelectionToStore(): void {
  const comp = useCompositionStore.getState();
  if (comp.status === 'error') return;
  const selected = usePresetStore.getState().selected;
  const err = selectionError(selected);
  noteSelectionError(err);
  if (err !== null) return;
  const patch = findPresetById(selected)?.patch;
  const empty = !patch || Object.keys(patch).length === 0;
  if (empty && registeredUserPatch() === null) {
    comp.resetToFactory();
    return;
  }
  const origin = empty
    ? comp.patchOrigin
    : comp.patchOrigin
      ? comp.patchOrigin + ' + preset:' + selected
      : 'preset:' + selected;
  useCompositionStore.getState().setResolved(effectiveComposition(selected), origin);
}

/** 切换 preset（设置面板选择器入口）：先校验可解析（F1b 捕获网）→ store 同步
 *  → 组合面立即重解析回写（F5，含诊断面与 seam 裁剪）→ settings 持久化。
 *  生效时机（§2.1）：装配作用域（tools/prompt/capabilities）下次装配生效；
 *  壳作用域（shell 域条目）重启生效（壳行无 dispose 语义，S2 裁定不变）。
 *  返回 false = **拒绝切换**（preset 不可解析——原因进 preset-store.error，
 *  旧选择与 settings 都不动；「选了却静默回退」比「拒绝并说明原因」更坏）
 *  或 settings 写失败（store 已切——内存态先行，持久化失败可见，下次启动回退旧值）。 */
export function selectPreset(presetId: string): boolean {
  const err = selectionError(presetId);
  if (err !== null) {
    noteSelectionError(err);
    return false;
  }
  usePresetStore.getState().select(presetId);
  noteSelectionError(null);
  applySelectionToStore();
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
 *  - 未知 id（非 standard）console.warn 可见（不静默吞选择错误）；
 *  - preset 层不可解析（行 id 不可寻址）→ 跳过 + 原因进 preset-store.error
 *    （F1 捕获网：boot 期不再抛错穿到 bootShell——旧行为会让 10 条壳行
 *    全不 boot，空壳且只落 console）。
 *  永不抛出。 */
export function applyDefaultPreset(): void {
  const comp = useCompositionStore.getState();
  if (comp.status === 'error') return;
  const { selected } = usePresetStore.getState();
  const preset = findPresetById(selected);
  if (!preset && selected !== 'standard') {
    console.warn('[composition] 未知/损坏 preset "' + selected + '"——保持用户层组合');
  }
  const patch = preset?.patch;
  if (!patch || Object.keys(patch).length === 0) return; // 空 patch = 无增量 = 不触碰
  // F1 捕获网：不可解析（行 id 不可寻址——写错 id / 对应插件被禁用）→ 保持
  // loadCompositionPatch 的产物（用户层组合）+ 原因可见；**不写** preset 层
  // 产物（否则 origin 会谎报 preset:X，且回退产物被当成选择结果）。
  const err = selectionError(selected);
  noteSelectionError(err);
  if (err !== null) return;
  const resolved = resolveCurrentComposition(selected);
  const origin = comp.patchOrigin ? comp.patchOrigin + ' + preset:' + selected : 'preset:' + selected;
  useCompositionStore.getState().setResolved(resolved, origin);
}
