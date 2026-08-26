// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector — 可搜索的下拉组合框，用于从目录中选择模型。
// 支持自由输入目录中不存在的自定义模型名称。
// 从 API 动态获取的模型会标记 "live" 徽章。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findModels, getDynamicFetchFailure, getModel, searchModels } from '../../provider/catalog';
import { resolveApiKey } from '../../provider/credentials';
import type { ModelDescriptor, Protocol } from '../../provider/types';
import { effectiveModels, loadSettings } from '../../settings';
import { iconHtml } from '../../ui/icons';

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
 *  来源 = ProviderSettings.models（缺省回落 [model]，零迁移），不是静态目录全集——
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

export function ModelSelector({
  value,
  onChange,
  providerName,
  kind,
  compact,
  isStreaming,
  onBlocked,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!open) return [];
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
  }, [open, query, kind, providerName, compact]);

  /** 收起态人类可读名（rework P2-1：不再只露 model id）。 */
  const selectedHumanName = useMemo(() => getModel(value)?.name ?? value, [value]);
  /** 收起态标签（DSH model.notSelected 语义）：有值 = 人类可读名；空 = 显式未选择。 */
  const triggerLabel = value ? selectedHumanName || value : '选择模型';

  /** 下拉展示行：compact 下按 vendor 分组（组头 + 项），非 compact 保持平铺（设置页零改动）。 */
  const displayRows = useMemo(() => {
    const rows: Array<{ type: 'header'; vendor: string } | { type: 'item'; m: ModelDescriptor; idx: number }> = [];
    if (!compact) {
      results.forEach((m, idx) => {
        rows.push({ type: 'item', m, idx });
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
        rows.push({ type: 'item', m, idx: results.indexOf(m) });
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
  /* ── C5（2026-08-27）：动态目录失败面——该 vendor 后台/手动拉模型表失败时
   *    分组头标注「目录获取失败」（静态目录 + last-good 动态模型兜底，不因失败
   *    消失）。failure 状态在 setupAgent 后台拉取 / 设置页手动刷新时记录，打开
   *    下拉（displayRows 重算）时同步可见。 ── */
  const failedVendors = useMemo(
    () => new Set(headerVendors.filter((v) => getDynamicFetchFailure(v) !== undefined)),
    [headerVendors],
  );
  useEffect(() => {
    if (!open || !compact || headerVendors.length === 0) return;
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
  }, [open, compact, headerVendors]);

  const selectedDesc = useMemo(() => getModel(value), [value]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIdx(0);
  }, []);

  /* ── DSH 移植（2026-08-26）：运行中守卫——流式中不允许切模型（onAttemptOpen
   *    语义）。拦下时回调 onBlocked，宿主弹提示；打开本身被 veto。 ── */
  const attemptOpen = useCallback(() => {
    if (isStreaming) {
      onBlocked?.();
      return false;
    }
    return true;
  }, [isStreaming, onBlocked]);

  const handleSelect = useCallback(
    (desc: ModelDescriptor) => {
      // DSH same-model guard（compact 会话热切换）：同 (provider, model) 不重复
      // 发信号——会话覆盖已在位，再选同款只是无谓重写 + 热切换。跨 vendor 同 id
      // （目录允许共享 id）不算同款，正常切换。
      if (compact && desc.id === value && desc.vendor === providerName) {
        close();
        return;
      }
      onChange(desc.id, desc);
      close();
    },
    [compact, value, providerName, onChange, close],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeIdx 是刻意的「触发器」依赖——仅用于滚动跟随，非响应值
  useEffect(() => {
    const el = listRef.current?.querySelector('.ms-item.active') as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (results[activeIdx]) {
        handleSelect(results[activeIdx]);
      } else {
        // 无匹配：把输入当自定义模型名提交（回车即确认，不必失焦）
        const q = query.trim();
        if (q && q !== value) {
          onChange(q);
          setOpen(false);
        }
      }
    } else if (e.key === 'Escape') {
      close();
    }
  };

  return (
    <div className={`ms-container${open ? ' ms-open' : ''}${compact ? ' ms-compact' : ''}`} ref={containerRef}>
      {compact && !open ? (
        <button
          type="button"
          className="ms-trigger"
          title={`${providerName} · ${triggerLabel}（点击选择模型）`}
          aria-haspopup="listbox"
          aria-expanded={false}
          onClick={() => {
            if (!attemptOpen()) return;
            setOpen(true);
            // B1（2026-08-27）：打开置空 query——预填当前模型 id 会把 results
            // 打进 searchModels(value) 分支，「空查询列全部已配置 provider」
            // 的全表分支永不触发（P2-1 跨 vendor 直选没兑现的直接根因）。
            setQuery('');
            setActiveIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (!attemptOpen()) return;
              setOpen(true);
              setQuery('');
            }
          }}
        >
          {/* DSH ProviderIcon 的轻量替代：厂商 monogram（首字大写 seal chip） */}
          <ProviderMark vendor={providerName} className="ms-trigger-mark" />
          <span className="ms-trigger-name">{triggerLabel}</span>
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
              value={open ? query : value}
              placeholder="搜索模型或输入名称…"
              onFocus={() => {
                setOpen(true);
                setQuery(value);
              }}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!open) setOpen(true);
                setActiveIdx(0);
                /* 不在每次击键提交 onChange（会级联 onCommitProvider 全量落
                 * settings + 标 dirty——输入 "gpt" 3 次触发 3 次保存条）。
                 * 自定义模型名经 Enter（下方 handleKeyDown）/失焦提交。 */
              }}
              onBlur={() => {
                // 失焦提交：用户手动输入了完整自定义名（未从下拉选中）的场景
                const q = query.trim();
                if (q && q !== value) onChange(q);
              }}
              onKeyDown={handleKeyDown}
            />
            {value && !open && (
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
      {open && results.length > 0 && (
        <div className="ms-dropdown" ref={listRef}>
          {displayRows.map((row) =>
            row.type === 'header' ? (
              <div key={`h-${row.vendor}`} className="ms-group-head">
                <ProviderMark vendor={row.vendor} className="ms-group-mark" />
                <span className="ms-group-name">{row.vendor}</span>
                {noKeyVendors.has(row.vendor) && <span className="ms-group-nokey">未配置 Key</span>}
                {failedVendors.has(row.vendor) && (
                  <span className="ms-group-fail" title={getDynamicFetchFailure(row.vendor)}>
                    目录获取失败
                  </span>
                )}
              </div>
            ) : (
              <ModelRow
                key={`${row.m.vendor}/${row.m.id}`}
                m={row.m}
                idx={row.idx}
                activeIdx={activeIdx}
                value={value}
                onHover={setActiveIdx}
                onSelect={handleSelect}
              />
            ),
          )}
        </div>
      )}
      {open && results.length === 0 && (
        <div className="ms-dropdown ms-empty">
          <span className="ms-empty-text">
            {query
              ? `无匹配模型「${query}」`
              : compact
                ? '没有可用模型——去 设置 → Provider 添加'
                : '目录为空，点击刷新从 API 获取'}
          </span>
        </div>
      )}
      {selectedDesc && !open && !compact && (
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

/** 下拉单项（分组模式下复用——保持设置页平铺行为一致，仅展示差异）。 */
function ModelRow({
  m,
  idx,
  activeIdx,
  value,
  onHover,
  onSelect,
}: {
  m: ModelDescriptor;
  idx: number;
  activeIdx: number;
  value: string;
  onHover: (i: number) => void;
  onSelect: (desc: ModelDescriptor) => void;
}) {
  const isDynamic = !hasMetadata(m);
  return (
    <button
      type="button"
      className={`ms-item${idx === activeIdx ? ' active' : ''}${m.id === value ? ' selected' : ''}`}
      onMouseEnter={() => onHover(idx)}
      onClick={() => onSelect(m)}
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
