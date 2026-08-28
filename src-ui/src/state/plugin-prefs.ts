// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugin-prefs — 第一方插件用户偏好（禁用集）。app 级单例 store
// （CONVENTIONS §1.2），localStorage 持久化（非敏感配置——沿用
// settings.ts 的同款形态）。
//
// 语义：只存「用户禁用的第一方 feature 插件名」。platform 类（service）
// 是平台服务本体，UI 不提供开关，这里也不会出现它们。装载期
// （loader.loadBuiltinPlugins）读 isDisabled 跳过对应插件——**下次启动
// 生效**（不做运行时 fiber 手术：第一方插件是编译期 bundle，多数贡献
// 面（工具/prompt/capability）本就只能在下次 Agent 装配体现，boot 期
// 跳过是最诚实、最安全的生效点）。
//
// 毒化容忍（INVARIANTS #11）：localStorage 坏 JSON / 非数组 → 空集，
// 不炸装载。写入失败（配额耗尽）→ warn + 仅本次会话生效。

import { create } from 'zustand';

const STORAGE_KEY = 'lantai.pluginPrefs';

interface PersistedShape {
  disabled: string[];
}

function loadDisabled(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    if (!Array.isArray(parsed.disabled)) return [];
    return parsed.disabled.filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

function saveDisabled(disabled: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ disabled } satisfies PersistedShape));
  } catch (e) {
    console.warn('[plugin-prefs] localStorage 写入失败（配额耗尽？），仅本次会话生效:', e);
  }
}

interface PluginPrefsState {
  /** 用户禁用的第一方插件名（feature 类）。 */
  disabled: string[];
  isDisabled: (name: string) => boolean;
  setDisabled: (name: string, disabled: boolean) => void;
  /** 测试复位：清 localStorage + 状态。 */
  resetForTests: () => void;
}

export const usePluginPrefs = create<PluginPrefsState>((set, get) => ({
  disabled: loadDisabled(),
  isDisabled: (name) => get().disabled.includes(name),
  setDisabled: (name, disabled) => {
    const next = disabled
      ? get().disabled.includes(name)
        ? get().disabled
        : [...get().disabled, name]
      : get().disabled.filter((n) => n !== name);
    saveDisabled(next);
    set({ disabled: next });
  },
  resetForTests: () => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
    set({ disabled: [] });
  },
}));
