// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-rows — 创作坞的**行件与抽屉**（2026-11-17 上帝文件治理 P6 拆出；语义零新增）。
//
// 这个文件只装「坞里可数的两块面」：输入行（`<InputRow />`）、设置行（`<SettingsRow />`）。
// **2026-11-28：「案」分诊抽屉（`<SchemeDrawer />`）整只退役**——组合有卷首芯片与纸上题签、
// 图版就是坞下那排架、翰 = Ctrl+K 本身、造模式 = 落纸后题签选 creator、律（快捷键总览）搬进
// 全局搜索（`app/HelpSheet.tsx`）。判据是**宿主无关**——每件只吃 props、
// 不碰 core/store（组合拨动、命令面板、快捷键开合、发送与区段动作全由坞注入），
// 所以坞的两种宿主（dock / sheet）共用同一份。搬家不是重设计：坞仍持有全部状态。
//
// ⚠ 拆分的纪律（本次施工单第 4 条）：原样搬、props 全展开、不在搬家这一刀里合并
// props。抽屉这 15 个 props 很难看，但合并它们（例如把 compOpen/compInfo/compTick
// 收成一个 useCompositionChip）是**另一次改造**——混进来 = diff 不可审。

import type { ChangeEvent, ClipboardEvent, KeyboardEvent, RefObject } from 'react';
import type { ChatImageRef, CommandContribution, PermissionMode } from './host';
import { MODE_DESCRIPTIONS, MODE_LABELS, PERMISSION_MODES, previewUrlFor } from './host';
import { ModelSelector } from './ModelSelector';
import { SheetSign } from './sheet-parts';
import { SlashPanel } from './slash-panel';

/** 输入行（原坞主体）：斜杠面板 / 引面板 / 附图预览 / textarea / 引夹案三钮 /
 *  附件 chip / 附图 rail / 停或拟文。 */
export interface InputRowProps {
  /** 输入框句柄（坞持有：注册命令式接口、autoGrow、历史导航都要它）。 */
  composerRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  inputText: string;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /* 斜杠（C3）：面板**开** = 查询词非空——判据与坞同一把尺子（由坞给，本件不自算，
     否则「零命中」的空态会被误判成「没开」而整块消失）*/
  slashCommands: readonly CommandContribution[];
  slashQuery: string | null;
  slashIdx: number;
  slashHit: string;
  onSlashHover: (idx: number) => void;
  onSlashCommit: (cmd: CommandContribution) => void;
  /* 引（工作区文件模糊引用）*/
  yinOpen: boolean;
  yinQuery: string;
  onYinQuery: (v: string) => void;
  yinMatches: ReadonlyArray<{ path: string; name: string }>;
  yinIdx: number;
  onYinHover: (idx: number) => void;
  yinEmpty: string;
  yinInputRef: RefObject<HTMLInputElement | null>;
  onYinKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onYinAttach: (f: { path: string; name: string }) => void;
  /* 附图 rail（缩略图 + 移除；大图预览是坞的全局模态，行件只报「点了哪张」） */
  onPreviewImage: (img: ChatImageRef) => void;
  attachedFiles: ReadonlyArray<{ path: string; name: string }>;
  attachedImages: ReadonlyArray<ChatImageRef>;
  onRemoveAttached: (idx: number) => void;
  onRemoveAttachedImage: (idx: number) => void;
  /* 引 / 夹两钮（「案」随抽屉退役，2026-11-28） */
  onToggleYin: () => void;
  onAttach: () => void;
  /* 发送 / 停止 */
  running: boolean;
  onSend: () => void;
  onAbort: () => void;
}

export function InputRow(props: InputRowProps) {
  const {
    composerRef,
    placeholder,
    inputText,
    onPaste,
    onChange,
    onFocus,
    onKeyDown,
    slashCommands,
    slashQuery,
    slashIdx,
    slashHit,
    onSlashHover,
    onSlashCommit,
    yinOpen,
    yinQuery,
    onYinQuery,
    yinMatches,
    yinIdx,
    onYinHover,
    yinEmpty,
    yinInputRef,
    onYinKeyDown,
    onYinAttach,
    onPreviewImage,
    attachedFiles,
    attachedImages,
    onRemoveAttached,
    onRemoveAttachedImage,
    onToggleYin,
    onAttach,
    running,
    onSend,
    onAbort,
  } = props;
  return (
    <div className="pp-composer-row">
      {slashQuery !== null && (
        <SlashPanel
          commands={slashCommands}
          activeIdx={slashIdx}
          query={slashHit}
          onHover={onSlashHover}
          onCommit={onSlashCommit}
        />
      )}
      {/* 引（v2）：工作区文件模糊引用——面板 = 查询输入 + 命中清单 */}
      {yinOpen && (
        <div className="pp-yin-panel">
          <input
            ref={yinInputRef}
            type="text"
            value={yinQuery}
            placeholder="引……（文件名或路径片段 · Enter 入卷 · Esc 散）"
            aria-label="引：检索工作区文件"
            onChange={(e) => onYinQuery(e.target.value)}
            onKeyDown={onYinKeyDown}
          />
          <div className="pp-yin-list" role="listbox" aria-label="工作区文件">
            {yinMatches.map((f, i) => (
              <button
                key={f.path}
                type="button"
                role="option"
                aria-selected={i === yinIdx}
                className={`pp-yin-item${i === yinIdx ? ' active' : ''}`}
                onMouseEnter={() => onYinHover(i)}
                onClick={() => onYinAttach(f)}
              >
                <span className="pp-yin-name">{f.name}</span>
                <span className="pp-yin-path">{f.path}</span>
              </button>
            ))}
            {yinMatches.length === 0 && <div className="pp-yin-empty">{yinEmpty}</div>}
          </div>
        </div>
      )}
      {/* 2026-10-22 P1 左轴：textarea 必须是输入行的**第一个布局件**——书眉卷名、
          设置行、输入正文自此共用一条左缘（旧序把 引/夹 放前面，正文被顶开 88px，
          同一张坞三条左缘）。引/夹/附件/附图一律排到它右侧（靠近拟文印 = 落笔前
          顺手的动作）。浮层（引）是 absolute，不参与这条轴。
          ⚠ 本判据由 tests/composer-dock-row-order.test.tsx 逐件钉死——挪序即红。 */}
      <textarea
        ref={composerRef}
        rows={1}
        value={inputText}
        placeholder={placeholder}
        onPaste={onPaste}
        onChange={onChange}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className={`pp-attach pp-yin-btn${yinOpen ? ' open' : ''}`}
        data-tip="引用工作区文件入卷"
        aria-label="引：引用文件"
        onClick={onToggleYin}
      >
        引
      </button>
      <button type="button" className="pp-attach" data-tip="附文件入卷" aria-label="拾遗：附加文件" onClick={onAttach}>
        夹
      </button>

      {attachedFiles.length > 0 && (
        <div className="pp-attach-list">
          {attachedFiles.map((f, i) => (
            <button
              key={f.path}
              type="button"
              className="pp-attach-chip"
              data-tip={f.path}
              data-tip-hint="点击移除"
              onClick={() => onRemoveAttached(i)}
            >
              {f.name} ✕
            </button>
          ))}
          {attachedFiles.length > 3 && <span className="pp-attach-count">共 {attachedFiles.length} 件</span>}
        </div>
      )}
      {/* 附图 rail（B2 multimodal-image-plan）：缩略图 + 移除 + 点击放大。
          预览 URL 为进程内存态（准入时种——seedPreviewUrl），未命中降级为占位盒。 */}
      {attachedImages.length > 0 && (
        <div className="pp-image-rail">
          {attachedImages.map((img, i) => {
            const url = previewUrlFor(img.id);
            return (
              <div key={img.id} className="pp-image-thumb-wrap">
                <button
                  type="button"
                  className="pp-image-thumb"
                  data-tip={img.name ?? '附图'}
                  aria-label={`预览附图：${img.name ?? img.id.slice(0, 8)}`}
                  onClick={() => onPreviewImage(img)}
                >
                  {url ? (
                    <img src={url} alt={img.name ?? '附图'} loading="lazy" />
                  ) : (
                    <span className="pp-image-thumb-fallback">{img.name ?? img.id.slice(0, 8)}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="pp-image-remove"
                  data-tip="移除附图"
                  data-tip-hint={img.name ?? undefined}
                  aria-label={`移除附图 ${i + 1}`}
                  onClick={() => onRemoveAttachedImage(i)}
                >
                  ✕
                </button>
              </div>
            );
          })}
          {attachedImages.length > 1 && <span className="pp-attach-count">共 {attachedImages.length} 图</span>}
        </div>
      )}
      {running && !inputText.trim() ? (
        <button
          type="button"
          className="pp-stop"
          data-tip="停止当前回合"
          data-tip-hint="级联停止子 Agent"
          aria-label="停止"
          onClick={onAbort}
        >
          停
        </button>
      ) : (
        <button
          type="button"
          className="pp-send"
          disabled={!inputText.trim()}
          data-tip={running ? '插入回合' : inputText.trim() ? '发送本轮输入' : '先落笔'}
          data-tip-hint={running ? 'Agent 运行中，下轮生效' : inputText.trim() ? undefined : '有内容才可拟文'}
          onClick={onSend}
        >
          拟文
        </button>
      )}
    </div>
  );
}
/** 设置行（2026-11-09 用户裁定：模型与权限**另起一行**；同日再裁：**权限在左、模型在右**）
 *  ⚡ 2026-11-15 V2：纸期这一行整行换成**题签**（组合 + 模型）；
 *  坞期不变——两处不是两个入口，是**同一个面的两种宿主**。
 *  ——只放两件，它们同属「这一趟怎么跑」，与书眉的「这一卷的账」分家。
 *  位置对调（2026-11-09 二次裁定）：**权限居左、模型收右**。
 *  判据：权限是**底线**（全放/半放/常询决定 Agent 能做什么），先读它；模型是这一行的
 *  长值，收右端与书眉的读数对齐（右缘同一条线），行左留给"这一趟的闸"。
 *  行内仍走 §11 锚点型选中（权限 = 重墨 + 朱砂底线），不新增第三种语言。 */
export interface SettingsRowProps {
  isSheet: boolean;
  /** 行的宿主标记（CSS 按变体分叉）。 */
  variant: string;
  /* 纸期题签（组合）*/
  compLabel: string;
  compOpen: boolean;
  presetError: string | null;
  presetRoster: ReadonlyArray<{
    id: string;
    patch: unknown;
    error?: string;
    metadata?: { name?: string; description?: string };
  }>;
  onCompToggle: () => void;
  onDraftPresetPick: (id: string) => void;
  /* 坞期权限三分 */
  permissionMode: PermissionMode;
  onSelectMode: (m: PermissionMode) => void;
  /* 模型 + 思考（两种宿主共用）*/
  model: string;
  providerName: string;
  providerKind: string;
  running: boolean;
  thinking: {
    value: string;
    label: string;
    options: ReadonlyArray<{ value: string; label: string; hint: string }>;
    onChange: (value: string) => void;
  };
  onModelChange: (modelId: string, desc?: { vendor: string }) => void;
  onModelBlocked: () => void;
}

export function SettingsRow(props: SettingsRowProps) {
  const {
    isSheet,
    variant,
    compLabel,
    compOpen,
    presetError,
    presetRoster,
    onCompToggle,
    onDraftPresetPick,
    permissionMode,
    onSelectMode,
    model,
    providerName,
    providerKind,
    running,
    thinking,
    onModelChange,
    onModelBlocked,
  } = props;
  return (
    <div className="pp-composer-settings" data-variant={variant}>
      {isSheet ? (
        <>
          <SheetSign
            label={compLabel}
            open={compOpen}
            error={presetError}
            roster={presetRoster}
            onToggle={onCompToggle}
            onPick={onDraftPresetPick}
          />
          <div className="pp-composer-settings-spacer" />
        </>
      ) : (
        <>
          <fieldset className="pp-mode-seg" aria-label="权限模式">
            {PERMISSION_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`pp-mode-opt${permissionMode === m ? ' selected' : ''}`}
                data-tip={MODE_DESCRIPTIONS[m]}
                aria-pressed={permissionMode === m}
                onClick={() => onSelectMode(m)}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </fieldset>
          <div className="pp-composer-settings-spacer" />
        </>
      )}
      <ModelSelector
        value={model}
        onChange={onModelChange}
        providerName={providerName}
        kind={providerKind}
        compact
        isStreaming={running}
        onBlocked={onModelBlocked}
        thinking={thinking}
      />
    </div>
  );
}
