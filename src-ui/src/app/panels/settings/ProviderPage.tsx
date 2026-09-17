// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 标签页（提供方控制台）：
// 左侧 ProviderList 选提供方，右侧 ProviderDetail 编辑；
// 添加/删除/清除 Key 均为「暂存」，保存时统一落盘 + 写/删凭据 + 重建 Agent。

import { useCallback, useEffect, useRef, useState } from 'react';
import { createProvider } from '../../../provider';
import { markDynamicFetchStart, mergeDynamicModels, recordDynamicFetchResult } from '../../../provider/catalog';
import { invalidateCredentialCache } from '../../../provider/credentials';
import { createLiveProvider } from '../../../provider/live';
import { applyFetchedModels } from '../../../provider/model-sync';
import { oauthAccounts, oauthLogout, runDeviceLogin } from '../../../provider/oauth';
import type { Provider } from '../../../provider/types';
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
  /** 添加提供方即时生效（2026-09-06）：一步落盘 + 写 Key + settings-saved 热广播，
   *  使新提供方模型立刻全会话可选（不再走暂存-保存条）。next 已含新 provider。 */
  onAddAndPersist: (next: AppSettings, addedName: ProviderId) => Promise<void>;
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
  onAddAndPersist,
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
  // Phase 3D：OAuth 登录状态（busy = device-flow 进行中；status = 用户可读反馈；
  // accounts = 选中行的已登录账号清单；loggedInMap = 全部 oauth provider 的登录态）
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<{ tone: 'info' | 'ok' | 'fail'; msg: string } | null>(null);
  const [oauthAccountsState, setOauthAccountsState] = useState<Array<{ accountId: string }>>([]);
  const [oauthLoggedInMap, setOauthLoggedInMap] = useState<Record<string, boolean>>({});
  // device-flow 进行中的取消标志（登录发起时置 false；取消置 true → 轮询停）
  const oauthCancelRef = useRef(false);

  const activeProvider = getActiveProvider(settings);
  const selectedProvider = settings.providers.find((p) => p.name === selected) ?? activeProvider;

  // settings 的 ref 镜像——oauth 登录态刷新 callback 读它而不依赖 settings 对象，
  // 保证 mount effect 不因 settings 引用变化重跑全量查询（2026-09 UX 走查）。
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

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

  // 连接测试在途守卫（2026-09-01 审计）：面板关闭后回包不再 setState/落盘
  // 探针结果——AbortController 只管 15s 超时，不管卸载。
  const testAliveRef = useRef(true);
  useEffect(() => {
    testAliveRef.current = true;
    return () => {
      testAliveRef.current = false;
    };
  }, []);

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

  /** 视觉声明覆盖（B5 · D-8①）：on = 强制 ['text','image']（附图入口 + 请求期
   *  投影放行）；off = 清覆盖回落目录声明。GLM-4V/Qwen-VL 等目录外 vision
   *  模型的补声明面。 */
  const handleModelVisionToggle = useCallback(
    (name: string, modelId: string, on: boolean) => {
      const p = settings.providers.find((x) => x.name === name);
      const cur = p?.modelOverrides?.[modelId] ?? {};
      const nextOverrides = {
        ...(p?.modelOverrides ?? {}),
        [modelId]: { ...cur, input: on ? (['text', 'image'] as ('text' | 'image')[]) : undefined },
      };
      onCommitProvider(updateProvider(settings, name, { modelOverrides: nextOverrides }));
    },
    [settings, onCommitProvider],
  );

  /** 高级连接配置（2026-09-17）：请求头编辑 / 配方导入的整行回填——名字与密钥
   *  由 ProviderAdvanced 保持本行值；此处按既有 onChange 即时落盘惯例提交。 */
  const handleAdvancedChange = useCallback(
    (name: string, next: ProviderSettings) => {
      onCommitProvider(updateProvider(settings, name, next));
    },
    [settings, onCommitProvider],
  );

  const handleRefreshModels = useCallback(async (): Promise<number> => {
    const p = selectedProvider;
    // oauth 订阅（Codex）：无 API Key——必须已登录（live provider 注入 grant）才能拉。
    // 未登录时 live provider 抛 OAUTH_NOT_LOGGED_IN（见 live.ts buildInner）——可读提示。
    let prov: Provider;
    if (p.authMode === 'oauth') {
      if (!p.oauthProvider) throw new Error('该订阅缺 oauth 登录配置——请重新添加');
      prov = createLiveProvider(p.name, {});
    } else {
      if (!p.apiKey?.trim()) throw new Error('请先填写 API Key');
      prov = createProvider(p);
    }
    // C5（2026-08-27）：手动刷新记目录失败面（compact 选择器分组头同步可见）；
    // 失败上抛给调用方显示真实原因（fetchModels 不再把网络失败伪装成「无模型」）。
    // 重构（2026-08-26）：拉取结果 = 该提供方「可用模型」列表（DSH /api/models 的
    // host 报告语义）——写进暂存 settings，随保存落盘；创作坞下拉据此列项。
    // provider-model-meta（2026-09-11）：**元数据一并落盘**——适配器的宽容解析层
    // 认出的窗口/输出上限/视觉/推理（含聚合网关的 name + context_length）经
    // lastModelMeta 取出，写进 ProviderSettings.modelMeta（暂存，保存即持久化）。
    // 此前只落 id 列表，元数据随进程消失 → 网关模型重启后一律吃 200K 假默认。
    try {
      // R5 D8（2026-08-29）：拉取中面——选择器分组头「目录获取中…」同步可见
      markDynamicFetchStart(p.name);
      const models = (await prov.fetchModels?.()) ?? [];
      recordDynamicFetchResult(p.name, true);
      // 进程内目录（展示面即时生效：选择器里的显示名/窗口徽标）；
      // 落盘面走 applyFetchedModels（不可变 settings → 暂存 → 保存）
      if (models.length > 0) mergeDynamicModels(p.name, models);
      onCommitProvider(applyFetchedModels(settings, p.name, { models, meta: prov.lastModelMeta?.() ?? {} }));
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
    const isOAuth = selectedProvider.authMode === 'oauth';
    if (!isOAuth && !selectedProvider.apiKey?.trim()) {
      setTests((t) => new Map(t).set(name, { phase: 'fail', msg: '请先填写 API Key' }));
      return;
    }
    if (!selectedProvider.model?.trim()) {
      setTests((t) => new Map(t).set(name, { phase: 'fail', msg: '请先填写模型名称' }));
      return;
    }
    if (isOAuth && !selectedProvider.oauthProvider) {
      setTests((t) => new Map(t).set(name, { phase: 'fail', msg: '该订阅缺 oauth 登录配置——请重新添加' }));
      return;
    }
    setTests((t) => new Map(t).set(name, { phase: 'testing', msg: '' }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const started = performance.now();
    try {
      // oauth 订阅行走 live provider（按名现解析 oauth grant 注入请求头）——
      // 直接 createProvider(settings) 不带 oauth headers，空 Bearer 必挂（2026-09 走查）。
      const prov = isOAuth
        ? createLiveProvider(name, { disableThinking: true })
        : createProvider(selectedProvider, { disableThinking: true });
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
      if (!testAliveRef.current) return; // 卸载后回包：不落盘不 setState
      const latencyMs = Math.round(performance.now() - started);
      const msg = received ? formatLatency(latencyMs) : '连接成功（无文本返回，请检查模型行为）';
      const result: ConnectionProbe = { status: 'ok', latencyMs, at: Date.now(), message: msg };
      // B4：探针走最小落盘面（onPersistProbe 读盘-改 lastTest-写回），
      // 不再 onPersistSettings(updateProvider(settingsRef.current,...)) 全量提交暂存改动
      onPersistProbe(name, result);
      setTests((t) => new Map(t).set(name, { phase: 'ok', msg }));
    } catch (e) {
      if (!testAliveRef.current) return;
      const latencyMs = Math.round(performance.now() - started);
      const msg = e instanceof Error ? e.message || String(e) : String(e);
      const result: ConnectionProbe = { status: 'fail', latencyMs, at: Date.now(), message: msg };
      onPersistProbe(name, result);
      setTests((t) => new Map(t).set(name, { phase: 'fail', msg }));
    } finally {
      clearTimeout(timer);
    }
  }, [selectedProvider, onPersistProbe]);

  /** Phase 3D：oauth 登录态全量刷新（ProviderList 逐行状态推导）。
   *  只在 mount / 登录成功 / 登出后调用——每次账号变更都是显式落点。 */
  const refreshOauthLoginMap = useCallback(async () => {
    const oauthRows = settingsRef.current.providers.filter((p) => p.authMode === 'oauth' && p.oauthProvider);
    const providerIds = [...new Set(oauthRows.map((p) => p.oauthProvider as string))];
    if (providerIds.length === 0) {
      setOauthLoggedInMap({});
      return;
    }
    const loginMap: Record<string, boolean> = {};
    await Promise.all(
      providerIds.map(async (pid) => {
        try {
          const accts = await oauthAccounts(pid);
          loginMap[pid] = accts.length > 0;
        } catch {
          loginMap[pid] = false;
        }
      }),
    );
    setOauthLoggedInMap(loginMap);
  }, []);

  /** 选中 provider 的账号清单刷新（Detail 登录面板展示）。 */
  const refreshSelectedOauthAccounts = useCallback(async () => {
    const p = selectedProvider;
    if (p.authMode === 'oauth' && p.oauthProvider) {
      try {
        const accts = await oauthAccounts(p.oauthProvider);
        setOauthAccountsState(accts.map((a) => ({ accountId: a.account_id })));
        return;
      } catch {
        /* fallthrough — 空清单 */
      }
    }
    setOauthAccountsState([]);
  }, [selectedProvider]);

  /** 两步式添加收口（2026-09-06）：加进 settings → 即时落盘 + 写 Key +
   *  settings-saved 热广播（新提供方模型立刻全会话可选）。不再走暂存-保存条。
   *  OAuth 订阅（2026-09-11）：登录已前置到添加弹层内完成（grant 与行解耦，
   *  弹层内登录即可直接建行）——此处刷新登录态只是列表状态点同步。 */
  const handleAdd = useCallback(
    async (entry: AddProviderEntry) => {
      try {
        const next = addProvider(settings, entry.name, entry.kind);
        const added = next.providers.find((p) => p.name === entry.name);
        if (added) {
          if (entry.apiKey?.trim()) added.apiKey = entry.apiKey.trim();
          if (entry.baseUrl?.trim()) added.baseUrl = entry.baseUrl.trim();
          added.models = entry.models;
          added.model = entry.model;
          // provider-model-meta：拉取到的元数据随行落盘（新行出生即带窗口/视觉/
          // 推理；未拉取或端点未披露 = 缺省，不编造）
          if (entry.modelMeta && Object.keys(entry.modelMeta).length > 0) {
            added.modelMeta = entry.modelMeta;
          }
          // Phase 3D：登录方式（codex 等 oauth 订阅行）
          if (entry.authMode) added.authMode = entry.authMode;
          if (entry.oauthProvider) added.oauthProvider = entry.oauthProvider;
        }
        setKeyDirtyMap((m) => (entry.apiKey?.trim() ? new Map(m).set(entry.name, true) : m));
        await onAddAndPersist(next, entry.name);
        setSelected(entry.name);
        setAddOpen(false);
        // oauth 行：弹层内可能已登录（grant 与行解耦）——添加后刷新列表登录态
        if (entry.authMode === 'oauth' && entry.oauthProvider) {
          void refreshOauthLoginMap();
          void refreshSelectedOauthAccounts();
        }
      } catch (e) {
        // 落盘/写 Key 失败——保留弹层让用户重试，错误可见（错误不静默）
        console.warn('[provider] 添加持久化失败:', e);
      }
    },
    [settings, onAddAndPersist, refreshOauthLoginMap, refreshSelectedOauthAccounts],
  );

  // mount 时全量 oauth 登录态（ProviderList 状态点）——
  // refreshOauthLoginMap 空依赖恒等（settingsRef 读最新），effect 不因 settings 变重跑
  useEffect(() => {
    void refreshOauthLoginMap();
  }, [refreshOauthLoginMap]);
  // 选中 provider 变化时刷新 Detail 账号清单
  useEffect(() => {
    void refreshSelectedOauthAccounts();
  }, [refreshSelectedOauthAccounts]);

  /** OAuth 登录（device-code 编排）：开浏览器 + 轮询 → 成功后落库 + 刷新账号。
   *  UI 展示等待面板（code + URL）由 oauthStatus 反馈带出。 */
  const handleOauthLogin = useCallback(async () => {
    const p = selectedProvider;
    if (p.authMode !== 'oauth' || !p.oauthProvider) return;
    setOauthBusy(true);
    oauthCancelRef.current = false;
    setOauthStatus({ tone: 'info', msg: '正在获取设备授权码…' });
    try {
      // 展示授权码 + URL（把流程信息经 status 反馈给用户）
      await runDeviceLogin(
        p.oauthProvider,
        {
          onAwaitingUser: (flow) => {
            setOauthStatus({
              tone: 'info',
              msg: `请在浏览器打开授权页并输入代码 ${flow.user_code}：${flow.verification_uri}`,
            });
          },
          onGranted: async () => {
            await refreshOauthLoginMap();
            await refreshSelectedOauthAccounts();
            invalidateCredentialCache(p.name);
            setOauthStatus({ tone: 'ok', msg: '登录成功——该 Codex 账号已可用于对话' });
          },
          onError: (err) => {
            setOauthStatus({ tone: 'fail', msg: `登录失败：${err.message}` });
          },
          isCancelled: () => oauthCancelRef.current,
        },
        { openBrowser: true },
      );
    } finally {
      setOauthBusy(false);
    }
  }, [selectedProvider, refreshOauthLoginMap, refreshSelectedOauthAccounts]);

  /** 登出某账号。 */
  const handleOauthLogout = useCallback(
    async (accountId: string) => {
      const p = selectedProvider;
      if (p.authMode !== 'oauth' || !p.oauthProvider) return;
      try {
        await oauthLogout(p.oauthProvider, accountId);
        invalidateCredentialCache(p.name);
        setOauthStatus({ tone: 'ok', msg: `已登出账号 ${accountId}` });
        await refreshOauthLoginMap();
        await refreshSelectedOauthAccounts();
      } catch (e) {
        setOauthStatus({ tone: 'fail', msg: `登出失败：${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [selectedProvider, refreshOauthLoginMap, refreshSelectedOauthAccounts],
  );

  /** 取消进行中的 device-flow。 */
  const handleOauthCancel = useCallback(() => {
    oauthCancelRef.current = true;
    setOauthStatus({ tone: 'info', msg: '正在取消登录…' });
  }, []);

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
      {!selectedProvider.apiKey?.trim() && selectedProvider.authMode !== 'oauth' && (
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
          oauthLoggedInMap={oauthLoggedInMap}
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
            onModelVisionToggle: (modelId, on) => handleModelVisionToggle(selectedProvider.name, modelId, on),
            onAdvancedChange: (next) => handleAdvancedChange(selectedProvider.name, next),
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
          oauthData={{
            accounts: oauthAccountsState,
            busy: oauthBusy,
            status: oauthStatus,
            onLogin: handleOauthLogin,
            onLogout: handleOauthLogout,
            onCancel: handleOauthCancel,
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
