// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// viewer-registry — 资产**文件查看器**注册面（渲染面补全 B1，2026-09-23）。
//
// 定位：把 `media` 这一个表现原语从「图片 + 视频」扩成**按扩展名路由的查看器面**
// ——查看器一件一文件（`viewers/`），宿主（components.tsx 的 MediaBody）只做
// 「查表分发 + 降级 + 公共壳」。与 agent/asset-kinds.ts 同构（id + 认领表 +
// 装载期拒绝 + disposer 幂等/陈旧守卫），区别是它住在渲染产物域（插件侧），
// 不是 agent 层的纯数据面。
//
// 降级链（错误即导航，不静默降级；对齐 resolveAssetBlock 的既有纪律）：
//   ext 命中查看器   → 用它；
//   ext 未命中       → 通用文件壳（B1 前行为，零变化）；
//   命中但字节读失败 / 超 maxBytes / 渲染抛错 → **文件壳 + 一行可读错误**（带窗：
//   说清哪个文件、哪一步）。**注册面缺失绝不等于「给你看 JSON」**。
//
// 读取形态（B2 起两态）：`bytesKind: 'data-uri'`（缺省，媒体：fs_cap read_base64）
// 与 `'text'`（文本查看器：fs_cap read 按 `readLines` 开行窗口——不整份进 IPC）。
// 扩展名分类真源 = `paper/viewer-exts.ts`（宿主层单一真源，测高与认领共表）。
//
// 重依赖查看器（pdf / mermaid / 3d）**不在本注册面的产物侧**：产物域禁动态裸
// import（scripts/build-builtin-plugins.mjs 的自包含闸），故重依赖本体走应用 bundle
// 分片、经宿主桥取——B2 批引入 `heavy` 通道时在此扩字段（施工单 §3.1/§3.2）。
//
// 模块级归属（CONVENTIONS §1.10）：`viewerRegistry` 是进程级注册表单例，内置查看器
// 在 `viewers/index.ts` **模块装载期**注册（同 asset-kinds.ts 尾部的
// registerBuiltinAssetKinds() 先例）；第三方查看器经 register 返回的 disposer 对称清理。

import type { ComponentType } from 'react';
import type { SourcedBlock } from '../../../paper/block-model';

/** 查看器拿到的字节。媒体类走 data URI；文本类查看器走原始字符串（B2 批引入）。 */
export type ViewerBytes = { kind: 'data-uri'; value: string } | { kind: 'text'; value: string };

/** 载体（D2 定案：本批只做流内块 + 浮层放大；钉到纸/右侧面板各有独立交互课题，
 *  接口留位——查看器组件按 mode 收敛渲染面，不自持载体状态）。 */
export type ViewerMode = 'stream' | 'overlay' | 'pinned' | 'panel';

export interface ViewerProps {
  block: SourcedBlock;
  /** 宿主算好的题名/文件名（壳的题名行与查看器的 alt 共用一份判据） */
  label: string;
  /** 宿主归一后的扩展名（小写无点；查看器据此挑高亮语言/解析器，不再自己读 payload） */
  ext: string;
  filePath?: string;
  /** needsBytes 且未超限时给：媒体 = data URI，文本查看器 = 行窗口内的原文 */
  bytes?: ViewerBytes;
  mode: ViewerMode;
  /** 放大入口（「点击看大图」语义）：查看器只负责触发，浮层由宿主渲染 */
  onOpenOverlay?: () => void;
}

export interface ViewerDef {
  /** 机器名（'image' / 'video' / 'audio' / 'code' / 'pdf' …）——重名**装载期拒绝** */
  id: string;
  /** 认领的扩展名（小写无点；装载期归一；跨查看器重名**装载期拒绝**）。
   *  分类真源 = `paper/viewer-exts.ts`（宿主层单一真源：测高与认领共用一张表）。
   *  `catchAll` 查看器例外：无认领表（它接的是「谁都没认领」那一档）。 */
  exts: readonly string[];
  /** 兜底认领（B8）：ext 未命中任何查看器时交给它——全注册面**至多一个**（装载期拒绝第二个）。
   *  兜底者必须 `needsBytes`（要嗅探内容才能决定怎么显示）。 */
  catchAll?: boolean;
  /** ext → MIME（`bytesKind: 'data-uri'` 时每个 ext 必填——缺了宿主拼不出 data URI，装载期拒绝）。
   *  兜底查看器例外：接任意扩展名，宿主缺 MIME 时按 `application/octet-stream` 兜。 */
  mimes?: Readonly<Record<string, string>>;
  /** 要不要读文件字节；false = 只看路径与元数据 */
  needsBytes: boolean;
  /** 字节形态（缺省 'data-uri' = 媒体）：
   *  - `'text'`：文本查看器，宿主走 `fs_cap read` 按 `readLines` 开行窗口（不整份进 IPC）；
   *  - `'auto'`：**先文本窗口、失败再二进制**（兜底查看器用：未知扩展名大多是文本，
   *    文本路径有界且零 base64 膨胀；只有真二进制才付 read_base64 的代价）。
   *    需要 `readLines`；`mimes` 可选（缺 MIME 时宿主按 application/octet-stream 兜）。 */
  bytesKind?: 'data-uri' | 'text' | 'auto';
  /** 行窗口（**text / auto 必填**）：宿主读 `readLines + 1` 行、查看器显示前 `readLines` 行，
   *  末行是否存在即「文件更长」的判据（截断必须可见，不静默）。 */
  readLines?: number;
  /** 体积上限（超出 → 文件壳 + 可读错误，**不静默截断**）；缺省 = 不设限。
   *  文本查看器上它是**近似值**（按窗口文本字符数判），文案里如实说「约」。 */
  maxBytes?: number;
  /** 组件本体——B1 只有产物内直挂的轻查看器（零依赖/自绘/复用既有原语） */
  component: ComponentType<ViewerProps>;
}

/** 扩展名归一：小写 + 去前导点（'PNG' / '.png' → 'png'）。 */
export function normalizeExt(ext: string): string {
  return ext.trim().toLowerCase().replace(/^\./, '');
}

class ViewerRegistry {
  private defs = new Map<string, ViewerDef>();
  private byExt = new Map<string, ViewerDef>();
  private fallback: ViewerDef | null = null;

  /** 注册查看器并返回所有权清理器（对齐 ContributionChannel / asset-kinds 纪律：
   *  重名装载期拒绝；disposer 幂等 + 陈旧守卫——同 id 重注册后旧 disposer 不误删新行）。 */
  register(def: ViewerDef): () => void {
    if (!def.id) throw new Error('[viewer-registry] 查看器 id 不能为空');
    if (this.defs.has(def.id)) {
      throw new Error(`[viewer-registry] 重复注册查看器 "${def.id}" —— 装载期拒绝，不静默覆盖`);
    }
    if (def.catchAll && !def.needsBytes) {
      throw new Error(`[viewer-registry] 兜底查看器 "${def.id}" 必须 needsBytes（不读字节无从嗅探内容）`);
    }
    if (def.catchAll && this.fallback) {
      throw new Error(
        `[viewer-registry] 兜底查看器只能有一个：已有 "${this.fallback.id}"，又来了 "${def.id}" —— 装载期拒绝`,
      );
    }
    const exts = [...new Set(def.exts.map(normalizeExt).filter((e) => e.length > 0))];
    if (exts.length === 0 && !def.catchAll) {
      throw new Error(`[viewer-registry] 查看器 "${def.id}" 未认领任何扩展名（空认领 = 永远不会被命中）`);
    }
    if (def.maxBytes != null && !(def.maxBytes > 0)) {
      throw new Error(`[viewer-registry] 查看器 "${def.id}" 的 maxBytes 必须是正数（收到 ${def.maxBytes}）`);
    }
    const text = def.bytesKind === 'text';
    const auto = def.bytesKind === 'auto';
    if ((text || auto) && !def.needsBytes) {
      throw new Error(
        `[viewer-registry] 查看器 "${def.id}" 声明 bytesKind:'${def.bytesKind}' 但 needsBytes=false —— 不读字节就没有内容`,
      );
    }
    if ((text || auto) && !(Number.isInteger(def.readLines) && (def.readLines as number) > 0)) {
      throw new Error(
        `[viewer-registry] 查看器 "${def.id}" 是『${def.bytesKind}』形态但缺 readLines（正整数）——行窗口是不整份进 IPC 的唯一闸`,
      );
    }
    if (!text && !auto && def.readLines != null) {
      throw new Error(
        `[viewer-registry] 查看器 "${def.id}" 声明了 readLines 但不是 text/auto 形态（bytesKind=${def.bytesKind ?? 'data-uri'}）`,
      );
    }
    for (const ext of exts) {
      const owner = this.byExt.get(ext);
      if (owner) {
        throw new Error(
          `[viewer-registry] 扩展名 "${ext}" 被两个查看器认领：先 "${owner.id}" 后 "${def.id}" —— 装载期拒绝（路由必须唯一）`,
        );
      }
      if (def.needsBytes && !text && !auto && !def.mimes?.[ext]) {
        throw new Error(
          `[viewer-registry] 查看器 "${def.id}" 需要字节但缺 "${ext}" 的 MIME —— 宿主拼不出 data URI；补 mimes.${ext}`,
        );
      }
    }
    this.defs.set(def.id, def);
    for (const ext of exts) this.byExt.set(ext, def);
    if (def.catchAll) this.fallback = def;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.defs.get(def.id) === def) this.defs.delete(def.id);
      for (const ext of exts) if (this.byExt.get(ext) === def) this.byExt.delete(ext);
      if (this.fallback === def) this.fallback = null;
    };
  }

  /** 按扩展名解析查看器（大小写/点号宽容；未认领 = undefined）。 */
  resolve(ext: string | undefined): ViewerDef | undefined {
    if (!ext) return undefined;
    return this.byExt.get(normalizeExt(ext));
  }

  /** 兜底查看器（B8）：`resolve` 未命中时的接盘者（缺省 = 无 → 宿主走文件壳）。 */
  catchAll(): ViewerDef | undefined {
    return this.fallback ?? undefined;
  }

  get(id: string): ViewerDef | undefined {
    return this.defs.get(id);
  }

  list(): ViewerDef[] {
    return [...this.defs.values()];
  }

  /** 已认领的扩展名（排序）——未知扩展名的报错窗用它（错误即导航）。 */
  supportedExts(): string[] {
    return [...this.byExt.keys()].sort();
  }
}

/** 全局查看器注册表（单例；内置表在 viewers/index.ts 模块装载期注册）。 */
export const viewerRegistry = new ViewerRegistry();
