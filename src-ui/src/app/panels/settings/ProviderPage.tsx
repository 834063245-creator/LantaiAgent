// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 标签页（提供方控制台）：
// 左侧 ProviderList 选提供方，右侧 ProviderDetail 编辑；
// 添加/删除/清除 Key 均为「暂存」，保存时统一落盘 + 写/删凭据 + 重建 Agent。

import { useCallback, useEffect, useRef, useState } from 'react';
import { createProvider } from '../../../provider';
import { markDynamicFetchStart, recordDynamicFetchResult } from '../../../provider/catalog';
import { ChunkType } from '../../../provider/types';
import {
  type AppSettings,
  addProvider,
  type ConnectionProbe,
  defaultBaseUrl,
  getActiveProvider,
  type ProviderId,
  type ProviderSettings,
  removeProvider,
  updateProvider,
} from '../../../settings';
import { type AddProviderEntry, AddProviderSheet } from './AddProviderSheet';
import { ConfirmDialog } from './ConfirmDialog';
import { type ProbeUiState, ProviderDetail, type ProviderField } from './ProviderDetail';
import { ProviderList } from './ProviderList';
import { formatLatency } from './status';

interface ProviderPageProps {
  settings: AppSettings;
  /** Provider 变更只进 state 并标 providerDirty（与全局保存互不牵连） */
  onCommitProvider: (next: AppSettings) => void;
  /** 立即落盘测试探针但不标 dirty（B4 2026-08-27：读盘-改 lastTest-写回，最小落盘面） */
  onPersistProbe: (name: string, probe: ConnectionProbe) => void;
  /** 暂存「删除 Provider」——保存时才删系统凭据，取消不丢 Key */
  onStageDelete: (name: string) => void;
  /** 暂存「清除 Key」——保存时才删系统凭据 */
  onStageClear: (name: string) => void;
  onUnstageClear: (name: string) => void;
  pendingClears: string[];
  /** 保存成功后自增——用于把「未保存 Key」标记复位为「已保存」 */
  saveVersion: number;
  providerDirty: boolean;
  /** Provider 页独立保存（落盘 + 凭据 + 重建 Agent） */
  onSaveProviders: () => void;
}

export function ProviderPage({
  settings,
  onCommitProvider,
  onPersistProbe,
  onStageDelete,
  onStageClear,
  onUnstageClear,
  pendingClears,
  saveVersion,
  providerDirty,
  onSaveProviders,
}: ProviderPageProps) {
  const [selected, setSelected] = useState<ProviderId>(() => getActiveProvider(settings).name);
  const [keyDirtyMap, setKeyDirtyMap] = useState<Map<ProviderId, boolean>>(new Map());
  const [keyVisibleMap, setKeyVisibleMap] = useState<Map<ProviderId, boolean>>(new Map());
  const [tests, setTests] = useState<Map<ProviderId, ProbeUiState>>(new Map());
  const [addOpen, setAddOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<ProviderId | null>(null);
  const [clearTarget, setClearTarget] = useState<ProviderId | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  const activeProvider = getActiveProvider(settings);
  const selectedProvider = settings.providers.find((p) => p.name === selected) ?? activeProvider;

  const requestFocusKey = useCallback(() => setFocusNonce((n) => n + 1), []);

  // 选中项失效（被删除/切换）时回落到当前 Provider
  useEffect(() => {
    if (!settings.providers.some((p) => p.name === selected)) {
      setSelected(settings.activeProvider);
    }
  }, [settings, selected]);

  useEffect(() => {
    if (focusNonce > 0) keyInputRef.current?.focus();
  }, [focusNonce]);

  // 保存成功后：所有 Key 均视为已落凭据库
  // biome-ignore lint/correctness/useExhaustiveDependencies: saveVersion 是刻意的「保存代数」触发器——正是要响应它的变化清 dirty
  useEffect(() => {
    setKeyDirtyMap(new Map());
  }, [saveVersion]);

  const handleFieldChange = useCallback(
    (name: string, field: ProviderField, value: string) => {
      if (field === 'apiKey') {
        if (value.trim()) {
          onUnstageClear(name); // 输入新 Key = 替换，不再是清除
        } else {
          onStageClear(name); // 手动清空输入框 = 也要真正删除凭据，否则保存后 Key 会「复活」
        }
        setKeyDirtyMap((m) => new Map(m).set(name, true));
      }
      onCommitProvider(updateProvider(settings, name, { [field]: value } as Partial<ProviderSettings>));
    },
    [settings, onCommitProvider, onStageClear, onUnstageClear],
  );

  /** per-model 覆盖（P14）：上下文窗口 / 最大输出，按模型 id 存 modelOverrides。 */
  const handleModelOverride = useCallback(
    (name: string, modelId: string, field: 'contextWindow' | 'maxTokens', value: number) => {
      const p = settings.providers.find((x) => x.name === name);
      const cur = p?.modelOverrides?.[modelId] ?? {};
      const nextOverrides = {
        ...(p?.modelOverrides ?? {}),
        [modelId]: { ...cur, [field]: value > 0 ? value : undefined },
      };
      onCommitProvider(updateProvider(settings, name, { modelOverrides: nextOverrides }));
    },
    [settings, onCommitProvider],
  );

  const handleRefreshModels = useCallback(async (): Promise<number> => {
    const p = selectedProvider;
    if (!p.apiKey?.trim()) throw new Error('请先填写 API Key');
    const prov = createProvider(p);
    // C5（2026-08-27）：手动刷新记目录失败面（compact 选择器分组头同步可见）；
    // 失败上抛给调用方显示真实原因（fetchModels 不再把网络失败伪装成「无模型」）。
    // 重构（2026-08-26）：拉取结果 = 该提供方「可用模型」列表（DSH /api/models 的
    // host 报告语义）——写进暂存 settings，随保存落盘；创作坞下拉据此列项。
    try {
      // R5 D8（2026-08-29）：拉取中面——选择器分组头「目录获取中…」同步可见
      markDynamicFetchStart(p.name);
      const models = (await prov.fetchModels?.()) ?? [];
      recordDynamicFetchResult(p.name, true);
      onCommitProvider(updateProvider(settings, p.name, { models: models.map((m) => m.id).filter(Boolean) }));
      return models.length;
    } catch (e) {
      recordDynamicFetchResult(p.name, false, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [selectedProvider, settings, onCommitProvider]);

  const handleAddModel = useCallback(
    (name: string, modelId: string) => {
      const id = modelId.trim();
      if (!id) return;
      const p = settings.providers.find((x) => x.name === name);
      const cur = Array.isArray(p?.models) ? (p?.models ?? []).filter((m) => m?.trim()) : [];
      // 旧数据无 models：先把当前默认模型并入，再追加新模型——默认模型不消失
      const seed = cur.length === 0 && p?.model?.trim() ? [p.model.trim()] : [];
      const next = seed.concat(cur.includes(id) ? [] : [id]);
      const patch: Partial<ProviderSettings> = { models: next };
      // 还没有「新会话默认」（= 最近使用，自动跟从创作坞）：第一个可用模型即默认
      if (!p?.model?.trim() && next.length > 0) patch.model = next[0];
      onCommitProvider(updateProvider(settings, name, patch));
    },
    [settings, onCommitProvider],
  );

  const handleRemoveModel = useCallback(
    (name: string, modelId: string) => {
      const p = settings.providers.find((x) => x.name === name);
      const cur = Array.isArray(p?.models) ? p.models : [];
      const next = cur.filter((m) => m !== modelId);
      const patch: Partial<ProviderSettings> = { models: next };
      // 删的是当前「新会话默认」→ 自动顶上第一个（无剩余则清空）
      if (p?.model === modelId) patch.model = next[0] ?? '';
      onCommitProvider(updateProvider(settings, name, patch));
    },
    [settings, onCommitProvider],
  );

  const handleTest = useCallback(async () => {
    const name = selectedProvider.name;
    if (!selectedProvider.apiKey?.trim()) {
      setTests((t) => new Map(t).set(name, { phase: 'fail', msg: '请先填写 API Key' }));
      return;
    }
    if (!selectedProvider.model?.trim()) {
      setTests((t) => new Map(t).set(name, { phase: 'fail', msg: '请先填写模型名称' }));
      return;
    }
    setTests((t) => new Map(t).set(name, { phase: 'testing', msg: '' }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const started = performance.now();
    try {
      const prov = createProvider(selectedProvider, { disableThinking: true });
      const gen = prov.stream(ctrl.signal, {
        messages: [{ role: 'user', content: 'ping' }],
        tools: [],
        temperature: 0,
        max_tokens: 1,
      });
      let received = false;
      for await (const chunk of gen) {
        if (chunk.type === ChunkType.Error) throw chunk.err ?? new Error('流错误');
        if (chunk.type === ChunkType.Text && chunk.text) {
          received = true;
          break;
        }
      }
      const latencyMs = Math.round(performance.now() - started);
      const msg = received ? formatLatency(latencyMs) : '连接成功（无文本返回，请检查模型行为）';
      const result: ConnectionProbe = { status: 'ok', latencyMs, at: Date.now(), message: msg };
      // B4：探针走最小落盘面（onPersistProbe 读盘-改 lastTest-写回），
      // 不再 onPersistSettings(updateProvider(settingsRef.current,...)) 全量提交暂存改动
      onPersistProbe(name, result);
      setTests((t) => new Map(t).set(name, { phase: 'ok', msg }));
    } catch (e) {
      const latencyMs = Math.round(performance.now() - started);
      const msg = e instanceof Error ? e.message || String(e) : String(e);
      const result: ConnectionProbe = { status: 'fail', latencyMs, at: Date.now(), message: msg };
      onPersistProbe(name, result);
      setTests((t) => new Map(t).set(name, { phase: 'fail', msg }));
    } finally {
      clearTimeout(timer);
    }
  }, [selectedProvider, onPersistProbe]);

  const handleAdd = useCallback(
    (entry: AddProviderEntry) => {
      try {
        const next = addProvider(settings, entry.name, entry.kind);
        const added = next.providers.find((p) => p.name === entry.name);
        if (added) {
          if (entry.apiKey?.trim()) added.apiKey = entry.apiKey.trim();
          if (entry.baseUrl?.trim()) added.baseUrl = entry.baseUrl.trim();
          if (entry.model?.trim()) added.model = entry.model.trim();
        }
        if (added?.apiKey?.trim()) {
          setKeyDirtyMap((m) => new Map(m).set(added.name, true));
        }
        onCommitProvider(next);
        setSelected(entry.name);
        setAddOpen(false);
        requestFocusKey();
      } catch (e) {
        // 弹层已做重复名校验；此处仅兜底
        console.warn('[provider] 添加失败:', e);
      }
    },
    [settings, onCommitProvider, requestFocusKey],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!delTarget) return;
    try {
      const next = removeProvider(settings, delTarget);
      onStageDelete(delTarget);
      onUnstageClear(delTarget);
      onCommitProvider(next);
      setSelected(next.activeProvider);
      setDelTarget(null);
      setTests((t) => {
        const next = new Map(t);
        next.delete(delTarget);
        return next;
      });
      setKeyDirtyMap((m) => {
        const next = new Map(m);
        next.delete(delTarget);
        return next;
      });
      setKeyVisibleMap((m) => {
        const next = new Map(m);
        next.delete(delTarget);
        return next;
      });
    } catch (e) {
      console.warn('[provider] 删除失败:', e);
      setDelTarget(null);
    }
  }, [settings, delTarget, onCommitProvider, onStageDelete, onUnstageClear]);

  const handleClearKeyConfirm = useCallback(() => {
    if (!clearTarget) return;
    onCommitProvider(updateProvider(settings, clearTarget, { apiKey: '' }));
    onStageClear(clearTarget);
    setKeyDirtyMap((m) => new Map(m).set(clearTarget, true));
    setClearTarget(null);
  }, [settings, clearTarget, onCommitProvider, onStageClear]);

  return (
    <>
      {!selectedProvider.apiKey?.trim() && (
        <div className="pp-onboard">
          <span className="pp-ob-icon">◈</span>
          <div className="pp-ob-text">
            <b>{selectedProvider.name}</b> 还没有可用的 Key。粘贴 API Key 后即可开始对话。
          </div>
          <button type="button" className="pp-ob-btn" onClick={requestFocusKey}>
            去填 Key →
          </button>
        </div>
      )}

      <div className="pp-split">
        <ProviderList
          providers={settings.providers}
          selected={selected}
          current={settings.activeProvider}
          onSelect={setSelected}
          onAdd={() => setAddOpen(true)}
        />
        <ProviderDetail
          provider={selectedProvider}
          canDelete={settings.providers.length > 1}
          test={tests.get(selectedProvider.name) ?? { phase: 'idle', msg: '' }}
          keyState={{
            saved: !keyDirtyMap.get(selectedProvider.name) && !!selectedProvider.apiKey?.trim(),
            pendingClear: pendingClears.includes(selectedProvider.name),
            visible: !!keyVisibleMap.get(selectedProvider.name),
            inputRef: keyInputRef,
          }}
          actions={{
            onFieldChange: (field, value) => handleFieldChange(selectedProvider.name, field, value),
            onFetchModels: handleRefreshModels,
            onAddModel: (modelId) => handleAddModel(selectedProvider.name, modelId),
            onRemoveModel: (modelId) => handleRemoveModel(selectedProvider.name, modelId),
            onModelOverride: (modelId, field, value) =>
              handleModelOverride(selectedProvider.name, modelId, field, value),
            onTest: handleTest,
            onClearKey: () => setClearTarget(selectedProvider.name),
            onResetBaseUrl: () =>
              onCommitProvider(
                updateProvider(settings, selectedProvider.name, {
                  baseUrl: defaultBaseUrl(selectedProvider.name, selectedProvider.kind),
                }),
              ),
            onToggleKeyVisible: () =>
              setKeyVisibleMap((m) => new Map(m).set(selectedProvider.name, !m.get(selectedProvider.name))),
            onDelete: () => setDelTarget(selectedProvider.name),
          }}
        />
      </div>

      {providerDirty && (
        <div className="pp-save-bar">
          <span className="pp-save-bar-dot" />
          <span className="pp-save-bar-text">有未保存的提供方更改</span>
          <button type="button" className="pp-save-btn" onClick={onSaveProviders}>
            保存 Provider
          </button>
        </div>
      )}

      <AddProviderSheet
        open={addOpen}
        existingNames={settings.providers.map((p) => p.name)}
        onClose={() => setAddOpen(false)}
        onAdd={handleAdd}
      />

      <ConfirmDialog
        open={delTarget !== null}
        title="删除提供方"
        message={
          <>
            确定删除 <b>{delTarget}</b>？其<strong>系统凭据 Key 将一并删除</strong>（保存后生效），此操作不可撤销。
          </>
        }
        confirmLabel="确认删除"
        tone="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDelTarget(null)}
      />

      <ConfirmDialog
        open={clearTarget !== null}
        title="清除已保存 Key"
        message={
          <>
            将从系统凭据中删除 <b>{clearTarget}</b> 的 API Key（保存后生效）。删除后该提供方将处于未配置状态。
          </>
        }
        confirmLabel="清除"
        tone="danger"
        onConfirm={handleClearKeyConfirm}
        onCancel={() => setClearTarget(null)}
      />
    </>
  );
}
