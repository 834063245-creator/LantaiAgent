// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页左侧「提供方列表」：一行一个 provider，
// 状态点 = 未配置 / 已配置 / 正常 / 异常；「新会话默认」角标 = 最近使用的
// provider（activeProvider 自动跟从创作坞切换，「设为当前」已退役）。

import type { ProviderId, ProviderSettings } from '../../../settings';
import { protocolLabel } from './protocol';
import { providerStatus, STATUS_LABEL } from './status';

interface ProviderListProps {
  providers: ProviderSettings[];
  selected: ProviderId;
  current: ProviderId;
  onSelect: (name: ProviderId) => void;
  onAdd: () => void;
}

export function ProviderList({ providers, selected, current, onSelect, onAdd }: ProviderListProps) {
  return (
    <aside className="pp-rail">
      <div className="pp-rail-hd">
        <span>提供方</span>
        <span className="pp-cnt">{providers.length}</span>
      </div>
      <div className="pp-rail-list">
        {providers.length === 0 ? (
          <div className="pp-rail-empty">还没有提供方——点击下方「添加提供方」开始。</div>
        ) : (
          providers.map((p) => {
            const st = providerStatus(p);
            const active = p.name === selected;
            return (
              <button
                type="button"
                key={p.name}
                className={`pp-src pp-src-${st}${active ? ' active' : ''}`}
                onClick={() => onSelect(p.name)}
              >
                <span className={`pp-src-dot pp-dot-${st}`} />
                <span className="pp-src-main">
                  <span className="pp-src-name">
                    {p.name}
                    {p.name === current && <span className="pp-now-badge">新会话默认</span>}
                  </span>
                  <span className="pp-src-sub">
                    {protocolLabel(p.kind)}
                    {p.model ? ` · ${p.model}` : ''}
                  </span>
                </span>
                <span className="pp-src-state">{STATUS_LABEL[st]}</span>
              </button>
            );
          })
        )}
      </div>
      <button type="button" className="pp-rail-add" onClick={onAdd}>
        ＋ 添加提供方
      </button>
      <div className="pp-legend">
        <span>
          <i className="pp-dot-legend unconfigured" />
          未配置
        </span>
        <span>
          <i className="pp-dot-legend configured" />
          已配置
        </span>
        <span>
          <i className="pp-dot-legend ok" />
          正常
        </span>
        <span>
          <i className="pp-dot-legend fail" />
          异常
        </span>
      </div>
    </aside>
  );
}
