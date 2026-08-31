// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector — 可搜索的下拉组合框，用于从目录中选择模型。
// 支持自由输入目录中不存在的自定义模型名称。
// 从 API 动态获取的模型会标记 "live" 徽章。
//
// 2026-08-29 frontend-overlay-a11y-plan 档位 C：手写 combobox（handleKeyDown /
// role=listbox/option/aria-activedescendant 手工接线）整体换成 @react-aria/combobox
// 的 useComboBox + useListBox/useOption。保留：分组表头 / compact 触发按钮 /
// 元数据徽标 / 空态文案 / 目录获取失败态。DOM 类名与布局不变。
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
  onDynamicFetchChange,
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

function hasMetadata(m: ModelDescriptor): boolean {
  return m.cost.input > 0 || m.contextWindow > 0;
}

/** 各已配置 provider 的「可用模型」并集（创作坞可选面，DSH routable 列表语义）。
 *  来源 = ProviderSettings.models（缺省回落 [model]），不是静态目录全集——
 *  用户配了哪些，下拉就列哪些。id 有目录元数据 → 用目录描述符（名字/协议等）；
 *  目录外 id → 合成最小描述符。⚠️ vendor 一律用 provider 名（连接身份），不是目录
 *  厂商名——自定义 provider（my-gateway）复用目录模型 id 时，分组与切换目标都对
 *  准该 provider，不落到目录厂商（写错家 400 的同族病根）。 */
function configuredModelDescriptors(): ModelDescriptor[] {
  try {
    const out: ModelDescriptor[] = [];
    for (const p of loadSettings().providers) {
      for (const id of effectiveModels(p)) {
        const known = getModel(id);
        if (known) {
          out.push({ ...known, vendor: p.name });
        } else {
          out.push({
            id,
            name: id,
            kind: p.kind,
            vendor: p.name,
            baseUrl: p.baseUrl || '',
            reasoning: false,
            input: ['text'] as ('text' | 'image')[],
            cost: { input: 0, output: 0, cacheRead: 0 },
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
      base = configuredModelDescriptors();
      if (q) {
        base = base.filter(
          (m) =>
            m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.vendor.toLowerCase().includes(q),
        );
      }
    } else if (q) {
      base = searchModels(q);
    } else {
      base = findModels(providerName);
    }
    return base
      .filter((m) => compact || m.kind === kind)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 30);
  }, [query, kind, providerName, compact]);

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

  const selectedDesc = useMemo(() => getModel(value), [value]);

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
  }, [state]);

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

  /** react-aria onSelectionChange：真实键 → 模型选择；null/空 → 自定义值提交。 */
  function handleSelectionChange(key: unknown) {
    if (key == null || key === '') {
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

  // 打开期间焦点跟随滚动（react-aria 虚拟焦点，滚动交给宿主）
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusedKey 是刻意的「触发器」依赖——仅用于滚动跟随，非响应值
  useEffect(() => {
    if (!state.isOpen) return;
    const el = listRef.current?.querySelector('.ms-item.active') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
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

  return (
    <div className={`ms-container${state.isOpen ? ' ms-open' : ''}${compact ? ' ms-compact' : ''}`} ref={containerRef}>
      {compact && !state.isOpen ? (
        <button
          type="button"
          className={`ms-trigger${providerUnavailable ? ' ms-trigger-unavailable' : ''}`}
          title={
            providerUnavailable
              ? `⚠ 提供方「${providerName}」不可用（已移除？）——从下拉选择可用模型`
              : `${providerName} · ${triggerLabel}（点击选择模型）`
          }
          aria-haspopup="listbox"
          aria-expanded={state.isOpen}
          onClick={() => handleTriggerOpen()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              handleTriggerOpen('first');
            }
          }}
        >
          {/* DSH ProviderIcon 的轻量替代：厂商 monogram（首字大写 seal chip） */}
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
      ) : (
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
              {...inputProps}
              value={state.isOpen ? state.inputValue : value}
              onFocus={(e) => {
                // 对齐旧行为：聚焦预填当前模型 id（compact 触发器路径已置空 query）
                if (!state.isOpen) setQuery(value);
                inputProps.onFocus?.(e);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  // Escape = 取消关闭，不提交自定义值（react-aria 默认 revert 会提交，拦截掉）
                  e.preventDefault();
                  close();
                  return;
                }
                inputProps.onKeyDown?.(e);
              }}
            />
            {value && !state.isOpen && (
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
      )}
      {state.isOpen &&
        (results.length === 0 ? (
          <div className="ms-dropdown ms-empty">
            <span className="ms-empty-text">
              {query
                ? `无匹配模型「${query}」`
                : hasDynamicFetchInflight()
                  ? '目录获取中…'
                  : compact
                    ? '没有可用模型——去 设置 → Provider 添加'
                    : '目录为空，点击刷新从 API 获取'}
            </span>
          </div>
        ) : (
          <div
            ref={(el) => {
              popoverRef.current = el;
              listBoxRef.current = el;
            }}
            className="ms-dropdown"
            {...listBoxProps}
          >
            {displayRows.map((row) =>
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
            )}
          </div>
        ))}
      {selectedDesc && !state.isOpen && !compact && (
        <div className="ms-meta">
          {selectedDesc.reasoning && <span className="ms-meta-tag ms-meta-reason">推理</span>}
          {selectedDesc.contextWindow > 0 && (
            <span className="ms-meta-tag">{(selectedDesc.contextWindow / 1000).toFixed(0)}k 上下文</span>
          )}
          {selectedDesc.cost.input > 0 && (
            <>
              <span className="ms-meta-tag">输入 ${selectedDesc.cost.input}/M</span>
              <span className="ms-meta-tag">输出 ${selectedDesc.cost.output}/M</span>
              {selectedDesc.cost.cacheRead > 0 && (
                <span className="ms-meta-tag">缓存 ${selectedDesc.cost.cacheRead}/M</span>
              )}
            </>
          )}
          {!hasMetadata(selectedDesc) && <span className="ms-meta-tag ms-meta-live">来自 API</span>}
        </div>
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

/** 下拉单项（useOption 接管 role/aria-selected/键盘选中语义，DOM 类名不变）。 */
function ModelRow({ state, m, value }: { state: ComboBoxState<ModelDescriptor>; m: ModelDescriptor; value: string }) {
  const optionRef = useRef<HTMLButtonElement | null>(null);
  const key = itemKey(m);
  const { optionProps, isFocused } = useOption({ key, isSelected: m.id === value }, state, optionRef);
  const isDynamic = !hasMetadata(m);
  return (
    <button
      type="button"
      ref={optionRef}
      {...optionProps}
      data-key={key}
      className={`ms-item${isFocused ? ' active' : ''}${m.id === value ? ' selected' : ''}`}
    >
      <div className="ms-item-main">
        <div className="ms-item-id-row">
          <span className="ms-item-id">{m.id}</span>
          {isDynamic && <span className="ms-badge-live">LIVE</span>}
          {m.id === value && <span className="ms-vendor-hint">{m.vendor}</span>}
        </div>
        {m.name !== m.id && <span className="ms-item-name">{m.name}</span>}
      </div>
      <div className="ms-item-badges">
        {m.reasoning && (
          <span className="ms-badge ms-badge-reason" title="支持推理/思考">
            🧠
          </span>
        )}
        {m.contextWindow > 0 && (
          <span className="ms-badge ms-badge-ctx" title="上下文窗口">
            {(m.contextWindow / 1000).toFixed(0)}k
          </span>
        )}
        {m.cost.input > 0 && (
          <span className="ms-badge ms-badge-cost" title="每 1M token 价格">
            ${m.cost.input}/${m.cost.output}
          </span>
        )}
      </div>
    </button>
  );
}
