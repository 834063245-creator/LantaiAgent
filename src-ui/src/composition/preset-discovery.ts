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

import { parse as parseYaml } from 'yaml';
import { getProxyPort } from '../provider/transport';
import { usePresetStore } from '../state/preset-store';
import { builtinPresets, isValidPresetId, type PresetEntry, type PresetMetadata } from './presets';
import { parseCompositionPatch } from './roster';

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
export async function discoverPresets(opts: DiscoverPresetsOptions = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const origin = opts.origin ?? (await resolveOrigin());
    if (!origin) return; // 无通道（浏览器 mock / 代理未起）——内置表即终态
    const index = await fetchIndex(fetchImpl, origin + '/');
    if (index == null) return; // 索引不可用（404/异常）——非错误，内置表
    const userEntries: PresetEntry[] = [];
    for (const raw of index) {
      if (typeof raw !== 'string') continue;
      if (!isValidPresetId(raw)) continue; // 围栏规则：非法 id 不入列
      if (BUILTIN_IDS.has(raw)) continue; // 内置胜（earlier root wins）
      userEntries.push(await fetchPresetEntry(fetchImpl, origin, raw));
    }
    // 合并：内置表在前（表序呈现），用户行按 id 排序附后（稳定）
    userEntries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    usePresetStore.getState().setRoster([...builtinPresets(), ...userEntries]);
  } catch (e) {
    // 通道级失败：内置表仍在（store 初值），错误可见不打断引导
    console.warn('[presets] 用户层 preset 发现失败:', e);
  }
}

/** 惰性解析通道 origin；'' = 无通道。 */
async function resolveOrigin(): Promise<string> {
  const port = await getProxyPort();
  if (!port) return '';
  return presetsIndexOrigin(port);
}

/** 取索引 JSON 数组；不可用返回 null（404/非数组/异常统一非错误）。 */
async function fetchIndex(fetchImpl: FetchTextLike, url: string): Promise<unknown[] | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const parsed = parseYaml(await res.text());
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
