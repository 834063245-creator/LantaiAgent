// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-run-config — 「这一卷打算怎么跑」四笔的**响应式读面**（2026-11-29 收口批）。
//
// 分工：规则（优先级链 / 来源 / 写入分流）全在 `state/run-config`（纯函数，可单独测）；
// 本件只负责「哪几件事变了要重算」——四笔的值分别住在四处（题签 / 预设选择 / 权限 /
// 每面板 compose 覆盖）+ 一份 settings 快照。**这是唯一一处**做这组订阅的地方：
//   多一个宿主自己订阅一遍，就多一处「某个变更忘了跟」的 bug（2026-11-19 那批
//   「选完组合标签不动」「切了没反应」正是这么来的）。
//
// ⚠ 目标（`RunTarget`）由**宿主**给：题签行给纸 id、纸身输入面给纸 id、坞给卷号/无主。
// 禁在这里读 `focusedId` 兜底——「不给就落焦点那张」是本批要根除的写法。

import { useEffect, useMemo, useState } from 'react';
import {
  getComposeStore,
  loadSettings,
  onSettingsSaved,
  type RunConfig,
  type RunTarget,
  resolveRunConfig,
  useDraftSheetStore,
  useModeStore,
  usePresetStore,
} from '../host';

export function useRunConfig(target: RunTarget): RunConfig {
  /* 题签（纸）/ 预设选择 / 权限 / 卷级 compose 覆盖：四族真源各自订阅一次。 */
  const papers = useDraftSheetStore((s) => s.papers);
  const presetSelected = usePresetStore((s) => s.selected);
  const permissionMode = useModeStore((s) => s.permissionMode);
  const sheetPermission = useModeStore((s) => s.sheetPermission);
  const sessionModes = useModeStore((s) => s.sessionModes);
  /* 设置保存代数（provider 行 / 模型档位 / 出厂默认都在这份快照里）。 */
  const [settingsTick, setSettingsTick] = useState(0);
  useEffect(() => onSettingsSaved(() => setSettingsTick((n) => n + 1)), []);
  /* 卷级覆盖（compose-store）在 host 无卷时不必订阅；订阅键 = 面板 + 卷号。 */
  const [composeTick, setComposeTick] = useState(0);
  const panelId = target.panelId;
  const volumeSid = target.kind === 'volume' ? target.sessionId : null;
  useEffect(() => {
    if (volumeSid === null) return;
    return getComposeStore(panelId).subscribe(() => setComposeTick((n) => n + 1));
  }, [panelId, volumeSid]);

  return useMemo(() => {
    void papers;
    void presetSelected;
    void permissionMode;
    void sheetPermission;
    void sessionModes;
    void settingsTick;
    void composeTick;
    return resolveRunConfig(target, { settings: safeSettings() });
  }, [target, papers, presetSelected, permissionMode, sheetPermission, sessionModes, settingsTick, composeTick]);
}

function safeSettings() {
  try {
    return loadSettings();
  } catch {
    return undefined;
  }
}
