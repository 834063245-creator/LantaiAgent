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
import { patchProviderIntent } from '../provider/providers-store';
import type { StoredThinking } from '../provider/thinking';
import { getActiveProvider, loadSettings, type ModelOverrides, type ProviderId, saveSettings } from '../settings';
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
  /** 无主态模型切换（开口即开卷 2026-08-31）：直接写「新卷出生默认」
   *  （activeProvider + 行 model），不建会话覆盖、不发会话信号——
   *  无句柄可热切，下一卷出生时经工厂吃到新默认。 */
  setGlobalModel: (providerName: string, model: string) => void;
  /** 无主态思考档位切换：写 activeProvider 行的 thinking（新卷出生默认）。 */
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
    return { providerName: act.name, model: act.model, thinking: act.thinking };
  } catch {
    return { providerName: '', model: '', thinking: undefined };
  }
}

/** 新卷出生默认写盘（setModel 尾部与无主态 setGlobalModel 共用）。
 *
 *  ⚡ 2026-11-29（题签「记住选择」批）：**模型走 providers.yml**。
 *  病灶：旧实现 `saveSettings(updateProvider(..., { model }))` 写的是 localStorage 里的
 *  provider 行——而 2026-09-24「配方改文件」之后，**意图的权威是 `~/.lantai/providers.yml`**，
 *  `saveSettings` 在文件权威就位时会把意图整段剥掉（只留 apiKey/lastTest/catalog/modelMeta）。
 *  于是这一笔**写的那一刻就没了**：拨完模型开下一张纸仍是文件里那个，重启更不会记得。
 *  分工不变：`activeProvider`（最近使用的 provider）本就是运行态读数 → 仍落本地存档；
 *  `model`（这一行的默认模型）是用户意图 → 落配置文件。 */
function writeNewSessionDefault(providerName: string, model: string): void {
  try {
    const s = loadSettings();
    const row = s.providers.find((p) => p.name === providerName);
    if (!row) return;
    if (s.activeProvider !== providerName) {
      saveSettings({ ...s, activeProvider: providerName as ProviderId });
    }
    if (row.model !== model) patchProviderIntent(providerName, { model });
  } catch (e) {
    /* 读失败：新会话默认保持旧值，不阻断热切换——但**留痕**（写失败由 patchProviderIntent 记） */
    console.warn('[compose-store] 新会话默认落盘失败（下次开纸回旧值）:', e);
  }
}

function createComposeStoreImpl() {
  return create<ComposeStore>((set, get) => ({
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
      set((s) => {
        const prev = s.sessions[sessionId];
        // 无覆盖的卷先落一条（以当前生效配置为底）再改 thinking——
        // 「改过思考」也算显式改动，之后模型不再跟随全局
        const base: ComposeSessionPrefs = prev ?? snapshotFromGlobal();
        return { sessions: { ...s.sessions, [sessionId]: { ...base, thinking } } };
      });
      notifyAgentConfigChanged('thinking-changed', Number(sessionId));
    },

    setGlobalModel: (providerName, model) => {
      // 无主态（开口即开卷）：只写新卷出生默认，不建会话覆盖、不发会话信号
      writeNewSessionDefault(providerName, model);
    },

    setGlobalThinking: (thinking) => {
      // 无主态（开口即开卷）：坞里 / 题签上拨的是**当前出生默认模型**的档位——2026-09-23
      // 思考下沉后落到该模型的 per-model 覆盖（与本家默认档位各管一层：设置页行级
      // 那个是「没单独设过的模型用它」）。行无模型时无从定位，回落写行值。
      //
      // ⚡ 2026-11-29（题签「记住选择」批）：改走 `patchProviderIntent`——**意图权威 =
      // `~/.lantai/providers.yml`**。旧实现 `saveSettings(updateProvider(...))` 写的是本地
      // 存档里的 provider 行，而文件权威就位后 `saveSettings` 会把意图整段剥掉（见
      // writeNewSessionDefault 的病灶注）：档位从来就没落过盘，下一次开纸就回旧值。
      // 发 thinking-changed 信号无意义——无会话句柄可热切，工厂出生时现读。
      try {
        const s = loadSettings();
        const act = getActiveProvider(s);
        const model = act.model?.trim();
        if (!model) {
          patchProviderIntent(act.name, { thinking });
          return;
        }
        const overrides: Record<string, ModelOverrides> = { ...(act.modelOverrides ?? {}) };
        const entry: ModelOverrides = { ...(overrides[model] ?? {}) };
        if (thinking === undefined) delete entry.thinking;
        else entry.thinking = thinking;
        // 空条目不留壳：模型没有别的覆盖时，文件里不该多出一条空映射
        if (Object.keys(entry).length === 0) delete overrides[model];
        else overrides[model] = entry;
        patchProviderIntent(act.name, {
          modelOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        });
      } catch (e) {
        console.warn('[compose-store] 思考档位落盘失败（下次开纸回旧值）:', e);
      }
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
      store.setState({ sessions: {} });
    }
  }
}
