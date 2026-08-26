// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state/compose-store — 创作坞的会话级状态对象（Stage-4 打孔③）。
//
// 拍板（canvas-space-model-notes.md §5 拍板 9 注）「创作坞状态归属铁律」：
// 创作坞是视图不是容器，不拥有任何会话状态，只"指向"活跃会话。每会话
// 持有一个完整状态对象（模型/思考强度/权限——可热切换，改了立即生效，
// 下一条消息即用）。切换会话 = 指针换向，不迁移不重算。
//
// 落点设计（集成任务定位——功能均已存在，散落各处，这里收拢为「会话状态
// API」）：
//   - 每会话一份 `ComposeSessionPrefs`（providerName / model / thinking），
//     缺失时从全局 settings 惰性快照（ensurePrefs）；
//   - 写 = 写本 store + 落全局 settings（ProviderSettings 单一真相）+ 发
//     agent-config 信号（model-switched / thinking-changed）→ Workspace.
//     applyAgentConfig 热同步到全部活句柄（下一条消息即用）；
//   - 权限模式不在此列——mode-store 是工作区级单一真相（「模式是相处方式，
//     属工作台不属面板」），创作坞的权限控件直读 mode-store；
//   - token/上下文 = 惰性计算 + 缓存（组件按活跃会话键 memo，切回不重算，
//     见 ComposerDock 的 useMemo 键——本 store 不持有派生计数）。
//
// 模块级可变态归属（CONVENTIONS §1.10）：每面板 scoped store（同
// input-store 形态，createScopedStore 注册表，sessionId 按面板隔离）。

import { create } from 'zustand';
import type { StoredThinking } from '../provider/thinking';
import {
  type AppSettings,
  getActiveProvider,
  loadSettings,
  type ProviderSettings,
  saveSettings,
  updateProvider,
} from '../settings';
import { notifyAgentConfigChanged } from './agent-config-store';
import { createScopedStore } from './scoped-store';

/** 每会话的创作坞偏好（可热切换面——模型/思考强度；权限走 mode-store）。 */
export interface ComposeSessionPrefs {
  providerName: string;
  model: string;
  thinking: StoredThinking | undefined;
}

export interface ComposeStore {
  /** 会话偏好表（key = sessionId string，按面板隔离）。 */
  sessions: Record<string, ComposeSessionPrefs>;

  /** 读偏好；缺失 = undefined（组件走 ensurePrefs 惰性补）。 */
  getPrefs: (sessionId: string) => ComposeSessionPrefs | undefined;
  /** 缺失时从全局 settings 快照当前活跃提供方（惰性初始化，不写盘）。 */
  ensurePrefs: (sessionId: string) => ComposeSessionPrefs;
  /** 热切换模型：写 store + 落全局 settings（含跨 provider 联动 active）+ 信号。 */
  setModel: (sessionId: string, providerName: string, model: string) => void;
  /** 热切换思考档位：写 store + 落全局 settings（当前活跃 provider）+ 信号。 */
  setThinking: (sessionId: string, thinking: StoredThinking | undefined) => void;
  /** 移除会话偏好（合卷/删除时清理）。 */
  removePrefs: (sessionId: string) => void;
  /** 清空全部偏好（切换工作区全量重置时调用）。 */
  clearAll: () => void;
}

function snapshotFromGlobal(): ComposeSessionPrefs {
  try {
    const act = getActiveProvider(loadSettings());
    return { providerName: act.name, model: act.model, thinking: act.thinking };
  } catch {
    return { providerName: '', model: '', thinking: undefined };
  }
}

function createComposeStoreImpl() {
  return create<ComposeStore>((set, get) => ({
    sessions: {},

    getPrefs: (sessionId) => get().sessions[sessionId],

    ensurePrefs: (sessionId) => {
      const cur = get().sessions[sessionId];
      if (cur) return cur;
      const snap = snapshotFromGlobal();
      set((s) => ({ sessions: { ...s.sessions, [sessionId]: snap } }));
      return snap;
    },

    setModel: (sessionId, providerName, model) => {
      const prev = get().ensurePrefs(sessionId);
      let next: ComposeSessionPrefs = { ...prev, providerName, model };
      try {
        const s = loadSettings();
        const act = getActiveProvider(s);
        let n: AppSettings = updateProvider(s, providerName, { model });
        if (act.name !== providerName) {
          n = { ...n, activeProvider: providerName as ProviderSettings['name'] };
        }
        saveSettings(n);
        // 联动读回目标 provider 的 thinking（跨 provider 切模型时档位跟随）
        const target = n.providers.find((p) => p.name === providerName);
        next = { providerName, model, thinking: target?.thinking };
      } catch (e) {
        // 落盘失败 = 热切换不生效——失败可见（不静默吞），不阻断 store 侧记录
        console.error('[compose-store] 切模型失败（设置未落盘，重启不保留）:', e);
      }
      set((s) => ({ sessions: { ...s.sessions, [sessionId]: next } }));
      notifyAgentConfigChanged('model-switched');
    },

    setThinking: (sessionId, thinking) => {
      const prev = get().ensurePrefs(sessionId);
      const next: ComposeSessionPrefs = { ...prev, thinking };
      try {
        const s = loadSettings();
        const act = getActiveProvider(s);
        saveSettings(updateProvider(s, act.name, { thinking }));
      } catch (e) {
        console.error('[compose-store] 切思考档位失败（设置未落盘，重启不保留）:', e);
      }
      set((s) => ({ sessions: { ...s.sessions, [sessionId]: next } }));
      notifyAgentConfigChanged('thinking-changed');
    },

    removePrefs: (sessionId) =>
      set((s) => {
        if (!(sessionId in s.sessions)) return {};
        const { [sessionId]: _dropped, ...rest } = s.sessions;
        return { sessions: rest };
      }),

    clearAll: () => set({ sessions: {} }),
  }));
}

// ── 每面板注册表 ──

const scoped = createScopedStore('__lantai_compose_stores__', createComposeStoreImpl);

export const getComposeStore = scoped.getStore;

/** 从注册表中移除面板的创作坞状态。 */
export function disposeComposeStore(storeId: string): void {
  scoped.disposeStore(storeId);
}

/** 测试套件：复位全部实例。 */
export function resetComposeStoresForTests(): void {
  const key = '__lantai_compose_stores__';
  const w = window as unknown as Record<string, unknown>;
  const stores = w[key] as Map<string, { setState: (s: Partial<ComposeStore>) => void }> | undefined;
  if (stores) {
    for (const store of stores.values()) {
      store.setState({ sessions: {} });
    }
  }
}
