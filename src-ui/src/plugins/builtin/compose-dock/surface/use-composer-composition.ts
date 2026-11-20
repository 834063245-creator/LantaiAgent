// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-composition — 创作坞的**组合芯片面**（2026-11-17 P6 拆出；语义零新增）。
//
// 归组判据（施工单）：这组状态**随同一个事件变化**——都随「本卷的组合身份」：
// 芯片开合、本卷/全局的组合读数（compInfo）、空白判据（compBlank）、写成功后重取
// 读面的触发器（compTick），以及两条写入口（卷级 / 题签）。
//
// 两态与「开口即开卷」同构（模型/思考同款语义，见坞内 onModelChange）：
//   无主态（无活跃卷）→ 拨的是**全局默认**（selectPreset = 设置面板「组合」节同一入口，
//     落 settings；即「新卷出生默认」）。
//   有卷且**空白**    → 拨的是**卷级选择**（core.selectSessionPreset：校验 → 登记 →
//     当场重建句柄；写路径自带二道闸，与这里的控件锁同一把尺子）。
//   有卷且跑过一轮    → **只读标签**（组合决定模型看到的工具与提示面 = 字节契约，
//     中途换面会让前缀缓存与已声明能力面不一致——DSH「控制在此不承诺」同款）。
// 读面：preset 清单/选择态来自 preset-store；本卷身份与来源来自
// core.sessionComposition（异步 = 解析面动态 import，见 app/chat/session-composition）。
//
// ⚠ `presetRoster` 是**刻意的重读触发器**（「重新扫描」/新建 preset 后本卷身份与
// 可用性要重解析）：它已进依赖数组，且函数体内本就不用它——本刀把它写成显式入参
// `refreshKey`，读面与 lint 都不再需要豁免。

import { useCallback, useEffect, useState } from 'react';
import type { ChatCore } from '../host';
import { msgStoreFor, selectPreset, useDraftSheetStore, usePresetStore } from '../host';

export interface ComposerCompositionInput {
  core: ChatCore | null;
  activeSessionId: string | null;
  notice: (text: string, level?: 'info' | 'warn' | 'error') => void;
}

export function useComposerComposition({ core, activeSessionId, notice }: ComposerCompositionInput) {
  const presetRoster = usePresetStore((s) => s.roster);
  const presetSelected = usePresetStore((s) => s.selected);
  const presetError = usePresetStore((s) => s.error);
  const [compOpen, setCompOpen] = useState(false);
  const [compInfo, setCompInfo] = useState<{ presetId: string; source: 'session' | 'global'; error: string | null }>({
    presetId: presetSelected,
    source: 'global',
    error: null,
  });
  const [compBlank, setCompBlank] = useState(true);
  /** 读面重取触发器（2026-10-29）：写成功后本卷记录已变，但空白卷没有消息事件可等——
   *  不主动重读就会停在旧标签，用户看到的就是「切了没反应」（卷首芯片同款根因）。 */
  const [compTick, setCompTick] = useState(0);
  useEffect(() => {
    void presetRoster; // 重读触发器（重新扫描 / 新建 preset 后本卷身份与可用性要重解析）
    void presetSelected;
    void compTick; // 写成功后主动重取读面（空白卷等不到消息事件）
    let alive = true;
    // 坞上下文的 activeSessionId 是 string；卷号 API（isSessionBlank / sessionComposition）
    // 收 number——两处转换集中在这里
    const sidNum = activeSessionId == null ? null : Number(activeSessionId);
    const sid = sidNum != null && Number.isFinite(sidNum) ? sidNum : null;
    const refresh = () => {
      if (!alive) return;
      if (sid == null) {
        // 无主态：显示全局默认（新卷出生默认）
        setCompInfo({ presetId: presetSelected, source: 'global', error: null });
        setCompBlank(true);
        return;
      }
      // 读面缺席（桩 core / 旧句柄）→ 保守当「空白可拨」+ 显示全局默认，
      // 不炸坞（能力位语义：句柄不实现 = 无读数，同 token 三能力位）
      setCompBlank(core?.isSessionBlank?.(sid) ?? true);
      void core
        ?.sessionComposition?.(sid)
        .then((info) => {
          if (alive) setCompInfo(info);
        })
        .catch(() => {});
    };
    refresh();
    // 本卷内容变化 = 可能刚跑过一轮（锁定态随之翻转）——订阅消息面
    const unsub = sid != null && core ? msgStoreFor(core.panelId, sid).subscribe(refresh) : undefined;
    return () => {
      alive = false;
      unsub?.();
    };
  }, [core, activeSessionId, presetRoster, presetSelected, compTick]);
  /** 芯片拨动：无主态写全局默认；有卷（空白）写卷级选择——拒绝原因就地可见。 */
  const onCompositionChange = useCallback(
    async (id: string) => {
      setCompOpen(false);
      if (activeSessionId == null) {
        if (!selectPreset(id)) notice(`组合「${id}」不可用——原因见设置 → Agent → 组合。`, 'error');
        return;
      }
      if (!core) return;
      const sidNum = Number(activeSessionId);
      if (!Number.isFinite(sidNum)) return;
      const r = (await core.selectSessionPreset?.(sidNum, id)) ?? {
        ok: false,
        reason: '本坞未接到组合写入口（旧句柄）',
      };
      if (!r.ok) {
        notice(`组合未切换：${r.reason}`, 'error');
        return;
      }
      // 写成功 = 本卷记录已变：主动重取读面（空白卷等不到消息事件）。
      // 2026-11-12：成功不再播报——芯片本身已变（toast 克制纪律：界面变化即反馈）。
      setCompTick((v) => v + 1);
    },
    [activeSessionId, core, notice],
  );
  const compLocked = activeSessionId != null && !compBlank;
  const compLabel = compInfo.presetId;
  /** 题签拨组合（V2）：纸期写的是**这张纸**的题签——真正的登记发生在开卷那一刻
   *  （`ChatCore.openDraftVolume` → `createSessionWithPreset`，严一档校验 + 卷级登记）。
   *  纸期不做校验：预设可能先坏后修，纸上不该出现「选了但没落账」的第二套拒绝语义。
   *  `paperId` = 目标纸（2026-11-29 多纸错位批）：多纸同屏时每张纸的行各写各的；
   *  缺省/`null` = 焦点那张（裸挂单件的旧语义）。 */
  const onDraftPresetChange = useCallback((id: string, paperId?: string | null) => {
    setCompOpen(false);
    useDraftSheetStore.getState().setPresetId(id, paperId ?? undefined);
  }, []);

  return {
    presetRoster,
    presetSelected,
    presetError,
    compOpen,
    setCompOpen,
    compInfo,
    compLocked,
    compLabel,
    onCompositionChange,
    onDraftPresetChange,
  };
}
