/**
 * WorkspaceStateMachine — replaces the ad-hoc `_switching` / `_active` boolean flags
 * with a typed state machine where every transition has guards and optional timeouts.
 *
 * States:
 *   idle          — no workspace open
 *   opening       — Workspace.open() in progress
 *   active        — workspace fully operational
 *   deactivating  — Workspace.deactivate() in progress
 *   switching     — deactivate → open composite (atomic from user perspective)
 *   degraded     — workspace open but background analysis failed
 */

export type WorkspaceState = 'idle' | 'opening' | 'active' | 'deactivating' | 'switching' | 'degraded';

/** isBusy 语义的三个状态（_busySince 追踪口径同源）。 */
const BUSY_STATES: ReadonlySet<WorkspaceState> = new Set(['opening', 'deactivating', 'switching']);

const VALID_TRANSITIONS: Record<WorkspaceState, WorkspaceState[]> = {
  idle: ['opening', 'switching'],
  opening: ['active', 'degraded', 'idle'],
  active: ['deactivating', 'switching', 'degraded'],
  deactivating: ['idle', 'switching'],
  switching: ['active', 'degraded', 'idle'],
  degraded: ['deactivating', 'switching', 'active'],
};

export class WorkspaceStateMachine {
  private _state: WorkspaceState = 'idle';
  /** 首次进入 busy 态的时刻（busy→busy 复合动作不重置——deactivating→switching
   *  是同一个用户动作的两段）。2026-09-09 事故立法：引擎缺席时恢复链可挂死在
   *  busy 态，首页 isBusy 守卫会把用户锁在所有工作区外面——busyMs 让守卫能
   *  区分「恢复中（请稍候）」与「卡死（给逃生口）」。 */
  private _busySince: number | null = null;
  private _listeners: Array<(s: WorkspaceState) => void> = [];

  get state(): WorkspaceState {
    return this._state;
  }

  /** 距首次进入 busy 态的毫秒数（非 busy 态 = 0）。 */
  get busyMs(): number {
    return this._busySince == null ? 0 : Date.now() - this._busySince;
  }

  /** Check if a transition is allowed by the state machine. */
  canTransition(to: WorkspaceState): boolean {
    const allowed = VALID_TRANSITIONS[this._state] ?? [];
    return allowed.includes(to);
  }

  /** Transition to a new state. Throws if the transition is not allowed. */
  transition(to: WorkspaceState): void {
    if (!this.canTransition(to)) {
      throw new Error(`Invalid transition: ${this._state} → ${to}`);
    }
    this._enter(to);
  }

  /** Force-set state without transition validation (for error recovery / timeout). */
  forceState(to: WorkspaceState): void {
    this._enter(to);
  }

  /** 状态落点统一：busy 追踪与状态同写（transition/forceState 共用）。 */
  private _enter(to: WorkspaceState): void {
    this._state = to;
    if (BUSY_STATES.has(to)) {
      if (this._busySince == null) this._busySince = Date.now();
    } else {
      this._busySince = null;
    }
    this._notify();
  }

  /** Check if currently in a state that blocks new workspace operations. */
  get isBusy(): boolean {
    return BUSY_STATES.has(this._state);
  }

  onStateChange(fn: (s: WorkspaceState) => void): () => void {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((f) => f !== fn);
    };
  }

  private _notify(): void {
    for (const fn of this._listeners) {
      try {
        fn(this._state);
      } catch {
        /* listener error should not block */
      }
    }
  }
}
