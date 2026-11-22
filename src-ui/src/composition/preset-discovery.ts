// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// preset 发现层（S4-0）—— 用户层 preset 目录的读取管道（设计件 §2.2）。
//
// 通道：/composition/presets/ 索引（GET → JSON 数组，过滤含
// roster.patch.yml 的子目录）+ 逐 preset 取 roster.patch.yml（组合本体）
// 与 preset.yml（元数据，装载失败降级为无元数据不拒载）。
//
// 语义（§3 S4-0 验收）：
//   - 坏 preset 目录 = roster 行报 broken 不炸发现（占 id 拒绝装载，
//     DSH discovery 同款）；
//   - 内置 preset 与用户目录同 id → 内置胜（earlier root wins）；
//   - 非法 preset id（围栏规则）不入列；
//   - 无通道 / 404 索引 = 只有内置表（非错误——与 patch-loader 的
//     「没有 patch 不是错误」同款纪律）。
//
// 本文件只发现不解析组合：产出的 PresetEntry.patch 是 zod 校验后的
// 增量，组合解析在 presets.ts 的 resolvePresetComposition（纯函数）。

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getProxyPort } from '../provider/transport';
import { usePresetStore } from '../state/preset-store';
import { builtinPresets, isValidPresetId, type PresetEntry, type PresetMetadata } from './presets';
import { type CompositionPatch, parseCompositionPatch } from './roster';

/** discovery 消费的最小 fetch 文本形状（与 patch-loader 同款，测试可注入）。 */
export type FetchTextLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** 测试注入面。 */
export interface DiscoverPresetsOptions {
  /** 通道 origin（缺省经 llm_proxy_port RPC 解析）。 */
  origin?: string;
  /** fetch 实现（缺省全局 fetch）。 */
  fetchImpl?: FetchTextLike;
}

/** 发现结果——rescan/设置面板必须能区分「扫成功」与「通道失败但保留旧 roster」。
 *  `updated=false` 时 roster 原样不动；`skipped` 记录非法 id / 重复条目。 */
export interface DiscoverPresetsResult {
  ok: boolean;
  updated: boolean;
  /** 本次成功合并后的用户 preset 数；失败时 = 现有 roster 的用户条目数。 */
  userPresetCount: number;
  skipped: string[];
  error?: string;
}

function currentUserPresetCount(): number {
  return usePresetStore.getState().roster.filter((p) => !p.builtin).length;
}

function discoveryFailure(error: string): DiscoverPresetsResult {
  return { ok: false, updated: false, userPresetCount: currentUserPresetCount(), skipped: [], error };
}

/** preset 索引通道 origin（/composition 前缀 + presets 子路径）。 */
export function presetsIndexOrigin(port: number): string {
  return 'http://127.0.0.1:' + port + '/composition/presets';
}

/** 内置 preset id 集合（用户目录撞名时内置胜的判定面）。 */
const BUILTIN_IDS = new Set(builtinPresets().map((p) => p.id));

/** preset.yml 元数据形状（宽松校验：逐字段挑拣，多余键忽略——纯展示数据
 *  不做 strict 拒绝，坏元数据降级为无元数据）。 */
function parseMetadata(raw: unknown): { metadata?: PresetMetadata; error?: string } {
  if (raw == null || typeof raw !== 'object') return {};
  const rec = raw as Record<string, unknown>;
  if (typeof rec.name !== 'string' || rec.name.trim() === '') {
    return { error: 'preset.yml 缺合法 name' };
  }
  const metadata: PresetMetadata = { name: rec.name };
  if (typeof rec.description === 'string') metadata.description = rec.description;
  if (typeof rec.order === 'number' && Number.isFinite(rec.order)) metadata.order = rec.order;
  return { metadata };
}

/** 拉取单个用户 preset 的本体 + 元数据 → PresetEntry（永不 throw）。 */
async function fetchPresetEntry(fetchImpl: FetchTextLike, origin: string, id: string): Promise<PresetEntry> {
  const base = origin + '/' + id;
  // 1) 组合本体（roster.patch.yml）——装载失败 = broken（占 id 拒绝装载）
  let patch: PresetEntry['patch'] = null;
  let error: string | undefined;
  try {
    const res = await fetchImpl(base + '/roster.patch.yml');
    if (res.status === 404) {
      error = 'roster.patch.yml 缺失';
    } else if (!res.ok) {
      error = '通道异常: HTTP ' + res.status;
    } else {
      const text = await res.text();
      try {
        const parsed = parseYaml(text);
        const validated = parseCompositionPatch(parsed);
        if (validated.ok) patch = validated.patch;
        else error = 'patch 校验失败: ' + validated.error;
      } catch (e) {
        error = 'YAML 语法错误: ' + (e instanceof Error ? e.message : String(e));
      }
    }
  } catch (e) {
    error = '读取失败: ' + (e instanceof Error ? e.message : String(e));
  }
  // 2) 元数据（preset.yml）——失败降级为无元数据，不拒载
  let metadata: PresetMetadata | undefined;
  try {
    const res = await fetchImpl(base + '/preset.yml');
    if (res.ok) metadata = parseMetadata(parseYaml(await res.text())).metadata;
  } catch {
    /* 坏元数据 = 无元数据（§2.1：装载失败降级不拒载） */
  }
  return {
    id,
    builtin: false,
    metadata,
    patch,
    error,
  };
}

/** preset 发现主入口（boot 引导期调用；永不 reject）。
 *  完成后写 preset-store.roster（内置 + 用户合并，内置同 id 胜）。 */
export async function discoverPresets(opts: DiscoverPresetsOptions = {}): Promise<DiscoverPresetsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const origin = opts.origin ?? (await resolveOrigin());
    if (!origin) return discoveryFailure('组合通道不可用（浏览器 mock / 代理未起）');
    const fetched = await fetchIndex(fetchImpl, origin + '/');
    if (!fetched.ok) return discoveryFailure(fetched.error);
    const index = fetched.index;
    const userEntries: PresetEntry[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const raw of index) {
      if (typeof raw !== 'string') {
        skipped.push(String(raw));
        continue;
      }
      if (!isValidPresetId(raw)) {
        skipped.push(raw); // 围栏规则：非法 id 不入列，但必须可见
        continue;
      }
      if (BUILTIN_IDS.has(raw)) continue; // 内置胜（earlier root wins）
      if (seen.has(raw)) {
        skipped.push(raw + '（重复索引）');
        continue;
      }
      seen.add(raw);
      userEntries.push(await fetchPresetEntry(fetchImpl, origin, raw));
    }
    // 合并：内置表在前（表序呈现），用户行按 preset.yml.order（缺省 Infinity）
    // 再按 id 排序附后——order 不再只解析不消费。
    userEntries.sort((a, b) => {
      const ao = a.metadata?.order ?? Number.POSITIVE_INFINITY;
      const bo = b.metadata?.order ?? Number.POSITIVE_INFINITY;
      return ao !== bo ? ao - bo : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    usePresetStore.getState().setRoster([...builtinPresets(), ...userEntries]);
    return { ok: true, updated: true, userPresetCount: userEntries.length, skipped };
  } catch (e) {
    // 通道级失败：roster 原样保留，错误由调用方呈现（不再只落 console）。
    console.warn('[presets] 用户层 preset 发现失败:', e);
    return discoveryFailure(e instanceof Error ? e.message : String(e));
  }
}

/** 惰性解析通道 origin；'' = 无通道。 */
async function resolveOrigin(): Promise<string> {
  const port = await getProxyPort();
  if (!port) return '';
  return presetsIndexOrigin(port);
}

/** patch 增量 → YAML 文本（**作者面**模板生成用；与 discovery 的解析同源同包）。
 *
 *  为什么在核心里：`settings-domain` 的「新建组合」作者面已随批 1 归家进产物包，
 *  而**产物不得裸 import**（自包含契约——`yaml` 是裸包），故序列化留内核、
 *  经 faceDeps 取用（与 roster 解析同一份 yaml 依赖，编码/缩进语义单点）。
 *  手拼 YAML 是明确否掉的旧路：转义/缩进差异会造出不可解析的 patch 文件。 */
export function stringifyPatchYaml(patch: unknown): string {
  return `${stringifyYaml(patch, { lineWidth: 0 }).trimEnd()}\n`;
}

/** YAML 文本 → 校验后的 patch（创作者工具 composition(validate/write) 的判据面）。
 *  与 discovery 的解析同源同包：语法错与 schema 错都**具名返回**、不抛不改写；
 *  行 id 可寻址性不在这里判（要真解析组合才知道，归 preset-assembly 的尺子）。 */
export function parsePatchYamlText(text: string): { ok: true; patch: CompositionPatch } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    return { ok: false, error: 'YAML 语法错误: ' + (e instanceof Error ? e.message : String(e)) };
  }
  return parseCompositionPatch(parsed);
}

/** 取索引 JSON 数组；不可用返回具名错误（404/非数组/网络异常）。 */
async function fetchIndex(
  fetchImpl: FetchTextLike,
  url: string,
): Promise<{ ok: true; index: unknown[] } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { ok: false, error: 'preset 索引不可用: HTTP ' + res.status };
    const parsed = parseYaml(await res.text());
    if (!Array.isArray(parsed)) return { ok: false, error: 'preset 索引不是数组' };
    return { ok: true, index: parsed };
  } catch (e) {
    return { ok: false, error: 'preset 索引读取失败: ' + (e instanceof Error ? e.message : String(e)) };
  }
}
