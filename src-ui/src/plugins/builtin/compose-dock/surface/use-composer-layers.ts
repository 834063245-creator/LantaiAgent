// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-layers — 创作坞的**本地浮层态**：律 / 引 / 墨 / 役 / 案（2026-11-17 P6 拆出）。
//
// 归组判据（施工单）：**这组状态是否随同一个事件变化**——五枚浮层共享两条规则，
// 且只有这两条规则：
//   ① **互斥**（2026-09-01 审计）：同屏只开一个——此前各 onClick 只关自己认识的
//      兄弟面板，浮层可叠开（截图实证）。2026-10-22 P2：翰改开全局命令面板
//      （模态、自带互斥），不在此列。2026-11-06 合并 A：思考档位不再是独立浮层
//      ——它随模型弹层开合，ModelSelector 的外点关闭/toggle 就是它的收合路径。
//   ② **切卷清态**（C2 2026-08-27）：展开中的浮层不跨会话残留（A 卷的展开状态带到
//      B 卷是认知噪音）。2026-11-12：坞内提示改挂 toast 浮层（自带消散），切卷不再清它。
//
// 三个同族本地态也在这里（历史上与浮层记在同一张表里）：拖放入卷界栏（dragOver）、
// 历史眉批一次性提示（histHint，含它自己的 6s 自散），以及**引面板的内部读数**
// （yinQuery / yinFiles / yinIdx）——引是五态之一，它的读数随它开合，跟着它走才是同一刀。
//
// ⚠ 两处「显式触发器」写进 effect/memo 体里（`void x`），不再需要 biome-ignore：
// 切卷清的 activeSessionId、引高亮复位的 yinQuery 都只作为**信号**存在。

import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flattenDirEntries, fuzzyMatchFiles } from './../composer-helpers';
import { kernelListDirectory, useShellStore } from './../host';

/** 坞内浮层族（2026-11-28「案」抽屉退役：'help' / 'scheme' 随抽屉与律册搬走——
 *  律 → 全局搜索的 `app/HelpSheet`；组合/图版/造模式各有自带入口）。 */
export type ComposerLayer = 'yin' | 'ink' | 'work';

export interface ComposerLayersInput {
  /** 上下文卷位（切卷清态的判据；纸期恒 null）。 */
  activeSessionId: string | null;
}

export interface ComposerLayersState {
  yinOpen: boolean;
  setYinOpen: Dispatch<SetStateAction<boolean>>;
  inkOpen: boolean;
  setInkOpen: Dispatch<SetStateAction<boolean>>;
  workOpen: boolean;
  setWorkOpen: Dispatch<SetStateAction<boolean>>;
  histHint: boolean;
  showHistHint: () => void;
  toggleLayer: (layer: ComposerLayer) => void;
  /** 引：查询词 / 清单缓存 / 高亮下标 / 面板输入框句柄。 */
  yinQuery: string;
  setYinQuery: (v: string) => void;
  yinFiles: Array<{ path: string; name: string }>;
  /** 过滤后的命中清单（面板直接渲染）。 */
  yinMatches: Array<{ path: string; name: string }>;
  yinIdx: number;
  setYinIdx: Dispatch<SetStateAction<number>>;
  yinInputRef: RefObject<HTMLInputElement | null>;
  /** 拖放入卷界栏高亮。 */
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
}

export function useComposerLayers({ activeSessionId }: ComposerLayersInput): ComposerLayersState {
  const [yinOpen, setYinOpen] = useState(false);
  const [inkOpen, setInkOpen] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [histHint, setHistHint] = useState(false);

  /* ── 创作坞 v2（2026-08-31）本地态：引（文件）/ 拖放入卷界栏 ── */
  const [yinQuery, setYinQuery] = useState('');
  const [yinFiles, setYinFiles] = useState<Array<{ path: string; name: string }>>([]);
  const [yinIdx, setYinIdx] = useState(0);
  const yinInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  /* ── C2（2026-08-27）：切卷清理本地态——展开中的浮层面板不跨会话残留
   *    （A 卷的展开状态带到 B 卷是认知噪音）。
   *    v2 增补：律/引面板同属本地态，一并清。
   *    2026-11-06 合并 A：思考档位不再是本地展开态——它随模型弹层开合，
   *    切卷时弹层由 ModelSelector 自己的外点/blur 收合，本表无须代管。
   *    2026-11-12：坞内提示改挂 toast 浮层（自带消散），切卷不再需要清它。 ── */
  useEffect(() => {
    void activeSessionId; // 切卷触发器：正是要响应它变化清本地态
    setYinOpen(false);
    setInkOpen(false);
    setWorkOpen(false);
    setHistHint(false);
  }, [activeSessionId]);

  /* ── 浮层互斥（2026-09-01 审计）：引/墨/役 同屏只开一个 ──
   * 2026-11-28 起族里只剩三件：律册搬去全局搜索（自带模态互斥），「案」抽屉整只退役。 */
  const toggleLayer = useCallback((layer: ComposerLayer) => {
    setYinOpen(layer === 'yin' ? (v) => !v : false);
    setInkOpen(layer === 'ink' ? (v) => !v : false);
    setWorkOpen(layer === 'work' ? (v) => !v : false);
  }, []);

  /* ── 引：工作区文件模糊引用（v2 2026-08-31）。
   *    数据源 = list_directory 递归（Rust 护栏：深 3 层 / 2000 项 / ignore
   *    过滤）；打开拉全量缓存在组件态，输入即子序列过滤。 ── */
  const loadYinFiles = useCallback(async () => {
    const pp = useShellStore.getState().projectPath;
    if (!pp) return;
    try {
      const entries = await kernelListDirectory(pp, true);
      setYinFiles(flattenDirEntries(entries));
    } catch {
      setYinFiles([]);
    }
  }, []);
  // 面板开合副作用：开 = 清查询 + 首开拉清单 + 聚焦输入框。
  // 依赖含 yinFiles.length：清单从空变非空会重跑本 effect，但此时
  // length===0 为假不再拉取——无环路；失败保持空 → 也不重跑（无死循环）。
  useEffect(() => {
    if (!yinOpen) return;
    setYinQuery('');
    setYinIdx(0);
    if (yinFiles.length === 0) void loadYinFiles();
    yinInputRef.current?.focus();
  }, [yinOpen, loadYinFiles, yinFiles.length]);
  const yinMatches = useMemo(() => fuzzyMatchFiles(yinFiles, yinQuery), [yinFiles, yinQuery]);

  // 查询词变化 → 高亮复位首项（滚动归零在面板件内）
  useEffect(() => {
    void yinQuery; // 查询词变化触发器：正是要响应它复位高亮
    setYinIdx(0);
  }, [yinQuery]);

  /* ── 历史眉批（v2 2026-08-31）：一次性提示——有历史且从未提示过时，
   *    首次聚焦浮现 6s（localStorage 旗标，毒化容忍；判据在坞，本件只管自散）。 ── */
  const showHistHint = useCallback(() => {
    setHistHint(true);
    window.setTimeout(() => setHistHint(false), 6000);
  }, []);

  return {
    yinOpen,
    setYinOpen,
    inkOpen,
    setInkOpen,
    workOpen,
    setWorkOpen,
    histHint,
    showHistHint,
    toggleLayer,
    yinQuery,
    setYinQuery,
    yinFiles,
    yinMatches,
    yinIdx,
    setYinIdx,
    yinInputRef,
    dragOver,
    setDragOver,
  };
}
