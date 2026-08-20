// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件规范层（WO-S0B）——manifest 与插件对象的宿主无关契约。
// 设计边界（composition 计划 D0 拍板）：manifest 形状设计为将来可迁移的规范层，
// 不耦合 HoloGram 的 UI/RPC 细节；宿主交互面（四 service：panels/commands/
// tools/providers）是 S1 的事，本文件不预设。
//
// 纪律（CONVENTIONS §1.6 defineTool 同款）：一个 zod schema 同时产出运行时校验
// 与 TS 类型（z.infer），禁止手写平行接口后再 as 强转。

import { z } from 'zod';
import type { Context } from '../cordis';

/** 插件唯一 id：npm scope 风格，最多两段（如 hologram/settings）。 */
const PLUGIN_NAME_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)?$/;

/** semver（含 prerelease / build 元数据）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 入口路径字符白名单（URL 安全；回溯/绝对段由 isSafeEntry 拒绝）。 */
const ENTRY_CHARS_RE = /^[a-z0-9._/-]+$/i;

/** entry 合法性：相对 ESM 路径，段非空且不为 . / ..，以 .js/.mjs 结尾。 */
function isSafeEntry(value: string): boolean {
  if (value.startsWith('/') || !/\.(js|mjs)$/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export const PluginManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE, 'name 必须是 npm scope 风格 id（如 hologram/settings）'),
  version: z.string().regex(SEMVER_RE, 'version 必须是 semver（如 1.0.0）'),
  description: z.string().optional(),
  entry: z
    .string()
    .regex(ENTRY_CHARS_RE, 'entry 含非法字符')
    .refine(isSafeEntry, 'entry 必须是相对 ESM 路径（如 entry.js），禁止绝对路径/回溯段/非 js 后缀'),
  /** 依赖的 ctx service 名——装载期校验存在性，缺 → error 状态（WO-S0B）。 */
  inject: z.array(z.string().min(1)).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** 插件对象：apply 只做注册动作；本阶段可注册的只有 cordis 原生能力（effect 等），
 * 四 service 是 S1。装载期禁止任何 UI 副作用（WO-S0B 红线）。 */
export interface HologramPlugin {
  name: string;
  apply(ctx: Context): void | Promise<void>;
}

export type ManifestValidation = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

/** manifest 校验单一入口（loader 与测试共用；错误显式返回，不做静默兜底）。 */
export function validateManifest(raw: unknown): ManifestValidation {
  const result = PluginManifestSchema.safeParse(raw);
  if (result.success) return { ok: true, manifest: result.data };
  const error = result.error.issues
    .map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message)
    .join('; ');
  return { ok: false, error };
}
