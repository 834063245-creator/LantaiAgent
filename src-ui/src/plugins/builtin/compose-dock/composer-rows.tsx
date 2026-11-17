// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-rows — 创作坞的**行件与抽屉**（2026-11-17 上帝文件治理 P6 拆出；语义零新增）。
//
// 这个文件只装「坞里可数的几块面」：输入行（`<InputRow />`）、案·分诊抽屉
// （`<SchemeDrawer />`）、设置行（`<SettingsRow />`）。判据是**宿主无关**——每件只吃 props、
// 不碰 core/store（组合拨动、命令面板、快捷键开合、发送与区段动作全由坞注入），
// 所以坞的两种宿主（dock / sheet）共用同一份。搬家不是重设计：坞仍持有全部状态。
//
// ⚠ 拆分的纪律（本次施工单第 4 条）：原样搬、props 全展开、不在搬家这一刀里合并
// props。抽屉这 15 个 props 很难看，但合并它们（例如把 compOpen/compInfo/compTick
// 收成一个 useCompositionChip）是**另一次改造**——混进来 = diff 不可审。

import type { ChangeEvent, ClipboardEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import { HELP_GROUPS } from './dock-copy';
import type { ChatImageRef, CommandContribution, PermissionMode, PresetEntry } from './host';
import { MODE_DESCRIPTIONS, MODE_LABELS, PERMISSION_MODES, previewUrlFor } from './host';
import { ModelSelector } from './ModelSelector';
import { SheetSign } from './sheet-parts';
import { SlashPanel } from './slash-panel';

/** 组合读数（坞算好传进来；抽屉只渲染）。 */
export interface SchemeCompInfo {
  presetId: string;
  source: 'session' | 'global';
  error: string | null;
}

export interface SchemeDrawerProps {
  open: boolean;
  /** 跑过一轮的组合 = 只读标签（字节契约，见坞内组合段注）。 */
  compLocked: boolean;
  compLabel: string;
  compInfo: SchemeCompInfo;
  compOpen: boolean;
  onCompToggle: () => void;
  presetRoster: readonly PresetEntry[];
  presetError: string | null;
  /** 无活跃卷 = 拨的是**全局默认**（文案与提示随之换一档）。 */
  activeSessionId: string | null;
  activeSidNum: number | null;
  onCompositionChange: (id: string) => void;
  onCreatorDraft: () => void;
  helpOpen: boolean;
  onHelpToggle: () => void;
  onOpenPalette: () => void;
  /** 抽屉里「另起」段的两条动作都先自收——收口由坞给，件不自作主张。 */
  onClose: () => void;
}

/** 案 · 分诊抽屉（2026-11-08 丙案）：坞内唯一的浮层——原设置行那一整排
 *  （权限三档 / 组合芯片 / 造模式 / 役册 / 墨量册）与律册收进这里。
 *  形状：向上开（坞贴屏底），几何与役册/墨量册同源（right/bottom/z/宽/封高）。
 *  语汇：册页段题（方墨锚点 + 字距题字）+ 行型条目，不新增第三种选中语言。 */
export function SchemeDrawer({
  open,
  compLocked,
  compLabel,
  compInfo,
  compOpen,
  onCompToggle,
  presetRoster,
  presetError,
  activeSessionId,
  activeSidNum,
  onCompositionChange,
  onCreatorDraft,
  helpOpen,
  onHelpToggle,
  onOpenPalette,
  onClose,
}: SchemeDrawerProps) {
  if (!open) return null;
  return (
    // ⚠ 本件没有自己的盒：`.pp-scheme-panel` 是**绝对定位**（底缘贴输入行上沿、右对齐），
    // 它量的是最近的定位祖先——那个祖先必须是输入行 `.pp-composer-row`（CSS 注：
    // 「归**输入行**（它的触发钮住在那儿）」）。故调用点把它包在那一行里，本件只出内容。
    <div className="pp-scheme-panel" role="dialog" aria-label="案——本卷与引卷">
      <div className="pp-scheme-sec">
        <div className="pp-scheme-title">本卷</div>
        {/* 2026-11-09 用户裁定：**权限回到坞面常驻**（与模型同处设置行）——
            抽屉里这一行随之删除。抽屉仍负责组合 / 图版 / 造模式 / 翰 / 律。 */}
        <div className="pp-comp-sel" data-comp-chip>
          {compLocked ? (
            <span
              className="pp-scheme-row pp-comp-pill"
              data-locked
              data-tip={`本卷组合：${compLabel}`}
              data-tip-hint={
                compInfo.error
                  ? `${compInfo.error}——装配时已回退用户层组合`
                  : `来源：${compInfo.source === 'session' ? '本卷选择' : '全局默认'}；已跑过一轮不能中途换（另起一卷再选）`
              }
            >
              <span className="pp-scheme-k">组合</span>
              <span className="pp-comp-pill-label pp-scheme-v">{compLabel}</span>
            </span>
          ) : (
            <button
              type="button"
              className={`pp-scheme-row pp-comp-pill${compOpen ? ' open' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={compOpen}
              data-tip={activeSessionId == null ? `新卷默认组合：${compLabel}` : `本卷组合：${compLabel}`}
              data-tip-hint={
                compInfo.error
                  ? compInfo.error
                  : activeSessionId == null
                    ? '改这里 = 改全局默认'
                    : '空白卷可拨；跑过一轮即锁定'
              }
              onClick={onCompToggle}
            >
              <span className="pp-scheme-k">组合</span>
              <span className="pp-comp-pill-label pp-scheme-v">{compLabel}</span>
              <span className="pp-comp-pill-caret" aria-hidden="true">
                ▾
              </span>
            </button>
          )}
        </div>
        {compOpen && !compLocked && (
          <div className="pp-comp-menu pp-comp-menu-inline" role="listbox" aria-label="组合（preset）">
            {presetRoster.map((pr) => (
              <button
                key={pr.id}
                type="button"
                role="option"
                aria-selected={pr.id === compLabel}
                className={`pp-comp-opt${pr.id === compLabel ? ' selected' : ''}`}
                disabled={pr.patch === null}
                data-tip={pr.patch === null ? '装载失败' : pr.metadata?.description}
                data-tip-hint={pr.patch === null ? (pr.error ?? 'roster.patch.yml 不可用') : undefined}
                onClick={() => onCompositionChange(pr.id)}
              >
                {pr.metadata?.name ?? pr.id}
                {pr.patch === null ? '（损坏）' : ''}
              </button>
            ))}
            {presetError && <div className="pp-comp-note">⚠ {presetError}</div>}
          </div>
        )}
        <div className="pp-scheme-row">
          <span className="pp-scheme-k">图版</span>
          <span className="pp-scheme-v">{activeSidNum != null ? '架在匣下' : '—'}</span>
        </div>
      </div>

      <div className="pp-scheme-sec">
        <div className="pp-scheme-title">另起</div>
        <button
          type="button"
          className="pp-scheme-row"
          data-tip="让 Agent 帮你做一个模式"
          data-tip-hint="起一卷 creator：说完需求，它写出组合并落盘；之后在新卷上选它"
          onClick={() => {
            onClose();
            onCreatorDraft();
          }}
        >
          <span className="pp-scheme-k">✎ 造模式</span>
          <span className="pp-scheme-v">起一卷 creator</span>
        </button>
        <button
          type="button"
          className="pp-scheme-row"
          data-tip="命令面板"
          data-tip-hint="Ctrl+K 同一份：搜索 / 分组 / 动作与插件命令"
          onClick={() => {
            onClose();
            onOpenPalette();
          }}
        >
          <span className="pp-scheme-k">翰</span>
          <span className="pp-scheme-v">命令面板（Ctrl+K）</span>
        </button>
        {/* 2026-11-09：律册从书眉浮层改为**抽屉内就地展开**——书眉那枚「律」钮
            已撤（与这里重复），浮层原先靠它定位。现在展开态就在抽屉里继续往下长。 */}
        <button
          type="button"
          className={`pp-scheme-row${helpOpen ? ' open' : ''}`}
          aria-expanded={helpOpen}
          data-tip="快捷键总览"
          onClick={onHelpToggle}
        >
          <span className="pp-scheme-k">律</span>
          <span className="pp-scheme-v">{helpOpen ? '收起' : '快捷键总览'}</span>
        </button>
        {helpOpen && (
          <section className="pp-help-inline" aria-label="快捷键总览">
            {HELP_GROUPS.map((g) => (
              <div key={g.title} className="pp-help-group">
                <div className="pp-help-group-title">{g.title}</div>
                {g.rows.map(([key, desc]) => (
                  <div key={key} className="pp-help-row">
                    <span className="pp-help-key">{key}</span>
                    <span className="pp-help-desc">{desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
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
  /* 三钮 */
  schemeOpen: boolean;
  onToggleYin: () => void;
  onAttach: () => void;
  onToggleScheme: () => void;
  /* 发送 / 停止 */
  running: boolean;
  onSend: () => void;
  onAbort: () => void;
  /** 抽屉（案·分诊）：`.pp-scheme-panel` 是绝对定位、定位祖先是**本行**（CSS 注），
   *  故由坞渲染后作为 children 落进来——不能挪到行外。 */
  children?: ReactNode;
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
    schemeOpen,
    onToggleYin,
    onAttach,
    onToggleScheme,
    running,
    onSend,
    onAbort,
    children,
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

      {/* 案（2026-11-08 丙案）：坞内唯一的分诊抽屉入口——权限 / 组合 / 造模式 /
          图版 / 律 收在这里。它替代的是原设置行那一整排常驻控件（坞面 13 件 → 5 件）。
          位置：引/夹之后、拟文之前（都是"落笔前的动作"）。 */}
      <button
        type="button"
        className={`pp-attach pp-scheme-btn${schemeOpen ? ' open' : ''}`}
        data-tip="案 —— 本卷与引卷"
        data-tip-hint="权限 / 组合 / 造模式 / 图版 / 快捷键，收在这一处"
        aria-label="案——本卷设置"
        aria-haspopup="dialog"
        aria-expanded={schemeOpen}
        onClick={onToggleScheme}
      >
        案
      </button>

      {/* 案 · 分诊抽屉落位（坞注入）：`.pp-scheme-panel` 是绝对定位，其定位祖先是
       **本行**（CSS：几何同役册/墨量册，但归输入行——触发钮住在这儿）。 */}
      {children}

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
