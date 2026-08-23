// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// overlay-store — 单 React 树的覆盖层渲染目标（P3 收编；2026-08 UI 大清扫收缩）。
//
// 历史：曾承载 ContextMenu（右键菜单 portal）与 FileTranslator（文件翻译
// portal）两块覆盖层。C13 sweep 删除 file-translator 后 translator 字段
// 失去消费方；2026-08 UI 大清扫确认 contextMenu 面同样零调用方
// （boot.ts 只 preventDefault 右键、showContextMenu 无调用点、ContextMenu.tsx
// 组件已删）——双死面清除，store 收缩为空态注册点。
//
// 保留文件原因：它是「覆盖层经 store + portal 进单 React 树」的模式锚点
// （tests/eventbus-zero-and-ui-split.test.ts 终态清单钉住文件名）；未来
// 浮层（通知中心 / toast 宿主等）仍应落这里，而不是自建游离 DOM。

import { create } from 'zustand';

type OverlayState = {};

export const useOverlayStore = create<OverlayState>(() => ({}));
