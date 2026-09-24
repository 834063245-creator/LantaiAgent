// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 语言档位单一事实源（P1a：替代旧 bus 'lang:changed' 事件）。
//
// ⚠ 2026-09-24 批 0c 收缩（插件化欠账总账 §2.6「半尸体 i18n」）：原 65 键翻译表
// （`legend.*` 图例 / `focus.*` 聚焦横幅）与 `t()` / `getLang()` 的**读者**随观测台
// 星图全量退役同亡（全仓零 import）⇒ 整表删除，只留语言档位 store 与写入口。
//
// 现存面 = store + `setLang`（写入口两处：`shell/boot.ts` 引导读盘、设置面板保存）。
// 待裁定（不在本批范围）：该 store 当前**零读者** ⇒ 语言档位是否仍是产品功能
// （设置页语言控件的去留）随账本批 1「settings 三页归家」一并处理。

import { create } from 'zustand';

export type Lang = 'zh' | 'en';

export const useLangStore = create<{ lang: Lang }>(() => ({ lang: 'zh' }));

export function setLang(lang: Lang): void {
  useLangStore.setState({ lang });
}
