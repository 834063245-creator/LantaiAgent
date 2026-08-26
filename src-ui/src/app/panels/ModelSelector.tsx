// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector — 可搜索的下拉组合框，用于从目录中选择模型。
// 支持自由输入目录中不存在的自定义模型名称。
// 从 API 动态获取的模型会标记 "live" 徽章。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findModels, getModel, searchModels } from '../../provider/catalog';
import type { ModelDescriptor, Protocol } from '../../provider/types';
import { loadSettings } from '../../settings';
import { iconHtml } from '../../ui/icons';

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string, desc?: ModelDescriptor) => void;
  /** 当前 provider 名称 — 默认列表只显示该 vendor 的模型。 */
  providerName: string;
  /** Provider 类型 — 按匹配的 API 协议过滤目录。 */
  kind: Protocol;
  /** 可选：从 provider 的 API 获取模型并合并到目录中。 */
  onRefreshModels?: () => Promise<number>;
  /** rework P2-1：紧凑触发器形态（创作坞底部用）——收起态 = 按钮（供应商/模型名 + 箭头），
   *  空查询列出全部已配置 provider 的目录模型（跨 vendor 直接选）。缺省 = 设置页字段形态不变。 */
  compact?: boolean;
}

function hasMetadata(m: ModelDescriptor): boolean {
  return m.cost.input > 0 || m.contextWindow > 0;
}

export function ModelSelector({ value, onChange, providerName, kind, onRefreshModels, compact }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!open) return [];
    const q = query.toLowerCase().trim();
    // 空查询：
    //   - 字段形态（compact=false）= 只列本家 vendor（跨家选择走设置页切换 provider）；
    //   - 紧凑形态（compact=true，创作坞）= 列出全部已配置 provider 的目录模型，
    //     跨 vendor 直接在创作坞选（rework P2-1）。
    // 有查询词 = 全目录搜索（含动态模型），再按协议过滤。
    let base: ModelDescriptor[];
    if (q) {
      base = searchModels(q);
    } else if (compact) {
      base = [];
      try {
        for (const p of loadSettings().providers) {
          base = base.concat(findModels(p.name));
        }
      } catch {
        base = findModels(providerName);
      }
    } else {
      base = findModels(providerName);
    }
    return base
      .filter((m) => m.kind === kind)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 30);
  }, [open, query, kind, providerName, compact]);

  /** 收起态人类可读名（rework P2-1：不再只露 model id）。 */
  const selectedHumanName = useMemo(() => getModel(value)?.name ?? value, [value]);

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

  const selectedDesc = useMemo(() => getModel(value), [value]);

  const handleRefresh = useCallback(async () => {
    if (!onRefreshModels || refreshing) return;
    setRefreshing(true);
    setRefreshMsg('');
    try {
      const count = await onRefreshModels();
      setRefreshMsg(count > 0 ? `已发现 ${count} 个模型` : '未获取到新模型');
    } catch (e) {
      // 无 Key / 网络失败等真实原因透出，避免「未获取到新模型」误导
      setRefreshMsg((e instanceof Error ? e.message || String(e) : String(e)) || '获取失败');
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(''), 3000);
    }
  }, [onRefreshModels, refreshing]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIdx(0);
  }, []);

  const handleSelect = useCallback(
    (desc: ModelDescriptor) => {
      onChange(desc.id, desc);
      close();
    },
    [onChange, close],
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
          title={`${providerName} · ${selectedHumanName}（点击选择模型）`}
          aria-haspopup="listbox"
          aria-expanded={false}
          onClick={() => {
            setOpen(true);
            setQuery(value);
            setActiveIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setQuery(value);
            }
          }}
        >
          <span className="ms-trigger-vendor">{providerName}</span>
          <span className="ms-trigger-name">{selectedHumanName || value || '…'}</span>
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
          {onRefreshModels && (
            <button
              type="button"
              className={`ms-refresh-btn${refreshing ? ' spinning' : ''}`}
              title="从 API 获取模型列表"
              onClick={handleRefresh}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG，无外部输入
              dangerouslySetInnerHTML={{
                __html: iconHtml(refreshing ? 'loading' : 'refresh', 13),
              }}
            />
          )}
        </div>
      )}
      {refreshMsg && <div className="ms-refresh-msg">{refreshMsg}</div>}
      {open && results.length > 0 && (
        <div className="ms-dropdown" ref={listRef}>
          {displayRows.map((row) =>
            row.type === 'header' ? (
              <div key={`h-${row.vendor}`} className="ms-group-head">
                {row.vendor}
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
          <span className="ms-empty-text">{query ? `无匹配模型「${query}」` : '目录为空，点击刷新从 API 获取'}</span>
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
