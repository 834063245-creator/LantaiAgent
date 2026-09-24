// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 批 9g-1 归家（2026-09-26）：第一方段文案随包 ⇒ 本包**不再经宿主桥取内容**
// （内容就是本包自己的文件 `./sections`）。
//
// 契约面（`PromptSection` / `PromptSectionContext` 类型 + `assembleSystemPrompt`）仍在内核
// `composition/prompt-sections.ts`——本包按需 type-only 取用；本文件保留为薄入口以便
// 名册 `hostModule: 'host'` 的双走查契约不变（host.aliased 同为空壳）。
export type { PromptSection, PromptSectionContext } from '../../../composition/prompt-sections';
