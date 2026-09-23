// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 出厂查看器表（渲染面补全 P1，2026-09-23）——B1：图片 / 视频（自 MediaBody 迁入，
// 行为等价）+ 音频；B2：代码 / 文本（hljs）；P1 轻查看器总装：表格 / 归档 / 兜底（hex·文本嗅探）
// / 结构化树 / 字体 / 字幕 / 邮件 / 化学 / 地理。
// 后续批次增补：P2（PDF / Mermaid / 3D，经宿主桥 loadViewer）· P3（Office / epub / ipynb /
// Markdown 独立查看）。
//
// 注册时机 = **模块装载期一次**（同 agent/asset-kinds.ts 尾部 registerBuiltinAssetKinds
// 先例）：注册面是冻结路由表（模块级归属第 4 类），不随 cordis 装配重复注册——
// 重名会在装载期 throw（装配断层当场可见，不静默覆盖）。

import { type ViewerDef, viewerRegistry } from '../viewer-registry';
import { archiveViewer } from './archive';
import { audioViewer } from './audio';
import { chemViewer } from './chem';
import { codeViewer } from './code';
import { fontViewer } from './font';
import { geoViewer } from './geo';
import { hexViewer } from './hex';
import { imageViewer } from './image';
import { mailViewer } from './mail';
import { model3dViewer } from './model3d';
import { pdfViewer } from './pdf';
import { subtitleViewer } from './subtitle';
import { tableViewer } from './table';
import { treeViewer } from './tree';
import { videoViewer } from './video';

/** 出厂查看器表（顺序 = 注册序；路由按扩展名唯一，互不重叠；`hex` 是兜底认领，放最后）。 */
export const BUILTIN_VIEWERS: readonly ViewerDef[] = [
  imageViewer,
  videoViewer,
  audioViewer,
  codeViewer,
  chemViewer,
  geoViewer,
  tableViewer,
  treeViewer,
  archiveViewer,
  fontViewer,
  subtitleViewer,
  mailViewer,
  pdfViewer,
  model3dViewer,
  hexViewer,
];

/** 注册出厂查看器（模块装载期调用一次；重复调用会因重名 throw——防装配双跑）。 */
export function registerBuiltinViewers(): void {
  for (const def of BUILTIN_VIEWERS) viewerRegistry.register(def);
}
