// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 旧 Office 出口（渲染面补全 P3 · B5 余项，2026-09-23）——doc / xls / ppt。
//
// **不解析**（施工单 D5，四条依据见 §2.1）：旧格式是 OLE 复合二进制，与 OOXML 是两套
// 东西——唯一的 Office 读口（OfficeCLI，B4）只认 OOXML，机器上通常又装着 Office/WPS，
// 所以正解是**移交系统程序**而不是塞第二套解析器。本件因此走 `needsBytes: false`：
// 零 RPC、零字节，只出三行——
//   ① 文件壳（`.pp-media-file` 家族：扩展名 + 路径，与宿主未认领档同貌）；
//   ② 类型标记（doc → 「Word 97-2003 文档」等）；
//   ③ 一行说明：旧格式无法内嵌预览，已提供「用系统程序打开」。
// 「用系统程序打开」按钮由**公共壳**统一提供（`components.tsx::MediaBody` 的
// `.pp-viewer-open-system`，P2 · B5 落位）——本件不自己画按钮（同一出口只有一处实现）。

import { VIEWER_LEGACY_OFFICE_EXTS } from '../../../../paper/viewer-exts';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './legacy-office.css';

/** 旧格式 → 用户可读的类型标记（「哪种旧文件」是这一档唯一能给的信息）。 */
const LEGACY_TYPES: Readonly<Record<string, string>> = {
  doc: 'Word 97-2003 文档',
  xls: 'Excel 97-2003 工作簿',
  ppt: 'PowerPoint 97-2003 演示文稿',
};

/** 文件壳（未认领/无路径时的同一形态；与宿主 components.tsx 的 FileShell 同款）。 */
function LegacyFileShell({ ext, filePath }: { ext: string; filePath?: string }) {
  return (
    <div className="pp-media-file">
      {ext && <span className="pp-media-ext">{ext}</span>}
      <span className="pp-media-path">{filePath ?? ''}</span>
    </div>
  );
}

function LegacyOfficeViewer({ ext, filePath, mode }: ViewerProps) {
  // 放大形态：没有内容可放大（不解析），浮层里再画一遍壳无意义
  if (mode === 'overlay') return null;
  // 无路径 = 没有可移交的文件：与宿主同一降级形态（只出壳，不出类型标记）
  if (!filePath) return <LegacyFileShell ext={ext} />;
  return (
    <div className="pp-viewer-legacy">
      <LegacyFileShell ext={ext} filePath={filePath} />
      <div className="pp-viewer-legacy-type">{LEGACY_TYPES[ext] ?? `旧版 Office 文件（.${ext}）`}</div>
      <div className="pp-viewer-note">旧格式无法内嵌预览，已提供「用系统程序打开」</div>
    </div>
  );
}

export const legacyOfficeViewer: ViewerDef = {
  id: 'legacy-office',
  exts: VIEWER_LEGACY_OFFICE_EXTS,
  // 不解析 = 不读字节：OLE 二进制给不出可读内容（读回来也只是让 DOM 扛一份垃圾）
  needsBytes: false,
  component: LegacyOfficeViewer,
};
