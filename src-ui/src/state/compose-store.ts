// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state/compose-store — 创作坞的会话级配置覆盖（Stage-4 打孔③ → 方案甲 2026-08-27）。
//
// 拍板（canvas-space-model-notes.md §5 拍板 9 注）「创作坞状态归属铁律」：
// 创作坞是视图不是容器，不拥有任何会话状态，只"指向"活跃会话。
//
// 方案甲语义（composer-provider-audit.md 第二部分，2026-08-27 拍板）：
//   全局 = 新卷/未改卷的实时默认；会话 = 只存自己的覆盖；运行与显示都按会话解析。
//   - prefs 表只存「用户显式改动过的卷」的覆盖条目——ensurePrefs 的
//     「首次触碰就快照冻结」语义已退役（那是 A1「显示层谎言」的一半根）；
//   - setModel / setThinking 只写会话覆盖 + 发带 sessionId 的信号
//     （notifyAgentConfigChanged('model-switched', sid)），一行不碰全局 settings
//     （A2「thinking 写错行」随之消除；A4 localStorage clobber 面同步收窄）；
//   - resolveEffective(sessionId) = 会话覆盖 ?? 全局活跃 provider（实时读，
//     未改过的卷跟随全局默认，改过的卷不跟随）。
//   - 权限模式不在此列——mode-store 是工作区级单一真相，创作坞的权限控件直读。
//
// 模块级可变态归属（CONVENTIONS §1.10）：每面板 scoped store（同
// input-store 形态，createScopedStore 注册表，sessionId 按面板隔离）。

import { create } from 'zustand';
import type { StoredThinking } from '../provider/thinking';
import { getActiveProvider, loadSettings, type ProviderId, saveSettings, updateProvider } from '../settings';
import { notifyAgentConfigChanged } from './agent-config-store';
import { createScopedStore } from './scoped-store';

/** 每会话的创作坞偏好（可热切换面——模型/思考强度；权限走 mode-store）。 */
export interface ComposeSessionPrefs {
  providerName: string;
  model: string;
  thinking: StoredThinking | undefined;
}

export interface ComposeStore {
  /** 会话覆盖表（key = sessionId string，按面板隔离）。只含显式改动过的卷。 */
  sessions: Record<string, ComposeSessionPrefs>;

  /** 读会话覆盖；无覆盖 = undefined（未改过的卷，显示/运行回落全局默认）。 */
  getPrefs: (sessionId: string) => ComposeSessionPrefs | undefined;
  /** 解析生效配置：会话覆盖 ?? 全局活跃 provider（实时读，不写任何状态）。 */
  resolveEffective: (sessionId: string) => ComposeSessionPrefs;
  /** 热切换模型：写会话覆盖 + 发带 sessionId 的 model-switched 信号（不写全局）。 */
  setModel: (sessionId: string, providerName: string, model: string) => void;
  /** 热切换思考档位：写会话覆盖 + 发带 sessionId 的 thinking-changed 信号（不写全局）。 */
  setThinking: (sessionId: string, thinking: StoredThinking | undefined) => void;
  /** 恢复期回填（从卷快照读盘时）：整条覆盖写入，不发包信号。 */
  hydratePrefs: (sessionId: string, prefs: ComposeSessionPrefs) => void;
  /** 移除会话覆盖（合卷/删除时清理）。 */
  removePrefs: (sessionId: string) => void;
  /** 清空全部覆盖（切换工作区全量重置时调用）。 */
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

    resolveEffective: (sessionId) => get().sessions[sessionId] ?? snapshotFromGlobal(),

    setModel: (sessionId, providerName, model) => {
      // 覆盖条目的 thinking 初值取目标 provider 行的当前值（跨 provider 切模型
      // 时档位跟随目标家——与既有创作坞行为一致，只是落点从全局行改为会话覆盖）
      let thinking: StoredThinking | undefined;
      try {
        thinking = loadSettings().providers.find((p) => p.name === providerName)?.thinking;
      } catch {
        /* 读失败 → thinking 覆盖缺省（undefined = 使用点回落 provider 行） */
      }
      const next: ComposeSessionPrefs = { providerName, model, thinking };
      set((s) => ({ sessions: { ...s.sessions, [sessionId]: next } }));
      // 新会话默认 = 最近使用（2026-08-26）：定向写「最近使用的 provider + 该行
      // model」——重新 loadSettings 读改写单字段（不整份快照 → A4 clobber 不复活）。
      // 只影响新卷/未改卷的出生默认；已存在会话走覆盖（方案甲 A1「切一个拖累全部」
      // 不复发——applyAgentConfig 会话级分支按会话解析，不读 activeProvider）。
      // 「设为当前」按钮随此语义退役：activeProvider 不再是手动指定的「当前」，
      // 而是自动跟从最近使用的 provider。
      try {
        const s = loadSettings();
        const row = s.providers.find((p) => p.name === providerName);
        if (row && (row.model !== model || s.activeProvider !== providerName)) {
          saveSettings(updateProvider({ ...s, activeProvider: providerName as ProviderId }, providerName, { model }));
        }
      } catch {
        /* 读/写失败静默——新会话默认保持旧值，不阻断热切换 */
      }
      // 方案甲：信号带 sessionId → applyAgentConfig 只热切换该会话的句柄
      notifyAgentConfigChanged('model-switched', Number(sessionId));
    },

    setThinking: (sessionId, thinking) => {
      set((s) => {
        const prev = s.sessions[sessionId];
        // 无覆盖的卷先落一条（以当前生效配置为底）再改 thinking——
        // 「改过思考」也算显式改动，之后模型不再跟随全局
        const base: ComposeSessionPrefs = prev ?? snapshotFromGlobal();
        return { sessions: { ...s.sessions, [sessionId]: { ...base, thinking } } };
      });
      notifyAgentConfigChanged('thinking-changed', Number(sessionId));
    },

    hydratePrefs: (sessionId, prefs) => set((s) => ({ sessions: { ...s.sessions, [sessionId]: prefs } })),

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

/** 方案甲：跨面板解析某会话的生效配置（覆盖 ?? 全局默认）。
 *  workspace.applyAgentConfig（settings-saved 逐会话重解析）与工厂共用。 */
export function resolveComposeEffective(storeId: string, sessionId: number): ComposeSessionPrefs {
  return getComposeStore(storeId).getState().resolveEffective(String(sessionId));
}

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
