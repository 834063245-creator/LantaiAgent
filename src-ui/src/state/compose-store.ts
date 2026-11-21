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
import {
  getActiveProvider,
  loadSettings,
  type ProviderId,
  rememberedThinking,
  rememberModelThinking,
  saveSettings,
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
  /** 无主态档位（还没开卷时拨的值；纯内存，开卷出生时带进去）。 */
  bareThinking: StoredThinking | undefined;
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
  /** 无主态模型切换（开口即开卷 2026-08-31）：直接写「新卷出生默认」
   *  （activeProvider + 行 model），不建会话覆盖、不发会话信号——
   *  无句柄可热切，下一卷出生时经工厂吃到新默认。 */
  setGlobalModel: (providerName: string, model: string) => void;
  /** 无主态思考档位切换：只记本进程内存（开下一卷时随出生默认带进去，不落盘）。 */
  setGlobalThinking: (thinking: StoredThinking | undefined) => void;
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
    // 思考档位：还没有会话可写时，沿用**该模型上次用过的档位**（本机记忆，
    // 创作坞拨档位时自动记；重开应用仍在）。设置页没有这个手动项。
    return { providerName: act.name, model: act.model, thinking: rememberedThinking(act, act.model) };
  } catch {
    return { providerName: '', model: '', thinking: undefined };
  }
}

/** 新卷出生默认写盘（setModel 尾部与无主态 setGlobalModel 共用）。
 *
 *  ⚡ 2026-11-30 R5 收口：`model` 是**最近使用**运行态读数，不是 providers.yml 意图。
 *  因此这里只写本地存档（`activeProvider` + 目标行的 `model`）；文件权威下
 *  `saveSettings` 会剥掉 provider 意图、保留 model/lastTest/catalog/modelMeta 等运行态。
 *  新卷默认跟从「最近使用」，目录移除该模型时由 ProviderPage 自动回落剩余列表第一个。 */
function writeNewSessionDefault(providerName: string, model: string): void {
  try {
    const s = loadSettings();
    const row = s.providers.find((p) => p.name === providerName);
    if (!row) return;
    const nextModel = model.trim();
    if (s.activeProvider === providerName && row.model === nextModel) return;
    saveSettings({
      ...s,
      activeProvider: providerName as ProviderId,
      providers: s.providers.map((p) => (p.name === providerName ? { ...p, model: nextModel } : p)),
    });
  } catch (e) {
    /* 读失败：新会话默认保持旧值，不阻断热切换——但留痕。 */
    console.warn('[compose-store] 新会话默认落盘失败（下次开纸回旧值）:', e);
  }
}

function createComposeStoreImpl() {
  return create<ComposeStore>((set, get) => ({
    // 仅作订阅触发器（真源 = settings.lastThinking 本机记忆，见 snapshotFromGlobal）；
    // 坞在无卷态靠它重渲染，保证拨完档位 pill 立刻跟手。
    bareThinking: undefined,
    sessions: {},

    getPrefs: (sessionId) => get().sessions[sessionId],

    resolveEffective: (sessionId) => get().sessions[sessionId] ?? snapshotFromGlobal(),

    setModel: (sessionId, providerName, model) => {
      // 2026-09-23 思考下沉：切模型**不再把提供方行值快照进会话覆盖**——覆盖里的
      // thinking 保持 undefined = 「按目标模型解析」（per-model 覆盖 ?? 行值，见
      // settings.modelThinking / live provider）。旧行为把行值冻结进覆盖，于是切到
      // 任何模型都带同一个档位（「供应商级全局生效」的观感来源之一），且会盖掉
      // 目标模型自己的档位。
      const next: ComposeSessionPrefs = { providerName, model, thinking: undefined };
      set((s) => ({ sessions: { ...s.sessions, [sessionId]: next } }));
      // 新会话默认 = 最近使用（2026-08-26）：定向写「最近使用的 provider + 该行
      // model」。只影响新卷/未改卷的出生默认；已存在会话走覆盖（方案甲 A1
      // 「切一个拖累全部」不复发——applyAgentConfig 会话级分支按会话解析）。
      writeNewSessionDefault(providerName, model);
      // 方案甲：信号带 sessionId → applyAgentConfig 只热切换该会话的句柄
      notifyAgentConfigChanged('model-switched', Number(sessionId));
    },

    setThinking: (sessionId, thinking) => {
      const base: ComposeSessionPrefs = get().sessions[sessionId] ?? snapshotFromGlobal();
      set((s) => ({ sessions: { ...s.sessions, [sessionId]: { ...base, thinking } } }));
      // 记忆（本机读数）：这一卷用过的档位 = 这个模型「上次用的档位」。
      // 只影响**还没有显式选择的新卷**；本卷的显式覆盖在 compose prefs 里。
      if (thinking !== undefined) rememberModelThinking(base.providerName, base.model, thinking);
      notifyAgentConfigChanged('thinking-changed', Number(sessionId));
    },

    setGlobalModel: (providerName, model) => {
      // 无主态（开口即开卷）：只写新卷出生默认，不建会话覆盖、不发会话信号
      writeNewSessionDefault(providerName, model);
    },

    setGlobalThinking: (thinking) => {
      // 无主态（还没开卷）：把这次选择记成「当前模型上次用的档位」（本机记忆，重开还在），
      // 开下一卷时随出生默认带进去。设置页没有这个手动项。
      try {
        const act = getActiveProvider(loadSettings());
        if (act.model?.trim()) rememberModelThinking(act.name, act.model, thinking);
      } catch (e) {
        console.warn('[compose-store] 思考档位记忆写入失败（不影响本次会话）:', e);
      }
      set({ bareThinking: thinking });
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

/** 无主态显示面（开口即开卷 2026-08-31）：新卷出生默认（全局活跃 provider 行）。
 *  创作坞无活跃卷时的模型/思考显示真源——纯 settings 读，不经 store。 */
export function resolveNewSessionDefault(): ComposeSessionPrefs {
  return snapshotFromGlobal();
}

/** 从注册表中移除面板的创作坞状态。 */
export function disposeComposeStore(storeId: string): void {
  scoped.disposeStore(storeId);
}

/** 测试套件：复位全部实例。 */
export function resetComposeStoresForTests(): void {
  const key = '__lantai_compose_stores__';
  const w = globalThis as unknown as Record<string, unknown>;
  const stores = w[key] as Map<string, { setState: (s: Partial<ComposeStore>) => void }> | undefined;
  if (stores) {
    for (const store of stores.values()) {
      store.setState({ sessions: {}, bareThinking: undefined });
    }
  }
}
