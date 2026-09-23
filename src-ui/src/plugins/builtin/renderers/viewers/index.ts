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
import { epubViewer } from './epub';
import { fontViewer } from './font';
import { geoViewer } from './geo';
import { hexViewer } from './hex';
import { imageViewer } from './image';
import { ipynbViewer } from './ipynb';
import { legacyOfficeViewer } from './legacy-office';
import { mailViewer } from './mail';
import { markdownDocViewer } from './markdown-doc';
import { model3dViewer } from './model3d';
import { officeViewer } from './office';
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
  epubViewer,
  officeViewer,
  legacyOfficeViewer,
  pdfViewer,
  model3dViewer,
  ipynbViewer,
  markdownDocViewer,
  hexViewer,
];

/** 注册出厂查看器（**幂等**：已注册的 id 跳过——同一个表可被多次触发）。
 *
 *  ⚠️ 触发点不是模块顶层，而是 `components.tsx` 的 `assetRendererComponents()`（装配面）：
 *  查看器可以 `import { GridBody } from '../components'` 复用既有原语（office 查看器就这么做），
 *  于是形成 `components → viewers/index → office → components` 的**环**；模块顶层调用会在环里
 *  撞 `BUILTIN_VIEWERS` 的 TDZ（Cannot access before initialization）。挪到装配点后，
 *  环上的模块先各自求值完，再注册。 */
export function registerBuiltinViewers(): void {
  for (const def of BUILTIN_VIEWERS) {
    if (!viewerRegistry.get(def.id)) viewerRegistry.register(def);
  }
}
