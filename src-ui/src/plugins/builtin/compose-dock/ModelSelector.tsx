// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector — 可搜索的下拉组合框，用于从目录中选择模型。
// 支持自由输入目录中不存在的自定义模型名称（设置页字段形态）。
//
// 2026 徽章收口：模型行只留模型本身（id + 人类名）——原 LIVE / 🧠 /
// 上下文窗口 chip / vendor-hint 与字段形态下方的「推理/上下文/来自 API」
// 标签组全部拆除（视觉噪声 + 挡字），元数据信息移入行 title（hover 可见）
// 不丢失。判定动态（无目录元数据）内联为 contextWindow <= 0。
//
// 2026-08-29 frontend-overlay-a11y-plan 档位 C：手写 combobox（handleKeyDown /
// role=listbox/option/aria-activedescendant 手工接线）整体换成 @react-aria/combobox
// 的 useComboBox + useListBox/useOption。保留：分组表头 / compact 触发按钮 /
// 元数据徽标 / 空态文案 / 目录获取失败态。DOM 类名与布局不变。
//
// 2026-09-06 创作坞 UX 收口（compact 形态重做）：
//   - 触发器恒驻：打开时不再被搜索输入框整体顶替（旧形态触发 pill 消失、
//     空输入顶上——「当前模型被清空」的视觉错觉根因）；
//   - 搜索输入移进弹层（弹层 = 搜索行 + 列表滚动区，DSH chip 形态）；
//   - 外点关闭：document mousedown 兜底——画布空白处 mousedown preventDefault
//     （平移手势）拦得掉 blur，react-aria 的 blur 关闭永不触发，必须显式听
//     （DSH ModelSelect closeOutside 同款）；
//   - 触发器再点 = toggle 收起；Escape 收起并回焦触发器；
//   - compact 下 onSelectionChange 忽略空键：外点/blur 的 react-aria
//     commitCustomValue 会以半截查询回调 onChange——弹层取消语义，不误写库
//     （自定义模型名提交仍属设置页字段形态）。
// 非 compact（设置页字段）形态零改动。
//
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享
// 真实例；@react-aria/* react-stately 由 esbuild 内联（其 react import 经
// 构建期别名桥共享宿主 React，零副本）。

import { useComboBox } from '@react-aria/combobox';
import { useListBox, useOption } from '@react-aria/listbox';
import type { ComboBoxState } from '@react-stately/combobox';
import { useComboBoxState } from '@react-stately/combobox';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Item } from 'react-stately';
import type { ModelDescriptor, Protocol } from './host';
import './model-selector.css';
import {
  effectiveModels,
  findModels,
  getDynamicFetchFailure,
  getDynamicFetchInflight,
  getModel,
  hasDynamicFetchInflight,
  iconHtml,
  loadSettings,
  modelInput,
  onDynamicFetchChange,
  onSettingsSaved,
  resolveApiKey,
  searchModels,
} from './host';

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string, desc?: ModelDescriptor) => void;
  /** 当前 provider 名称 — 默认列表只显示该 vendor 的模型。 */
  providerName: string;
  /** Provider 类型 — 按匹配的 API 协议过滤目录。 */
  kind: Protocol;
  /** rework P2-1：紧凑触发器形态（创作坞底部用）——收起态 = 按钮（厂商 monogram +
   *  人类模型名 + 箭头），空查询列出全部已配置 provider 的「可用模型」（配置面，
   *  跨 vendor 直接选）。缺省 = 设置页字段形态不变。 */
  compact?: boolean;
  /** DSH 移植（2026-08-26）：运行中守卫——为 true 时打开被拦（DSH onAttemptOpen
   *  语义：流式中不允许切模型），回调 onBlocked 让宿主提示（创作坞挂 localNotice）。 */
  isStreaming?: boolean;
  /** 运行中被拦时的回调。 */
  onBlocked?: () => void;
}

/** 各已配置 provider 的「可用模型」并集（创作坞可选面，DSH routable 列表语义）。
 *  来源 = ProviderSettings.models（缺省回落 [model]），不是静态目录全集——
 *  用户配了哪些，下拉就列哪些。id 有目录元数据 → 用目录描述符（名字/协议等）；
 *  目录外 id → 合成最小描述符。⚠️ vendor 一律用 provider 名（连接身份），不是目录
 *  厂商名——自定义 provider（my-gateway）复用目录模型 id 时，分组与切换目标都对
 *  准该 provider，不落到目录厂商（写错家 400 的同族病根）。
 *  @param settings 由调用方读取（settingsTick 触发重读），本函数不自己 loadSettings。 */
function configuredModelDescriptors(settings: ReturnType<typeof loadSettings>): ModelDescriptor[] {
  try {
    const out: ModelDescriptor[] = [];
    for (const p of settings.providers) {
      for (const id of effectiveModels(p)) {
        const known = getModel(id);
        // B5：input 走 modelInput 合并（覆盖 ?? 目录）——「视」徽标与附图门禁
        // 同链，自定义 vision 模型补声明后徽标即亮
        if (known) {
          out.push({ ...known, vendor: p.name, input: modelInput(p, id) });
        } else {
          out.push({
            id,
            name: id,
            kind: p.kind,
            vendor: p.name,
            baseUrl: p.baseUrl || '',
            reasoning: false,
            input: modelInput(p, id),
            contextWindow: 0,
            maxTokens: 0,
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 集合键：vendor/id（跨 vendor 可共享 id，键必须唯一）。 */
function itemKey(m: ModelDescriptor): string {
  return `${m.vendor}/${m.id}`;
}

export function ModelSelector({
  value,
  onChange,
  providerName,
  kind,
  compact,
  isStreaming,
  onBlocked,
}: ModelSelectorProps) {
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listBoxRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<Element | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // R3b（2026-09-06）：紧凑形态的可选面 = 已配置 provider 的模型列表——settings 保存
  // （含「添加提供方即时生效」）后必须立刻重读，新提供方/新模型才可选。订阅
  // onSettingsSaved 使下拉可选面随保存即时刷新（打开期间保存也能当场看到新家）。
  const [settingsTick, setSettingsTick] = useState(0);
  useEffect(() => onSettingsSaved(() => setSettingsTick((n) => n + 1)), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: settingsTick 是刻意的重读触发器（保存事件/添加提供方 → 下拉可选面重快照），非响应值
  const settingsState = useMemo(() => loadSettings(), [settingsTick]);

  const results = useMemo(() => {
    const q = query.toLowerCase().trim();
    // 选择面：
    //   - 紧凑形态（compact=true，创作坞）= 各已配置 provider 的「可用模型」列表
    //     （ProviderSettings.models，缺省回落 [model]）并集——配了哪些列哪些，
    //     跨 vendor 直接选（rework P2-1），协议不互拦（精选列表每项自带 kind）。
    //   - 字段形态（compact=false，设置页）= 本家 vendor 目录（跨家走左侧切 provider）。
    // 查询词：compact 在配置面内过滤；字段形态走全目录搜索。
    let base: ModelDescriptor[];
    if (compact) {
      base = configuredModelDescriptors(settingsState);
      if (q) {
        base = base.filter(
          (m) =>
            m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.vendor.toLowerCase().includes(q),
        );
      }
    } else if (q) {
      base = searchModels(q);
    } else {
      // 字段形态（设置页）：本家目录行——input 合并本 provider 的覆盖声明
      // （「视」徽标与创作坞门禁同链，设置页补声明当场亮标）
      const providerRow = settingsState.providers.find((p) => p.name === providerName);
      base = findModels(providerName).map((m) => ({ ...m, input: modelInput(providerRow, m.id) }));
    }
    return base
      .filter((m) => compact || m.kind === kind)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 30);
  }, [query, kind, providerName, compact, settingsState]);

  // ── react-aria combobox 状态机：items = 已过滤结果（受控 → 不再二次过滤）──
  const state = useComboBoxState({
    items: results,
    children: (m: ModelDescriptor) => (
      <Item key={itemKey(m)} textValue={m.name}>
        {m.name}
      </Item>
    ),
    inputValue: query,
    onInputChange: setQuery,
    allowsCustomValue: true,
    allowsEmptyCollection: true,
    menuTrigger: 'focus', // 设置页字段形态：聚焦即开（对齐旧 onFocus 行为）
    selectedKey: value ? (compact ? `${providerName}/${value}` : value) : '',
    onSelectionChange: handleSelectionChange,
  });

  // useComboBox 装配（inputProps 接管 role/aria-activedescendant/keydown）
  const { inputProps, listBoxProps: comboboxListBoxProps } = useComboBox(
    {
      'aria-label': '模型选择',
      inputRef,
      listBoxRef,
      popoverRef,
    },
    state,
  );
  const { listBoxProps } = useListBox({ ...comboboxListBoxProps }, state, listBoxRef);

  /** 收起态人类可读名（rework P2-1：不再只露 model id）。 */
  const selectedHumanName = useMemo(() => getModel(value)?.name ?? value, [value]);
  /** 收起态标签（DSH model.notSelected 语义）：有值 = 人类可读名；空 = 显式未选择。 */
  const triggerLabel = value ? selectedHumanName || value : '选择模型';

  /** 下拉展示行：compact 下按 vendor 分组（组头 + 项），非 compact 保持平铺（设置页零改动）。 */
  const displayRows = useMemo(() => {
    const rows: Array<{ type: 'header'; vendor: string } | { type: 'item'; m: ModelDescriptor }> = [];
    if (!compact) {
      results.forEach((m) => {
        rows.push({ type: 'item', m });
      });
      return rows;
    }
    const byVendor = new Map<string, ModelDescriptor[]>();
    for (const m of results) {
      const arr = byVendor.get(m.vendor) ?? [];
      arr.push(m);
      byVendor.set(m.vendor, arr);
    }
    for (const [vendor, list] of byVendor) {
      rows.push({ type: 'header', vendor });
      list.forEach((m) => {
        rows.push({ type: 'item', m });
      });
    }
    return rows;
  }, [results, compact]);

  /* ── B3（2026-08-27）：无 Key 厂商分组头标注——选中即全局切到无 Key 行，
   *    下一条消息就 MISSING_CREDENTIAL，选择器必须给预警。resolveApiKey
   *    有内存缓存（首个 promise 后零 IPC），Key 状态变化走写穿失效重解析。 ── */
  const [noKeyVendors, setNoKeyVendors] = useState<Set<string>>(new Set());
  const headerVendors = useMemo(
    () => [...new Set(displayRows.filter((r) => r.type === 'header').map((r) => (r as { vendor: string }).vendor))],
    [displayRows],
  );
  /* ── C5（2026-08-27）+ D8（2026-08-29）：动态目录状态面——分组头标注
   *    「目录获取失败」（failure 在 setupAgent 后台拉取 / 设置页手动刷新时记录）
   *    与「目录获取中…」（拉取中→完成必须实时刷新，否则「获取中」悬挂到下次
   *    重开下拉）。订阅 catalog 的拉取状态变更：打开期间挂订阅，变更即重快照。 ── */
  const [fetchFlags, setFetchFlags] = useState(() => ({
    inflight: new Set<string>(),
    failed: new Set<string>(),
  }));
  useEffect(() => {
    if (!state.isOpen) return;
    const refresh = () =>
      setFetchFlags({
        inflight: new Set(headerVendors.filter((v) => getDynamicFetchInflight(v))),
        failed: new Set(headerVendors.filter((v) => getDynamicFetchFailure(v) !== undefined)),
      });
    refresh();
    return onDynamicFetchChange(refresh);
  }, [state.isOpen, headerVendors]);
  useEffect(() => {
    if (!state.isOpen || !compact || headerVendors.length === 0) return;
    let alive = true;
    void (async () => {
      const next = new Set<string>();
      for (const v of headerVendors) {
        const key = await resolveApiKey(v);
        if (alive && !key) next.add(v);
      }
      if (alive) setNoKeyVendors(next);
    })();
    return () => {
      alive = false;
    };
  }, [state.isOpen, compact, headerVendors]);

  /* ── DSH 不可用状态（2026-08-26）：当前会话模型所属 provider 已不在配置里
   *    （被删/移除）——触发器标「⚠ 不可用」，title 说明；仍可打开下拉选有效
   *    配置恢复（选哪家就写哪家，不落回兜底写错家）。 ── */
  const providerUnavailable = useMemo(() => {
    if (!value) return false;
    try {
      return !loadSettings().providers.some((p) => p.name === providerName);
    } catch {
      return false;
    }
  }, [value, providerName]);

  const close = useCallback(() => {
    setQuery('');
    state.setOpen(false);
    // compact：搜索框随弹层卸载 → 无真实 blur 事件 → react-aria 的 isFocused
    // 持高，react-stately「聚焦中 + inputValue 变化」effect 会拿重置后的空查询
    // 重新开菜单（实测：带半截查询时外点/触发器再点/Escape 都「关了又开」）。
    // 手动降焦位切断重开路。触发的 commitValue 回调被 compact 空键忽略拦下，
    // 半截查询不落库。非 compact（设置页字段）保 react-aria 原生语义零改动。
    if (compact) state.setFocused(false);
  }, [state, compact]);

  /* ── DSH 移植（2026-08-26）：运行中守卫——流式中不允许切模型（onAttemptOpen
   *    语义）。拦下时回调 onBlocked，宿主弹提示；打开本身被 veto。 ── */
  const attemptOpen = useCallback(() => {
    if (isStreaming) {
      onBlocked?.();
      return false;
    }
    return true;
  }, [isStreaming, onBlocked]);

  /** 选中态判定：id 命中即选中（跨 vendor 同 id 也各自标中，与旧实现一致）。
   *  compact 下同 (provider, model) 再选 = no-op（DSH same-model guard）。 */
  const handleSelect = useCallback(
    (desc: ModelDescriptor) => {
      const sameSelection = desc.id === value && (compact ? desc.vendor === providerName : true);
      if (sameSelection) {
        close();
        return;
      }
      onChange(desc.id, desc);
      close();
    },
    [compact, value, providerName, onChange, close],
  );

  /** react-aria onSelectionChange：真实键 → 模型选择；null/空 → 自定义值提交。
   *  2026-09-06 收口：compact 忽略空键——外点/blur 时 react-aria 的
   *  commitCustomValue 会以「半截查询」回调到这里（setValue(null) 在受控
   *  下仍触发 onSelectionChange），弹层取消语义 = 不写库；自定义模型名提交
   *  仍属设置页字段形态（非 compact）。 */
  function handleSelectionChange(key: unknown) {
    if (key == null || key === '') {
      if (compact) return;
      // 自定义值提交（Enter 无匹配 / blur）：把输入当自定义模型名提交
      const q = state.inputValue.trim();
      if (q && q !== value) {
        onChange(q);
        close(); // 2026-09-01 审计：自定义提交后收起下拉（此前停在打开态）
      }
      return;
    }
    const m = results.find((r) => itemKey(r) === String(key));
    if (m) handleSelect(m);
  }

  // 打开期间焦点跟随滚动（react-aria 虚拟焦点，滚动交给宿主；optional-call——
  // jsdom 无 scrollIntoView，2026-09-06 接上 listRef 后测试环境首跑即踩）
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusedKey 是刻意的「触发器」依赖——仅用于滚动跟随，非响应值
  useEffect(() => {
    if (!state.isOpen) return;
    const el = listRef.current?.querySelector('.ms-item.active') as HTMLElement | null;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [state.isOpen, state.selectionManager.focusedKey]);

  // compact 触发器路径打开后把焦点送入输入框（ARIA combobox 语义：触发弹出 → 焦点在输入；
  // 否则键盘流落在触发器按钮上，react-aria 的 ↑↓/Enter 全部失效）
  useEffect(() => {
    if (state.isOpen && compact) inputRef.current?.focus();
  }, [state.isOpen, compact]);

  const handleTriggerOpen = useCallback(
    (focusStrategy?: 'first' | 'last') => {
      if (!attemptOpen()) return;
      setQuery('');
      state.open(focusStrategy, 'manual');
    },
    [attemptOpen, state],
  );

  /* ── 2026-09-06 收口：外点关闭。画布空白处 mousedown preventDefault（平移
   *    手势）拦得掉 blur——react-aria 的 blur 关闭永不触发，菜单收不回（实锤：
   *    PaperPanel.onCanvasMouseDown L1704）。document mousedown 兜底（preventDefault
   *    不阻监听器本身）；容器（触发器 + 弹层）内按下不算外点。仅 compact 挂。 ── */
  useEffect(() => {
    if (!state.isOpen || !compact) return;
    const closeOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [state.isOpen, compact, close]);

  /** 触发器点击 = toggle（开→关 / 关→开）——触发器恒驻后必须有自闭合路径。
   *  关闭路径回焦触发器（输入框随弹层卸载，焦点会坠回 body）。 */
  const handleTriggerClick = useCallback(() => {
    if (state.isOpen) {
      close();
      requestAnimationFrame(() => triggerRef.current?.focus());
      return;
    }
    handleTriggerOpen();
  }, [state.isOpen, close, handleTriggerOpen]);

  /** 空态文案（两形态共用逻辑，落位不同）。 */
  const emptyText = query
    ? `无匹配模型「${query}」`
    : hasDynamicFetchInflight()
      ? '目录获取中…'
      : compact
        ? '没有可用模型——去 设置 → Provider 添加'
        : '目录为空，点击刷新从 API 获取';

  /** 搜索输入（两形态共用）。isField = 设置页字段形态：收起时显当前 id + 清除钮；
   *  compact（弹层内搜索行）只在打开时存在，值恒为查询词，无清除钮。 */
  const renderInput = (isField: boolean) => (
    <div className="ms-input-row">
      <div className="ms-input-wrap">
        <span
          className="ms-input-icon"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG，无外部输入
          dangerouslySetInnerHTML={{ __html: iconHtml('search', 12) }}
        />
        <input
          type="text"
          className="sp-input ms-input"
          ref={inputRef}
          placeholder={compact ? '搜索模型…' : undefined}
          {...inputProps}
          value={isField ? (state.isOpen ? state.inputValue : value) : state.inputValue}
          onFocus={(e) => {
            // 对齐旧行为（字段形态）：聚焦预填当前模型 id
            if (isField && !state.isOpen) setQuery(value);
            inputProps.onFocus?.(e);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Escape = 取消关闭，不提交自定义值（react-aria 默认 revert 会提交，拦截掉）
              e.preventDefault();
              close();
              // 2026-09-06 收口：收起后焦点回触发器（combobox 惯例：取消回到收起态控件）
              if (compact) requestAnimationFrame(() => triggerRef.current?.focus());
              return;
            }
            inputProps.onKeyDown?.(e);
          }}
        />
        {isField && value && !state.isOpen && (
          <button
            type="button"
            className="ms-input-clear"
            title="清除"
            onClick={() => onChange('')}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG，无外部输入
            dangerouslySetInnerHTML={{ __html: iconHtml('close', 10) }}
          />
        )}
      </div>
    </div>
  );

  /** 列表行（分组头 + 模型行）——两形态共用。 */
  const renderRows = () =>
    displayRows.map((row) =>
      row.type === 'header' ? (
        <div key={`h-${row.vendor}`} className="ms-group-head" role="presentation">
          <ProviderMark vendor={row.vendor} className="ms-group-mark" />
          <span className="ms-group-name">{row.vendor}</span>
          {noKeyVendors.has(row.vendor) && <span className="ms-group-nokey">未配置 Key</span>}
          {fetchFlags.inflight.has(row.vendor) && <span className="ms-group-fetch">目录获取中…</span>}
          {fetchFlags.failed.has(row.vendor) && (
            <span className="ms-group-fail" title={getDynamicFetchFailure(row.vendor)}>
              目录获取失败
            </span>
          )}
        </div>
      ) : (
        <ModelRow key={itemKey(row.m)} state={state} m={row.m} value={value} />
      ),
    );

  return (
    <div className={`ms-container${state.isOpen ? ' ms-open' : ''}${compact ? ' ms-compact' : ''}`} ref={containerRef}>
      {compact ? (
        <>
          {/* 触发器恒驻（2026-09-06 收口）：打开时仍显示当前模型，不被搜索框顶替。
           *  DSH ProviderIcon 的轻量替代：厂商 monogram（首字大写 seal chip） */}
          <button
            type="button"
            ref={triggerRef}
            className={`ms-trigger${providerUnavailable ? ' ms-trigger-unavailable' : ''}`}
            title={
              providerUnavailable
                ? `⚠ 提供方「${providerName}」不可用（已移除？）——从下拉选择可用模型`
                : `${providerName} · ${triggerLabel}（点击选择模型）`
            }
            aria-haspopup="listbox"
            aria-expanded={state.isOpen}
            onMouseDown={(e) => {
              // 防抢焦竞态（DSH ModelSelect 同款注释）：打开态下 mousedown 触发器会
              // 把焦点从搜索框拽走 → blur 不在弹层内 → react-aria commitValue 抢先
              // 关菜单，随后 click 又重开（toggle 失效 + 闪烁）。preventDefault 拦掉
              // mousedown 的默认抢焦，toggle 交给 click 一次做完。
              e.preventDefault();
            }}
            onClick={handleTriggerClick}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                handleTriggerOpen('first');
              }
            }}
          >
            <ProviderMark vendor={providerName} className="ms-trigger-mark" />
            <span className="ms-trigger-name">{triggerLabel}</span>
            {providerUnavailable && (
              <span className="ms-trigger-unavail" aria-hidden="true">
                ⚠
              </span>
            )}
            <span className="ms-trigger-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          {/* 弹层 = 搜索行 + 列表（2026-09-06 收口）：搜索进弹层，触发 pill 不动
           *  ——行宽恒定，不推挤同行控件 */}
          {state.isOpen && (
            <div
              ref={(el) => {
                popoverRef.current = el;
              }}
              className="ms-dropdown"
            >
              {renderInput(false)}
              {results.length === 0 ? (
                <div className="ms-empty">
                  <span className="ms-empty-text">{emptyText}</span>
                </div>
              ) : (
                <div
                  ref={(el) => {
                    listRef.current = el;
                    listBoxRef.current = el;
                  }}
                  className="ms-listbox"
                  {...listBoxProps}
                >
                  {renderRows()}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {renderInput(true)}
          {state.isOpen &&
            (results.length === 0 ? (
              <div className="ms-dropdown ms-empty">
                <span className="ms-empty-text">{emptyText}</span>
              </div>
            ) : (
              <div
                ref={(el) => {
                  popoverRef.current = el;
                  listRef.current = el;
                  listBoxRef.current = el;
                }}
                className="ms-dropdown"
                {...listBoxProps}
              >
                {renderRows()}
              </div>
            ))}
        </>
      )}
    </div>
  );
}

/** DSH ProviderIcon 的轻量替代（兰台无 @lobehub 图标集）：厂商名首字 monogram，
 *  seal 色圆角 chip。compact 触发 pill 与分组头共用，保证两处视觉一致。 */
function ProviderMark({ vendor, className }: { vendor: string; className?: string }) {
  return (
    <span className={`ms-provider-mark${className ? ` ${className}` : ''}`} aria-hidden="true">
      {(vendor || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

/** 下拉单项（useOption 接管 role/aria-selected/键盘选中语义，DOM 类名不变）。
 *  行内只留模型本身（id + 人类名）；目录元数据（推理/上下文窗口/动态来源）全部
 *  收进 title——徽章收口后 hover 可见，不再占行内空间挡字。 */
function ModelRow({ state, m, value }: { state: ComboBoxState<ModelDescriptor>; m: ModelDescriptor; value: string }) {
  const optionRef = useRef<HTMLButtonElement | null>(null);
  const key = itemKey(m);
  const { optionProps, isFocused } = useOption({ key, isSelected: m.id === value }, state, optionRef);
  const isDynamic = m.contextWindow <= 0; // 无目录元数据 = 运行时从 /models 动态发现
  const title = [
    m.id === value ? `当前模型 · ${m.vendor}` : m.vendor,
    m.input.includes('image') ? '支持图片输入' : null,
    m.reasoning ? '支持推理/思考' : null,
    m.contextWindow > 0 ? `上下文窗口 ${(m.contextWindow / 1000).toFixed(0)}k` : null,
    isDynamic ? '运行时从 API 动态发现（无目录元数据）' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      ref={optionRef}
      {...optionProps}
      data-key={key}
      title={title}
      className={`ms-item${isFocused ? ' active' : ''}${m.id === value ? ' selected' : ''}`}
    >
      <span className="ms-item-id">{m.id}</span>
      {m.input.includes('image') && (
        <span className="ms-item-vision" title="视觉模型——支持图片输入（目录声明或参数面板覆盖）">
          视
        </span>
      )}
      {m.name !== m.id && <span className="ms-item-name">{m.name}</span>}
    </button>
  );
}
