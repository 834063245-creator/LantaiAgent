// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// preset 数据模型（S4-0）—— 命名的 ResolvedComposition 工厂（设计件
// docs/plans/composition-architecture/designs/S4-preset-realm-distribution.md §2.1）。
//
// Preset = 命名的行组合：同一份 S2 patch schema（roster.patch.yml）+ 显示
// 元数据（preset.yml，纯展示）。与用户层 patch 的差别只在层序：
//   factory → 用户层 patch（~/.lantai/composition/roster.patch.yml）
//          → preset patch（composition/presets/<id>/roster.patch.yml）
// preset 是最上层——用户层表达「这台机器的基线」，preset 表达「这个会话的
// 裁剪」，裁剪叠加在基线之上（同 id 后写胜前写，S2 语义零改动）。
//
// 信任模型二分（DSH 同构）：
//   - system preset：代码常量（本文件内置表），不落盘——「factory 层不出
//     yml」同一裁定；内置 id 是部署事实，用户不可影子化（同 id 内置胜）；
//   - user preset：~/.lantai/composition/presets/<id>/ 目录，经 discovery
//     （preset-discovery.ts）发现后进 preset-store。
//
// shell 域说明：preset 对会话有意义的是 tools/prompt/capabilities 三域
// （§2.1 生效面）。壳行禁用是应用级决策（壳引导一次性的）——user preset
// 文件里写 shell 域条目照样会被 resolveRoster 解析（S2 引擎零新语义，
// 域合法性由 schema 层保证）。V5 拆除（2026-08-22）：paper preset 行
// 退役——纸壳是唯一主界面，主视图落点不再经 preset 分叉（启动落点
// 恒为案卷首页，2026-08-22 用户拍板）。
//
// 解析纯函数（本文件）不 fetch 不读盘——远端发现是 preset-discovery 的
// 职责（与 roster.ts 不 parse yaml 同一分工纪律）。

import { type CompositionPatch, factoryComposition, type ResolvedComposition, resolveRoster } from './roster';

/** preset id 规则（DSH PRESET_ID 同款）：`/^[a-z0-9][a-z0-9-]*$/`。
 *  id 是 URL 路径段（/composition/presets/<id>/…），这是围栏规则不是
 *  风格规则——`..` / 分隔符 / 绝对名会把组合挪出授权根。 */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 校验 preset id 形状（discovery 侧对索引条目逐个把关）。 */
export function isValidPresetId(id: string): boolean {
  return PRESET_ID_RE.test(id);
}

/** preset 显示元数据（preset.yml）——纯展示，装载失败降级为无元数据
 *  不拒载（§2.1 目录形态）。 */
export interface PresetMetadata {
  name: string;
  description?: string;
  order?: number;
}

/** 发现层的一个 preset 条目（内置行或用户目录行，统一形状）。
 *  roster 为 broken 时该 preset 占 id 但拒绝装载（DSH discovery 同款：
 *  发现成功 ≠ 组合可用，坏 preset 不炸发现）。 */
export interface PresetEntry {
  id: string;
  /** 内置（system）标记——与 user 同 id 时内置胜（earlier root wins）。 */
  builtin: boolean;
  metadata?: PresetMetadata;
  /** 已成功 parse 的 patch（zod 校验后）；broken = null。 */
  patch: CompositionPatch | null;
  /** roster.patch.yml 装载失败原因（patch = null 时可见）。 */
  error?: string;
}

/** 内置 system preset 表（§2.1）——代码常量，不落盘。
 *  表序 = 设置面板呈现序（stable；user preset 按 id 排序附后）。 */
const BUILTIN_PRESETS: Array<{
  id: string;
  metadata: PresetMetadata;
  patch: CompositionPatch;
}> = [
  {
    id: 'standard',
    metadata: { name: 'standard', description: '出厂组合（零 patch）' },
    patch: {},
  },
  {
    id: 'minimal',
    metadata: {
      name: 'minimal',
      description: '精简面：禁 browser/desktop、web、图 hooks 等重装备',
    },
    patch: {
      tools: [
        { id: 'builtin/browser-desktop', disabled: true },
        { id: 'builtin/web', disabled: true },
      ],
      capabilities: [{ id: 'graph-hooks', disabled: true }],
    },
  },
];

/** 内置 preset 清单（只读快照；每行返回同一 patch 对象——resolveRoster
 *  纯函数不 mutate patch，浅共享安全）。 */
export function builtinPresets(): PresetEntry[] {
  return BUILTIN_PRESETS.map((p) => ({
    id: p.id,
    builtin: true,
    metadata: p.metadata,
    patch: p.patch,
  }));
}

/** 按 id 取内置 preset；无则 undefined。 */
export function builtinPresetById(id: string): PresetEntry | undefined {
  const found = BUILTIN_PRESETS.find((p) => p.id === id);
  if (!found) return undefined;
  return { id: found.id, builtin: true, metadata: found.metadata, patch: found.patch };
}

/**
 * preset 组合解析主入口（纯函数，§2.1 层序）。
 *
 * resolvePresetComposition(presetId, userPatch) ≡
 *   resolveRoster(factory, [userPatch ?? {}, presetPatch])
 * 其中 presetPatch 按序查：内置表 → userPreset（discovery 产物）。
 * 未知 id / broken preset / 空 userPreset 表 → 出厂组合（factory，
 * 非错误——preset 选择落在缺省 standard 上是常态路径）。
 *
 * 注意与 loadCompositionPatch 的错误语义分工：用户层 patch 坏 → store
 * error + factory 兜底（S2 all-or-nothing 可见面）；preset 坏 → 静默
 * factory（discovery 已把 error 记进 PresetEntry.error 可见，装配侧
 * 不重复弹错——「占 id 但拒绝装载」）。
 */
export function resolvePresetComposition(
  presetId: string,
  opts: { userPatch?: CompositionPatch | null; userPresets?: PresetEntry[] } = {},
): ResolvedComposition {
  const preset = builtinPresetById(presetId) ?? opts.userPresets?.find((p) => p.id === presetId && !p.builtin);
  const presetPatch = preset?.patch;
  if (!presetPatch) {
    // 未知 id / broken preset → 忽略 preset 层，只叠用户层（可能为空 = 恒等）
    return resolveRoster(factoryComposition(), [opts.userPatch ?? {}]);
  }
  return resolveRoster(factoryComposition(), [opts.userPatch ?? {}, presetPatch]);
}
