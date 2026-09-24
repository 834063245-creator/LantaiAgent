// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸面块渲染器产物 · 宿主依赖面 · 开发/测试/编译域（批 8b，2026-09-25）。
//
// 双走查（同 renderers / paper-shell 先例）：
//   - 本文件（dev/test/bundle 域）：直连内核真实模块——测试域语义不变；
//   - `host.aliased.ts`（产物域）：esbuild onResolve 把 `./host` 重定向到它，
//     全部能力从宿主桥 `mods.faceDeps` 取**真实例**（产物域无裸 import）。
//   两域形状由 `host.aliased.ts` 的 `typeof import('./host')` 对拍 + 宿主面封印
//   （`host-modules.ts` 的 FaceBridgeSeal）钉住——漂移 = 构建期/测试期红。
//
// 桥什么：**应用层件**（内核 app/ 面，产物不得直连）——
//   `Overlay`（媒体放大浮层）· `useShellStore`（工程路径）· `previewUrlFor` /
//   `readAttachmentBase64`（附图回读）· `MermaidBlock`（重依赖例外：内部 `import('mermaid')`
//   是动态裸 import，产物域构建闸拒绝 ⇒ 组件本体留应用 bundle，产物只做认领 + 降级）。
// 不桥什么：内核 `paper/*` 判据层（markdown / marks / tool-text / fold / translate）是纯函数，
// 按名册 `shared` 相对 import 随包内联（同 `viewer-exts` / `block-model` 先例）；
// 类型面（`BlockRendererProps` / `MdBlock` / `PlanOptionOutcome` …）编译期擦除，直连即可。

export { previewUrlFor, readAttachmentBase64 } from '../../../app/chat/image-intake';
export { Overlay } from '../../../app/overlay';
export { default as MermaidBlock } from '../../../app/paper/mermaid-block';
export { useShellStore } from '../../../app/shell-store';
