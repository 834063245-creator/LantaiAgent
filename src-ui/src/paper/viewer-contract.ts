// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/viewer-contract — 查看器**契约面**（批 8a，2026-09-25）：`ViewerDef` / `ViewerProps`
// 一族从产物 `plugins/builtin/renderers/viewer-registry.ts` **原样上收**内核。
//
// 为什么上收（实测病灶）：内核重查看器（`app/paper/viewers/*`——pdf / model3d / ipynb /
// markdown-doc，pdfjs 与 three 只能随应用 bundle 真分片）拿的 props 形状由产物定义 ⇒
// **内核 app 反向依赖产物包**，且 `model3d.tsx:69` 引的是**值** `normalizeExt`，环不止类型层。
// 形状是两侧共享的契约（内核取件面 + 产物注册面），故落内核、两侧各自 import：
// 产物 `viewer-registry.ts` 原样 re-export（产物内部 20 个 viewer 的 import 面零改动）。
//
// 归属：纯类型 + 一个纯函数（无实例身份、零依赖）——CONVENTIONS §1.10 模块级归属第 4 类
// （初始化后只读）。注册表单例 `viewerRegistry` **仍住产物**（它是产物私有机制，不是契约）。

import type { ComponentType } from 'react';
import type { SourcedBlock } from './block-model';

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
  /** 组件本体——产物内直挂的轻查看器（零依赖 / 自绘 / 复用既有原语）。
   *  与 `heavy` **二选一**（装载期拒绝既无实现又双份声明的行）。 */
  component?: ComponentType<ViewerProps>;
  /** 重依赖查看器的**取件键**（P2）：本体在应用 bundle（vite 真分片），
   *  经宿主桥 `loadViewer(id)` 按需取——产物域禁动态裸 import，重依赖进不了产物
   *  （D3 修订）。取件失败 ⇒ 文件壳 + 可读错误（不静默）。 */
  heavy?: string;
}

/** 扩展名归一：小写 + 去前导点（'PNG' / '.png' → 'png'）。 */
export function normalizeExt(ext: string): string {
  return ext.trim().toLowerCase().replace(/^\./, '');
}
