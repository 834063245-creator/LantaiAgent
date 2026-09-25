// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// skill-domain 产物 · 宿主依赖面 · 开发/测试/编译域（批 9h-3，2026-09-26）。
//
// 技能域实现（扫描器 + 出厂技能内容 + Skill 工具工厂）随包后仍要用内核的：
//   - `rpc-contract` 三值：`kernelGlobalMemoryDir`（用户级 `~/.lantai` 推导）·
//     `kernelListDirectoryFlat`（列举技能目录）· `kernelReadFile`（读 SKILL.md）；
//   - `defineTool`（工具定义单一真源）+ `Tool` / `DirEntry` 类型；
//   - 形状面（`SkillDef` / `SkillScan` / `SkillRegistryFace` / `SkillImplementation`）
//     留内核契约 `agent/skill-contract.ts`——内核装配面（workspace / runtime / 工具行）
//     读同一份形状。
// 全是无状态读面/工厂 ⇒ 桥真实例，产物域零副本。

export type { SkillDef, SkillImplementation, SkillRegistryFace, SkillScan } from '../../../agent/skill-contract';
export type { Tool } from '../../../agent/tool';
export { defineTool } from '../../../agent/tools/define-tool';
// 登记口（产物 apply 用；产物域经 faceDeps 落到内核同一份登记表——见 host.aliased 注）
export { clearSkillImplementation, registerSkillImplementation } from '../../../agent/skill-impl';
export type { DirEntry } from '../../../rpc-contract';
export { kernelGlobalMemoryDir, kernelListDirectoryFlat, kernelReadFile } from '../../../rpc-contract';
