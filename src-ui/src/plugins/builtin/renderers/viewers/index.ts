// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 出厂查看器表（渲染面补全 B1/B2，2026-09-23）——B1：图片 / 视频（自 MediaBody 迁入，
// 行为等价）+ 音频（新增格式）；B2：代码 / 文本（hljs 高亮 + 行号 + 行窗口截断）。
// 后续批次逐条增补（PDF / Office / 数据 / 归档 / 3D / 字体 / 电子书 / 科研 / 字幕 /
// 邮件 / Markdown 目录）。
//
// 注册时机 = **模块装载期一次**（同 agent/asset-kinds.ts 尾部 registerBuiltinAssetKinds
// 先例）：注册面是冻结路由表（模块级归属第 4 类），不随 cordis 装配重复注册——
// 重名会在装载期 throw（装配断层当场可见，不静默覆盖）。

import { type ViewerDef, viewerRegistry } from '../viewer-registry';
import { audioViewer } from './audio';
import { codeViewer } from './code';
import { imageViewer } from './image';
import { videoViewer } from './video';

/** 出厂查看器表（顺序 = 注册序；路由按扩展名唯一，互不重叠）。 */
export const BUILTIN_VIEWERS: readonly ViewerDef[] = [imageViewer, videoViewer, audioViewer, codeViewer];

/** 注册出厂查看器（模块装载期调用一次；重复调用会因重名 throw——防装配双跑）。 */
export function registerBuiltinViewers(): void {
  for (const def of BUILTIN_VIEWERS) viewerRegistry.register(def);
}
