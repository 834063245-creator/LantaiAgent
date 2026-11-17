// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-attach — 创作坞的**附件与入卷面**（2026-11-17 P6 拆出；语义零新增）。
//
// 归组判据（施工单）：这组动作**随同一个事件变化**——都落在「往这一卷里塞东西」：
// 夹选（文件选择器）、移除附件/附图、粘贴附图、引面板入卷、拖文件入卷。
//
// ⚡ 两条语义判据原样搬来（是判据不是注释，搬家不能丢）：
//   ① **声明面不再是粘贴门禁**（2026-09-19）：把图一律收进附图道，声明只决定
//      「要不要提示」。旧行为「非 vision 模型贴图直接忽略」= 用户意图被静默丢弃，
//      与 agent 侧「一律先发、被拒再降级」自相矛盾。
//   ② **附文件入卷不再按 imageCapable 分流**（2026-09-22）：声明缺失时用户拖进来的图
//      会静默变成「路径附件」（实测就是「拖放失灵」）；声明面只作 UI 提示。
//
// 拖放走的是 Tauri 原生 onDragDropEvent（T2 WebView dragDropEnabled 默认接管，
// HTML5 drop 永不触发——C10 尸检）；mock 模式（浏览器 dev / vitest）watch 内部 no-op。

import type { ClipboardEvent, KeyboardEvent, RefObject } from 'react';
import { useCallback, useEffect } from 'react';
import type { ChatCore } from '../host';
import { extractImageFiles, getChatStore, watchFileDragDrop } from '../host';

export interface ComposerAttachInput {
  core: ChatCore | null;
  imageCapable: boolean;
  notice: (text: string, level?: 'info' | 'warn' | 'error') => void;
  /** 坞体外壳（拖放命中的判据是它的盒子）。 */
  dockRef: RefObject<HTMLDivElement | null>;
  /** 界栏高亮写面（浮层态归 use-composer-layers）。 */
  setDragOver: (v: boolean) => void;
  /** 输入框句柄（引入卷后把焦点还回去）。 */
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** 引面板的读数与写面（归 use-composer-layers；此处只读它、只调它）。 */
  yin: {
    matches: ReadonlyArray<{ path: string; name: string }>;
    idx: number;
    setIdx: (updater: (i: number) => number) => void;
    close: () => void;
  };
}

export function useComposerAttach({
  core,
  imageCapable,
  notice,
  dockRef,
  setDragOver,
  composerRef,
  yin,
}: ComposerAttachInput) {
  /* ── 附件 ── */
  const onAttach = useCallback(() => {
    void core?.openFilePicker();
  }, [core]);
  const onRemoveAttached = useCallback(
    (idx: number) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().removeAttachedFile(idx);
    },
    [core],
  );
  const onRemoveAttachedImage = useCallback(
    (idx: number) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().removeAttachedImage(idx);
    },
    [core],
  );

  /* ── 粘贴附图（B2 2026-09-08）：clipboardData.items kind='file' 且 mime 为
   *    图片 → 附图道；文本粘贴零影响。
   *    ⚡ 语义变更（2026-09-19）：**声明面不再是粘贴门禁**。旧行为「非 vision
   *    模型贴图直接忽略」= 用户意图被静默丢弃（图没收、没缩略图、没提示对象，
   *    连路径都不留）——与 agent 侧新发送策略（先发、被拒再降级，见 agent.ts
   *    streamOnce 附图分支注）自相矛盾：那边已改为「一律先发」，这边却仍按声明
   *    把图拦在门外。现在图一律收进附图道，声明只决定**要不要提示**。
   *    注：夹选 / 拖放（attachPaths）仍按声明分流走路径附件——那是**有意的**
   *    文本模型语义（图作文件引用，模型可按路径读取），非静默丢弃，故不在此列。 ── */
  const onComposerPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = extractImageFiles(e.clipboardData.items);
      if (files.length === 0) return; // 文本/非图片粘贴走默认
      e.preventDefault();
      // 收图无条件——发送面会兜底（真被服务商拒 → 记档 + 改文字占位重发）
      void core?.intakeImageFiles(files);
      if (!imageCapable) {
        notice('当前模型未声明图片输入——图已收；若服务商拒收会自动改用文字转述（可在设置行换 vision 模型）', 'warn');
      }
    },
    [core, imageCapable, notice],
  );

  /* ── 附文件入卷共用底座（引 / 拖放，v3 B2）：图片入附图道，其余走路径附件老路
   *    （C10 语义保留：size 恒 0 不显示——拿不到真大小就不伪造）。
   *    ⚡ 2026-09-22：不再按 `imageCapable` 分流——声明缺失时用户拖进来的图会静默
   *    变成「路径附件」（实测就是「拖放失灵」）；声明面只作 UI 提示。 ── */
  const attachPaths = useCallback(
    (paths: readonly string[]) => {
      if (!core || paths.length === 0) return;
      void core.attachIntakePaths(paths);
    },
    [core],
  );

  /** 引面板选中一条 = 入卷 + 散面板 + 焦点回正文。 */
  const onYinAttach = useCallback(
    (f: { path: string; name: string }) => {
      attachPaths([f.path]);
      yin.close();
      composerRef.current?.focus();
    },
    [attachPaths, yin, composerRef],
  );

  /* ── 引面板键盘（↑↓ 选 / Enter 入卷 / Esc 散）——面板自己的键义，与正文历史无关 ── */
  const onYinKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        yin.close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        yin.setIdx((i) => Math.min(i + 1, Math.max(0, yin.matches.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        yin.setIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = yin.matches[yin.idx];
        if (hit) onYinAttach(hit);
      }
    },
    [yin, onYinAttach],
  );

  /* ── 拖文件入卷（v2 2026-08-31）：Tauri onDragDropEvent 原生通道——
   *    T2 WebView dragDropEnabled 默认接管，HTML5 drop 永不触发（C10 尸检）。
   *    界栏 = 拖拽悬停坞体时高亮；松手命中坞体才入卷（落画布其它处不抢）。
   *    mock 模式（浏览器 dev / vitest）watch 内部 no-op。 ── */
  useEffect(() => {
    if (!core) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void watchFileDragDrop((e) => {
      if (!alive) return;
      if (e.phase === 'leave') {
        setDragOver(false);
        return;
      }
      const rect = dockRef.current?.getBoundingClientRect();
      const inside = rect ? e.x >= rect.left && e.x <= rect.right && e.y >= rect.top && e.y <= rect.bottom : false;
      if (e.phase === 'drop') {
        setDragOver(false);
        if (inside) attachPaths(e.paths);
        return;
      }
      setDragOver(inside);
    })
      .then((u) => {
        if (alive) unlisten = u;
        else u?.();
      })
      .catch((e) => console.warn('[composer] 拖放入卷监听注册失败（mock/早期窗口常态）:', e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [core, attachPaths, dockRef, setDragOver]);

  return { onAttach, onRemoveAttached, onRemoveAttachedImage, onComposerPaste, attachPaths, onYinAttach, onYinKeyDown };
}
