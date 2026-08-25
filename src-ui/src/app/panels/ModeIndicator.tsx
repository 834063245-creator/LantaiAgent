// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// ModeIndicator — 书眉右区的模型/权限模式两枚小控件（C11，2026-08-22）。
//
// 模型字样：mono 小字显示当前模型，点击展开纸面小菜单——按已配置
// provider 分组的模型列表。选择是复合的（provider + model）：跨 provider
// 选模型会联动切换 activeProvider，杜绝「分组只是视觉、模型名写进别家
// 配置」的错配；写入后发 model-switched 信号（Workspace.applyAgentConfig
// 恒 swap 热切换，会话/上下文全保留）。
// 模式字样：常询/半放/全放三档点击轮转；切往 yolo 需二次确认
// （朱砂确认条，防无脑点到）——权限模式单源真相在 state/mode-store
// （切换 = 写 store + 镜像 Rust + 落盘，见该文件头注释）。
//
// 挂载：PaperPanel 书眉（设置/关卷旁）。app 级状态（mode-store）+
// settings 快照（模型），不依赖面板生命周期。

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { findModels } from '../../provider/catalog';
import { getActiveProvider, loadSettings, type ProviderSettings, saveSettings, updateProvider } from '../../settings';
import { notifyAgentConfigChanged } from '../../state/agent-config-store';
import { MODE_DESCRIPTIONS, MODE_LABELS, type PermissionMode, useModeStore } from '../../state/mode-store';
import './mode-indicator.css';

/** 模型菜单：已配置 provider 的模型并集（目录序），每 provider 一组。
 *  空分组不丢弃——渲染组头 + 引导文案，避免「点了菜单一片空白」。 */
function ModelMenu({
  onSelect,
  onClose,
}: {
  onSelect: (providerName: string, model: string) => void;
  onClose: () => void;
}) {
  const providers = useMemo<ProviderSettings[]>(() => {
    try {
      return loadSettings().providers;
    } catch {
      return [];
    }
  }, []);
  const active = useMemo(() => {
    try {
      return getActiveProvider(loadSettings());
    } catch {
      return null;
    }
  }, []);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={boxRef} className="mi-model-menu" role="menu" aria-label="切换模型">
      {providers.map((p) => {
        const models = findModels(p.name);
        return (
          <div key={p.name} className="mi-model-group">
            <div className="mi-model-vendor">{p.name}</div>
            {models.map((m) => (
              <button
                key={`${p.name}/${m.id}`}
                type="button"
                role="menuitemradio"
                aria-checked={p.name === active?.name && m.id === active.model}
                className={`mi-model-item${p.name === active?.name && m.id === active.model ? ' mi-model-item--on' : ''}`}
                onClick={() => onSelect(p.name, m.id)}
              >
                <span className="mi-model-name">{m.name}</span>
                <span className="mi-model-meta">
                  {m.contextWindow >= 1000 ? `${Math.round(m.contextWindow / 1000)}K` : m.contextWindow}
                </span>
              </button>
            ))}
            {models.length === 0 && (
              <div className="mi-model-empty">该提供方暂无目录模型——到 设置 → 提供方 填写或从 API 获取</div>
            )}
          </div>
        );
      })}
      {providers.length === 0 && <div className="mi-model-empty">尚未配置提供方（设置 → 提供方）</div>}
    </div>
  );
}

const MODE_ORDER: PermissionMode[] = ['ask', 'auto', 'yolo'];

export const ModeIndicator = memo(function ModeIndicator() {
  const permissionMode = useModeStore((s) => s.permissionMode);
  const pendingYolo = useModeStore((s) => s.pendingYolo);
  const setPermissionMode = useModeStore((s) => s.setPermissionMode);
  const setPendingYolo = useModeStore((s) => s.setPendingYolo);

  const [modelLabel, setModelLabel] = useState<string>('');
  const [menuOpen, setMenuOpen] = useState(false);

  // 模型字样：启动读一次 + 配置信号到达时刷新（切换后 provider 重建，字样跟随）
  useEffect(() => {
    const read = () => {
      try {
        setModelLabel(getActiveProvider(loadSettings()).model || '—');
      } catch {
        setModelLabel('—');
      }
    };
    read();
    // model-switched / settings-saved 都会触发；订阅 seq 变化即重读
    let lastSeq = -1;
    const unsub = import('../../state/agent-config-store').then(({ useAgentConfigStore }) =>
      useAgentConfigStore.subscribe((s) => {
        if (s.seq !== lastSeq) {
          lastSeq = s.seq;
          read();
        }
      }),
    );
    return () => {
      void unsub.then((u) => u());
    };
  }, []);

  /** 复合选择：模型归属哪个 provider 就切到哪——model 写进归属 provider 的
   *  配置，跨 provider 选择同时切换 activeProvider（对齐 P6「其他提供方
   *  一键切换」语义）。两次 saveSettings 是同一快照的累积写，顺序无依赖。 */
  const pickModel = (providerName: string, model: string) => {
    try {
      const s = loadSettings();
      const act = getActiveProvider(s);
      if (act.name === providerName && act.model === model) {
        setMenuOpen(false);
        return;
      }
      let next = updateProvider(s, providerName, { model });
      if (act.name !== providerName) {
        next = { ...next, activeProvider: providerName as ProviderSettings['name'] };
      }
      saveSettings(next);
      setMenuOpen(false);
      notifyAgentConfigChanged('model-switched');
    } catch (e) {
      console.error('[ModeIndicator] 切模型失败:', e);
    }
  };

  const cycleMode = () => {
    const idx = MODE_ORDER.indexOf(permissionMode);
    const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
    if (next === 'yolo') {
      // 全放是危险档 — 先亮确认条，不直接切
      setPendingYolo(true);
      return;
    }
    setPendingYolo(false);
    setPermissionMode(next);
  };

  return (
    <div className="mi-root">
      {pendingYolo && (
        <div className="mi-yolo-confirm" role="alertdialog" aria-label="确认全放模式">
          <span className="mi-yolo-text">{MODE_DESCRIPTIONS.yolo} — 确定？</span>
          <button type="button" className="mi-yolo-btn mi-yolo-btn--yes" onClick={() => setPermissionMode('yolo')}>
            落印
          </button>
          <button type="button" className="mi-yolo-btn" onClick={() => setPendingYolo(false)}>
            收回
          </button>
        </div>
      )}
      <div className="mi-model-wrap">
        <button
          type="button"
          className="mi-model"
          title="切换模型"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {modelLabel}
        </button>
        {menuOpen && <ModelMenu onSelect={pickModel} onClose={() => setMenuOpen(false)} />}
      </div>
      <button
        type="button"
        className={`mi-mode mi-mode--${permissionMode}`}
        title={`${MODE_LABELS[permissionMode]} · ${MODE_DESCRIPTIONS[permissionMode]}（点击切换）`}
        aria-label={`权限模式：${MODE_LABELS[permissionMode]}，${MODE_DESCRIPTIONS[permissionMode]}（点击切换）`}
        onClick={cycleMode}
      >
        {MODE_LABELS[permissionMode]}
      </button>
    </div>
  );
});
