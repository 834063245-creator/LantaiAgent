// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent/memory-contract — 记忆域**契约面**（批 9h-4，2026-09-26）。
//
// 病灶（同批 9h 施工单）：`MemoryManager` 此前由内核 `workspace.ts` `new` 出来、被
// runtime 装配面（`context.ts` / `runtime/types.ts` / `agent-builder.ts` / 工具行材料）当类型用，
// 而记忆工具（save/list/read/delete）与出厂记忆逻辑属产品面 ⇒ 实现随
// `plugins/builtin/memory-domain/` 包，形状与登记表（`agent/memory-impl.ts`）留内核。
//
// 形状口径：**只上收内核真正用的成员**（`onSaved` 回调位 / `loadPromptSection()` /
// `scopes()`）——工具面（list/read/save/delete）是实现内部事，内核不据此编程 ⇒ 不进契约面
// （契约面越小越稳：工具面的演化不该触发内核契约变更）。

/** 记忆条目（索引行）——`list()` 的产出形状（与实现逐字同形）。 */
export interface MemoryEntry {
  name: string;
  /** 显示标题。 */
  title: string;
  /** 文件名（含 .md 扩展名）。 */
  file: string;
  /** 索引中的一行摘要。 */
  description: string;
}

/** 记忆正文（frontmatter + 正文）——`read()` 的产出形状（与实现逐字同形）。 */
export interface MemoryFile {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  confidence: 'fact' | 'reference' | 'background' | 'suppressed';
  hit_count: number;
  /** 仅正文（不含 frontmatter）。 */
  content: string;
  /** 完整文件文本（重写时更新元数据用）。 */
  raw: string;
}

/** 保存回执（`onSaved` 回调载荷——工作区页脚/状态面显示用；与实现逐字同形）。 */
export interface MemorySavedInfo {
  name: string;
  description?: string;
  confidence?: string;
  scope?: string;
}

/** 记忆管理器**结构面**（内核装配面按此存取；实现类随包）。
 *  成员 = 内核装配面用点（`onSaved` / `loadPromptSection`）**加**产品工具工厂的取用面
 *  （`list` / `read` / `save` / `delete` / `loadIndexText` / `scopes`）——工具行材料经
 *  `composition/tool-rows.ts` 把同一个实例交给 `memory-domain` 包，故形状必须覆盖双方。 */
export interface MemoryManagerFace {
  /** 保存回调位（workspace 装配期挂——工作区页脚刷新）。 */
  onSaved?: (info: MemorySavedInfo) => void;
  /** 装配期 system-prompt 记忆段（无记忆 = 空串；`runtime.ts` 读）。 */
  loadPromptSection(graphNodes?: string[]): Promise<string>;
  /** 当前可用作用域（workspace 用它判「含全局」）。 */
  scopes(): Array<'project' | 'global'>;
  /** 索引全文（工具 action=list 的原始形态之一）。 */
  loadIndexText(scope?: 'project' | 'global'): Promise<string>;
  /** 列出条目。 */
  list(scope?: 'project' | 'global'): Promise<MemoryEntry[]>;
  /** 读一条（`incrementHit` = 命中计数自增）。 */
  read(name: string, scope?: 'project' | 'global', incrementHit?: boolean): Promise<MemoryFile | null>;
  /** 保存一条（返回落点读数——新建/正文长度/路径，回执面用）。 */
  save(
    name: string,
    description: string,
    type: 'user' | 'feedback' | 'project' | 'reference',
    content: string,
    confidence?: 'fact' | 'reference' | 'background' | 'suppressed',
    scope?: 'project' | 'global',
  ): Promise<{ created: boolean; bytes: number; path: string }>;
  /** 删除一条（墓碑语义在实现内）。 */
  delete(name: string, scope?: 'project' | 'global'): Promise<boolean>;
}

/** 记忆域实现面（产物登记项）。 */
export interface MemoryImplementation {
  /** 建工作区级管理器（`workspace.ts` 装配期调用：项目路径 + 全局记忆目录）。 */
  createManager(projectPath: string, globalDir?: string): MemoryManagerFace;
  /** 摄入完整会话到记忆束服务（`workspace.ts` 会话落盘回调调用；失败静默由调用方决定）。 */
  bundleIngest(
    messages: Array<{ role: string; content: string }>,
    userId?: string,
    sessionId?: string,
  ): Promise<boolean>;
}
