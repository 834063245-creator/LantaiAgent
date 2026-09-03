// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Plan 状态管理 — 跟踪 plan 模式的激活状态和计划文件路径
//
//   - 持久化 { active, id } 到 session（可恢复）
//   - planFilePath 从 id 派生，不持久化
//   - enter 时只确定 id 和路径，不创建文件（LLM 第一次 Write 时创建）
//   - exit/cancel 都把 active 设为 false，plan 文件保留（可回溯）
//
// 不用事件溯源 / wire Op —— 兰台没有那套架构。
// 简单状态 + 监听器 + save/restore 快照。

export interface PlanState {
  active: boolean;
  /** 计划 id — 从 enter 时生成，用于派生 planFilePath */
  id: string | null;
  /** 计划文件路径 — 从 id 派生，不持久化 */
  planFilePath: string | null;
}

/** 可序列化的快照 — 用于 session 持久化 */
export interface PlanStateSnapshot {
  active: boolean;
  id: string | null;
}

/** 路径归一化：反斜杠 → 正斜杠，剥离 `\\?\` verbatim 前缀，去 `./` 前缀与尾部斜杠。 */
function normalizePath(p: string): string {
  return p
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export class PlanStateManager {
  private _state: PlanState = { active: false, id: null, planFilePath: null };
  private _listeners = new Set<(s: PlanState) => void>();
  /** 归一化后的项目根 — enter/fromSnapshot 时记录，供 isPlanFile 解析相对路径。 */
  private _projectPath = '';

  get state(): PlanState {
    return this._state;
  }

  /** 进入 plan 模式。返回计划文件路径。 */
  enter(projectPath: string): string {
    const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this._projectPath = normalizePath(projectPath);
    const planFilePath = this._derivePlanPath(id, this._projectPath);
    this._state = { active: true, id, planFilePath };
    this._notify();
    return planFilePath;
  }

  /** 退出 plan 模式（审批通过）。plan 文件保留。 */
  exit(): void {
    this._state = { active: false, id: null, planFilePath: null };
    this._projectPath = '';
    this._notify();
  }

  /** 取消 plan 模式（用户手动退出，非审批）。plan 文件保留。 */
  cancel(): void {
    this._state = { active: false, id: null, planFilePath: null };
    this._projectPath = '';
    this._notify();
  }

  /** 检查路径是否为当前计划文件（用于 plan 模式下的写入放行）。
   *  支持绝对路径与相对路径（相对项目根解析）；均先归一化再比较。 */
  isPlanFile(filePath: string): boolean {
    if (!this._state.planFilePath) return false;
    const norm = normalizePath(filePath);
    const abs = norm.startsWith('/') || /^[A-Za-z]:/.test(norm) ? norm : `${this._projectPath}/${norm}`;
    return abs === this._state.planFilePath;
  }

  /** 注册状态变更监听器，返回取消函数。 */
  onChange(fn: (s: PlanState) => void): () => void {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  }

  // ── 持久化 ──

  /** 导出可序列化快照 — 用于 session 保存 */
  toSnapshot(): PlanStateSnapshot {
    return { active: this._state.active, id: this._state.id };
  }

  /** 从快照恢复 — 用于 session 恢复。
   *  planFilePath 从 id 重新派生（不持久化路径）。 */
  fromSnapshot(snapshot: PlanStateSnapshot | null, projectPath: string): void {
    if (snapshot?.active && snapshot.id) {
      this._projectPath = normalizePath(projectPath);
      this._state = {
        active: true,
        id: snapshot.id,
        planFilePath: this._derivePlanPath(snapshot.id, this._projectPath),
      };
    } else {
      this._state = { active: false, id: null, planFilePath: null };
    }
    this._notify();
  }

  // ── 内部 ──

  private _derivePlanPath(id: string, projectPath: string): string {
    // 入参已由 normalizePath 归一化（enter/fromSnapshot 传入）
    return `${projectPath}/.lantai/plans/${id}.md`;
  }

  private _notify(): void {
    for (const fn of this._listeners) fn(this._state);
  }
}
