// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页右侧「调谐控制台」：编辑选中提供方的连接配置 / 诊断 / 危险区。
// 状态展示与测试结果均按 provider 独立，切换提供方不会串台。

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDynamicFetchFailure, getModel, onDynamicFetchChange } from '../../../provider/catalog';
import { type StoredThinking, thinkingModeLabel, thinkingOptionsOrDefault } from '../../../provider/thinking';
import {
  effectiveModels,
  isFactoryBaseUrl,
  modelContextWindow,
  modelDescriptor,
  modelInput,
  modelMaxTokens,
  type ProbeOutcome,
  type ProviderSettings,
} from '../../../settings';
import { ProviderAdvanced } from './ProviderAdvanced';
import { ProviderDocCard } from './ProviderDocCard';
import { protocolLabel } from './protocol';
import { formatLatency, formatTestAt, providerStatus, STATUS_LABEL } from './status';

export type ProviderField = 'apiKey' | 'baseUrl' | 'model' | 'thinking';

/** per-model 参数的来源标注字段（provider-model-meta 四层链的展示面）。 */
type MetaField = 'contextWindow' | 'maxTokens' | 'input';

/** per-model 思考档位 select 的「未覆盖」哨兵值（'' 有实义 = 显式「自动」，
 *  不能拿来当「随默认」——两者语义不同，混用会把用户的显式选择吃掉）。 */
const INHERIT_THINKING = '__inherit__';

/** 该字段当前生效值的来源（给用户看清「这个数是哪儿来的」）：
 *  手动设置 > API 拉取（带日期）> 目录 seed > 未提供。
 *  此前面板只显示 `目录值 || 200000` 占位符——网关模型的「200000」是编造的
 *  默认值，用户无从分辨它是不是真值。 */
function metaSource(provider: ProviderSettings, id: string, field: MetaField): string {
  const has = (v: unknown): boolean =>
    field === 'input' ? Array.isArray(v) && v.length > 0 : typeof v === 'number' && v > 0;
  const ov = provider.modelOverrides?.[id];
  if (has(field === 'input' ? ov?.input : ov?.[field])) return '手动设置';
  const meta = provider.modelMeta?.[id];
  if (has(field === 'input' ? meta?.input : meta?.[field])) {
    return meta?.fetchedAt ? `API 拉取 · ${new Date(meta.fetchedAt).toLocaleDateString()}` : 'API 拉取';
  }
  if (has(getModel(id)?.[field])) return '目录';
  return '未提供';
}

/** per-model 思考档位表（与请求期同一把尺子）：该模型声明表无声明时给协议安全兜底。 */
function modelThinkingOptions(provider: ProviderSettings, id: string): readonly { value: string; label: string }[] {
  return thinkingOptionsOrDefault(modelDescriptor(provider, id));
}

/** 连接探针的 UI 阶段（瞬时态，不持久化）；结果本体见 ConnectionProbe。 */
export type ProbeUiPhase = 'idle' | 'testing' | ProbeOutcome;

export interface ProbeUiState {
  phase: ProbeUiPhase;
  msg: string;
}

interface ProviderDetailProps {
  provider: ProviderSettings;
  canDelete: boolean;
  test: ProbeUiState;
  /** Key 栏 UI 状态簇：已保存 / 清除暂存 / 明文可见 / 输入框引用 */
  keyState: KeyUiState;
  /** 控制台全部回调簇 */
  actions: ProviderDetailActions;
  /** Phase 3D：OAuth 登录数据面（authMode='oauth' 的 provider 专用；缺省 = apiKey 路径）。 */
  oauthData?: OAuthData;
}

/** Key 栏 UI 状态簇（本地暂存，非持久化配置） */
export interface KeyUiState {
  /** 当前 Key 是否已保存在系统凭据（未在本会话内改动） */
  saved: boolean;
  /** 该 provider 是否有「清除 Key」暂存（保存时才删凭据） */
  pendingClear: boolean;
  /** Key 是否明文显示 */
  visible: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

/** 控制台回调簇：所有动作统一经此 seam 注入，便于测试与复用 */
export interface ProviderDetailActions {
  onFieldChange: (field: ProviderField, value: string) => void;
  /** 从 API 拉取该提供方可用模型列表（写进暂存 settings.models）。 */
  onFetchModels: () => Promise<number>;
  /** 向「可用模型」列表添加一个模型 id（旧数据无 models 时先并入默认模型）。 */
  onAddModel: (modelId: string) => void;
  /** 从「可用模型」列表移除一个模型 id。 */
  onRemoveModel: (modelId: string) => void;
  /** 整份写「可用模型」（2026-09-23 三层）：目录区勾选/全选/全部取消的写入口。 */
  onSetEnabledModels: (ids: readonly string[]) => void;
  /** per-model 覆盖（P14）：上下文窗口 / 最大输出，0 = 清回目录值。 */
  onModelOverride: (modelId: string, field: 'contextWindow' | 'maxTokens', value: number) => void;
  /** per-model 思考档位覆盖（2026-09-23 思考下沉）：undefined = 清覆盖回本家默认。 */
  onModelThinking: (modelId: string, value: StoredThinking | undefined) => void;
  /** 视觉声明覆盖（B5 · D-8①）：on = ['text','image'] 强制开；off = 清覆盖回落目录。 */
  onModelVisionToggle: (modelId: string, on: boolean) => void;
  /** 高级连接配置（2026-09-17）：请求头编辑的整行回填（名字与密钥保持本行）。 */
  onAdvancedChange: (next: ProviderSettings) => void;
  /** 配置文件面（2026-09-24 配方改文件批）：provider 意图的唯一权威是
   *  `~/.lantai/providers.yml`——这里给路径、逐节错误、打开目录与重读入口。 */
  doc: ProviderDocView;
  onOpenDocDir: () => void;
  onReloadDoc: () => void;
  /** 配置文件操作的回执（打开失败/已重读）。 */
  docMsg: string;
  onTest: () => void;
  onClearKey: () => void;
  onResetBaseUrl: () => void;
  onToggleKeyVisible: () => void;
  onDelete: () => void;
}

/** 配置文件在详情页的读面（形状与 ProviderPage.ProvidersDocView 同源）。 */
export interface ProviderDocView {
  path: string;
  status: {
    path: string;
    errors: Array<{ name: string; message: string }>;
    fatal?: string;
    empty: boolean;
    loaded: boolean;
    available: boolean;
    lastError: string;
  };
  projectErrors: ReadonlyArray<{ name: string; message: string }>;
  projectFatal?: string;
  /** 外部改动到达时有未保存暂存 ⇒ 面板没替换（提示用户先保存/放弃）。 */
  staleHint: boolean;
  /** 手动重试取路径（通道就绪后不必重启应用）。 */
  onRetryPath?: () => void;
}

/** Phase 3D：OAuth 订阅登录数据面（authMode='oauth' 的 provider 专用）。
 *  ProviderDetail 据此渲染登录面板（替代 API Key 输入区）。 */
export interface OAuthData {
  accounts: Array<{ accountId: string }>;
  busy: boolean;
  status: { tone: 'info' | 'ok' | 'fail'; msg: string } | null;
  onLogin: () => void;
  onLogout: (accountId: string) => void;
  onCancel: () => void;
}

export function ProviderDetail({ provider, canDelete, test, keyState, actions, oauthData }: ProviderDetailProps) {
  const { saved: keySaved, pendingClear, visible: keyVisible, inputRef: keyInputRef } = keyState;
  const isOAuth = provider.authMode === 'oauth';
  const {
    onFieldChange,
    onFetchModels,
    onAddModel,
    onRemoveModel,
    onSetEnabledModels,
    onModelOverride,
    onModelThinking,
    onModelVisionToggle,
    onAdvancedChange,
    doc,
    onOpenDocDir,
    onReloadDoc,
    docMsg,
    onTest,
    onClearKey,
    onResetBaseUrl,
    onToggleKeyVisible,
    onDelete,
  } = actions;
  // ── 「可用模型」列表编辑器本地态（瞬时 UI，不持久化）──
  const models = effectiveModels(provider);
  // ── 模型目录（远端事实，2026-09-23 三层：目录 / 启用 / 选中）──
  // 目录 = 最近一次「刷新目录」的快照（provider.catalog）；缺省 = 从未拉取。
  const catalogIds = useMemo(
    () => (Array.isArray(provider.catalog) ? provider.catalog.filter((m) => m?.trim()) : []),
    [provider.catalog],
  );
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  // 本组件跨 provider 复用（无 key）——切行必须重置目录区本地态，否则 A 家的搜索词
  // 与展开态串到 B 家（与 paramModel 同族的本地态纪律）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider.name 是刻意的重置触发器（切行/新拉取），非 effect 体内读取值——与 ComposerDock settingsTick 同款手法
  useEffect(() => {
    setCatalogOpen(catalogIds.length > 0);
    setCatalogQuery('');
  }, [provider.name, catalogIds.length]);
  const catalogRows = useMemo(() => {
    const q = catalogQuery.toLowerCase().trim();
    if (!q) return catalogIds;
    return catalogIds.filter(
      (id) => id.toLowerCase().includes(q) || (modelDescriptor(provider, id)?.name ?? '').toLowerCase().includes(q),
    );
  }, [catalogIds, catalogQuery, provider]);
  /** 目录头的时间标注：端点未披露任何元数据时没有 fetchedAt（空壳条目不落盘）——
   *  如实说「有快照但无元数据」，不编造时间。 */
  const catalogMeta = useMemo(() => {
    if (catalogIds.length === 0) return '尚未拉取';
    let last = 0;
    for (const id of catalogIds) {
      const t = provider.modelMeta?.[id]?.fetchedAt ?? 0;
      if (t > last) last = t;
    }
    return last > 0 ? `拉取自 API · ${new Date(last).toLocaleDateString()}` : '已有快照（端点未披露元数据）';
  }, [catalogIds, provider.modelMeta]);
  const [newModel, setNewModel] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState('');
  /* 后台目录拉取的失败面（2026-09-23）：原因一直存在（catalog 的失败表，键 = 提供方名），
   * 但此前只在**创作坞**分组头的 hover 里可见——那儿没有可操作的补救入口，用户只看到
   * 一个没有下文的「目录获取失败」。这里就地显示原因，重试 = 上方「刷新目录」按钮。
   * 订阅 onDynamicFetchChange（后台拉取随时收尾）。 */
  const [catalogFail, setCatalogFail] = useState<string | undefined>(() => getDynamicFetchFailure(provider.name));
  useEffect(() => {
    const sync = () => setCatalogFail(getDynamicFetchFailure(provider.name));
    sync();
    return onDynamicFetchChange(sync);
  }, [provider.name]);
  // per-model 参数展开（参数编辑器作用到哪个模型）
  const [paramModel, setParamModel] = useState<string | null>(null);
  const handleFetch = useCallback(async () => {
    if (fetching) return;
    setFetching(true);
    setFetchMsg('');
    try {
      const count = await onFetchModels();
      setFetchMsg(
        count > 0
          ? `目录已更新：${count} 个模型——在下方「模型目录」里点「添加」挑要用的`
          : '端点未返回模型——可手动补模型 id',
      );
    } catch (e) {
      setFetchMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [fetching, onFetchModels]);
  const submitAdd = useCallback(() => {
    const id = newModel.trim();
    if (!id) return;
    onAddModel(id);
    setNewModel('');
  }, [newModel, onAddModel]);
  const st = providerStatus(provider, isOAuth ? (oauthData?.accounts.length ?? 0) > 0 : false);
  const statusCls = test.phase === 'testing' ? 'testing' : st;
  const statusLabel = test.phase === 'testing' ? '测试中…' : STATUS_LABEL[st];
  // P14 能力协商 + 2026-09-23 思考下沉：档位表来自**该模型**的生效描述符
  // （provider 作用域合并链 = 用户覆盖 + API 拉取元数据 + 目录 seed）。
  // 本控件 = 「本家默认档位」——只作用于**没单独设置过档位**的模型；单个模型在
  // 上方「可用模型」的「参数」面板里覆盖（modelOverrides[id].thinking）。
  const modelDesc = modelDescriptor(provider, provider.model);
  const thinkingModes = thinkingOptionsOrDefault(modelDesc);
  const thinkingHint = `作用于本家未单独设置档位的模型（当前档位表来自「${modelDesc?.name ?? (provider.model || '—')}」）；单个模型在「参数」里覆盖。声明外的档位不可选（不会静默替换为其他档位）。`;
  const isFactoryUrl = isFactoryBaseUrl(provider.baseUrl);

  const keyChip = provider.apiKey?.trim()
    ? keySaved
      ? '已保存到系统凭据'
      : '未保存 · 保存后写入'
    : pendingClear
      ? '清除待保存生效'
      : '未设置';
  const keyChipCls = provider.apiKey?.trim() ? (keySaved ? ' saved' : ' unsaved') : ' clear';

  const testBlock =
    test.phase === 'ok' ? (
      <div className="pp-test-result ok">✓ 连接成功{test.msg && <span className="pp-tr-sub"> · {test.msg}</span>}</div>
    ) : test.phase === 'fail' ? (
      <div className="pp-test-result fail">
        ✕ 连接失败
        {test.msg && (
          <>
            <br />
            <span className="pp-tr-sub">{test.msg}</span>
          </>
        )}
      </div>
    ) : null;

  return (
    <section className="pp-console">
      <div className="pp-console-head">
        <span className="pp-name">{provider.name}</span>
        <span className={`pp-badge pp-badge-${provider.kind}`}>{protocolLabel(provider.kind)}</span>
        <span className={`pp-status-pill pp-pill-${statusCls}`}>
          <i className="pp-pdot" />
          {statusLabel}
        </span>
        <span className="pp-spacer" />
      </div>

      <div className="pp-card">
        <div className="pp-card-hd">
          <span className="pp-card-title">连接配置</span>
          <span className="pp-rule" />
        </div>

        {isOAuth ? (
          /* ── Phase 3D：OAuth 订阅登录面板（替代 API Key 输入）── */
          <div className="pp-field">
            <div className="pp-f-label-row">
              <span className="pp-f-label">登录方式</span>
              <span className="pp-chip">OAuth 订阅</span>
            </div>
            {oauthData && oauthData.accounts.length > 0 ? (
              <div className="pp-oauth-accounts">
                {oauthData.accounts.map((acct) => (
                  <div key={acct.accountId} className="pp-model-item">
                    <span className="pp-model-chip" title={acct.accountId}>
                      <span className="pp-model-chip-name">{acct.accountId}</span>
                      <button
                        type="button"
                        className="pp-model-chip-x"
                        title={`登出 ${acct.accountId}`}
                        aria-label={`登出 ${acct.accountId}`}
                        onClick={() => oauthData?.onLogout(acct.accountId)}
                      >
                        登出
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pp-f-hint">尚未登录任何账号。点击下方按钮，用浏览器完成 ChatGPT Codex 授权登录。</div>
            )}
            {oauthData?.status && !oauthData.busy && (
              <div className={`pp-oauth-status ${oauthData.status.tone}`}>{oauthData.status.msg}</div>
            )}
            <div className="pp-oauth-actions">
              <button
                type="button"
                className="sp-btn-sm"
                disabled={oauthData?.busy}
                onClick={() => oauthData?.onLogin()}
              >
                {oauthData?.busy
                  ? '等待浏览器授权…'
                  : oauthData && oauthData.accounts.length > 0
                    ? '再登录一个账号'
                    : '登录 Codex'}
              </button>
              {oauthData?.busy && (
                <button type="button" className="sp-btn-sm pp-btn-danger" onClick={() => oauthData?.onCancel()}>
                  取消登录
                </button>
              )}
            </div>
            {oauthData?.busy && oauthData.status && (
              <div className="pp-f-hint">
                {oauthData.status.msg}
                <br />
                （轮询中——授权完成后自动生效；可在浏览器取消）
              </div>
            )}
          </div>
        ) : (
          <div className="pp-field">
            <div className="pp-f-label-row">
              <label className="pp-f-label" htmlFor="pd-api-key">
                API Key
              </label>
              <span className={`pp-chip${keyChipCls}`}>{keyChip}</span>
            </div>
            <div className="pp-key-row">
              <input
                id="pd-api-key"
                ref={keyInputRef}
                type={keyVisible ? 'text' : 'password'}
                className="sp-input"
                value={provider.apiKey || ''}
                onChange={(e) => onFieldChange('apiKey', e.target.value)}
                onBlur={(e) => {
                  // 剥离非 ASCII（Key 只允许 ASCII）
                  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII 范围判定必需
                  e.target.value = e.target.value.replace(/[^\x00-\x7F]/g, '');
                }}
                placeholder="sk-… 粘贴后保存写入系统凭据"
                autoComplete="off"
              />
              <button
                type="button"
                className="sp-btn-sm"
                title={keyVisible ? '隐藏' : '显示'}
                onClick={onToggleKeyVisible}
              >
                {keyVisible ? '隐藏' : '显示'}
              </button>
              {provider.apiKey?.trim() && keySaved && (
                <button
                  type="button"
                  className="sp-btn-sm pp-btn-danger"
                  title="从系统凭据中删除该 Key"
                  onClick={onClearKey}
                >
                  清除
                </button>
              )}
            </div>
            <div className="pp-f-hint">Key 只保存在本机系统加密凭据中，不会写入 localStorage。</div>
          </div>
        )}

        {/* 模型区（2026-09-23 三层重构：目录 / 启用 / 选中）：
            可用模型 = 用户从目录里**添加**进来的（创作坞下拉可选面）；
            「刷新目录」只更新目录快照（catalog）与元数据，**不改**可用模型。 */}
        <div className="pp-field">
          <div className="pp-f-label-row">
            <label className="pp-f-label" htmlFor="pd-models-input">
              可用模型
            </label>
            <span className="pp-chip">{models.length} 个</span>
            {/* oauth 订阅（Codex）：登录后也可从账号 API 拉取真实模型——非「账号自动提供」 */}
            <button type="button" className="sp-btn-sm" disabled={fetching} onClick={handleFetch}>
              {fetching ? '拉取中…' : '刷新目录'}
            </button>
          </div>
          {/* 后台目录拉取的失败原因（2026-09-23）：原因就地显示 + 重试就在上一行
              （此前只在创作坞徽标 hover 里，那儿做不了任何补救） */}
          {catalogFail && (
            <div className="pp-catalog-fail" title={catalogFail}>
              <span>目录拉取失败（后台）：{catalogFail}</span>
              <span className="pp-catalog-fail-hint">已启用的模型不受影响；点上方「刷新目录」重试。</span>
            </div>
          )}
          {models.length > 0 && (
            <div className="pp-models-list">
              {models.map((id) => {
                // 视觉声明覆盖态（B5）：覆盖里显式声明 image = 开（目录/API 声明不在此
                // 钮态里——那是回落值，钮只展示/操控覆盖本身）
                const visionOn = provider.modelOverrides?.[id]?.input?.includes('image') === true;
                // 生效输入模态（覆盖 ?? API 拉取 ?? 目录）——「视」徽标与创作坞门禁同链
                const visionEffective = modelInput(provider, id).includes('image');
                return (
                  <div key={id} className="pp-model-item">
                    <span className={`pp-model-chip${id === provider.model ? ' is-default' : ''}`} title={id}>
                      <span className="pp-model-chip-name">{modelDescriptor(provider, id)?.name ?? id}</span>
                      {visionEffective && (
                        <span className="pp-model-chip-vision" title="视觉模型（覆盖 / API 拉取 / 目录声明）">
                          视
                        </span>
                      )}
                      {id === provider.model && (
                        <span
                          className="pp-model-chip-default"
                          title="「新会话默认」= 最近在创作坞选用的模型——自动跟从，在此不可改"
                        >
                          新会话默认
                        </span>
                      )}
                      <button
                        type="button"
                        className="pp-model-chip-param"
                        title="上下文窗口 / 最大输出"
                        onClick={() => setParamModel(paramModel === id ? null : id)}
                      >
                        {paramModel === id ? '收起' : '参数'}
                      </button>
                      <button
                        type="button"
                        className="pp-model-chip-x"
                        title={`移除 ${id}`}
                        aria-label={`移除 ${id}`}
                        onClick={() => onRemoveModel(id)}
                      >
                        ✕
                      </button>
                    </span>
                    {paramModel === id && (
                      <div className="pp-model-params">
                        <label className="pp-model-param">
                          <span>上下文窗口</span>
                          <input
                            type="number"
                            min={0}
                            value={provider.modelOverrides?.[id]?.contextWindow ?? ''}
                            placeholder={String(modelContextWindow(provider, id, 0) || '未知')}
                            onChange={(e) =>
                              onModelOverride(id, 'contextWindow', Number.parseInt(e.target.value, 10) || 0)
                            }
                          />
                          <span className="pp-model-param-src" title="该值的来源（用户手改 > API 拉取 > 目录）">
                            {metaSource(provider, id, 'contextWindow')}
                          </span>
                        </label>
                        <label className="pp-model-param">
                          <span>最大输出</span>
                          <input
                            type="number"
                            min={0}
                            value={provider.modelOverrides?.[id]?.maxTokens ?? ''}
                            placeholder={String(modelMaxTokens(provider, id) || '不钳制')}
                            onChange={(e) => onModelOverride(id, 'maxTokens', Number.parseInt(e.target.value, 10) || 0)}
                          />
                          <span className="pp-model-param-src" title="该值的来源（用户手改 > API 拉取 > 目录）">
                            {metaSource(provider, id, 'maxTokens')}
                          </span>
                        </label>
                        {/* 视觉声明开关（B5 · D-8①）：覆盖开 = ['text','image']（附图
                         *  入口 + 请求期图投影放行）；关 = 清覆盖回落 API 拉取/目录声明。 */}
                        <span className="pp-model-param">
                          <span>视觉模型（图片输入）</span>
                          <button
                            type="button"
                            className={`sp-btn-sm${visionOn ? ' is-on' : ''}`}
                            title={
                              visionEffective && !visionOn
                                ? 'API 拉取/目录已声明视觉——覆盖开/关可强制改写（关 = 回落声明值）'
                                : '未声明视觉——自定义 vision 模型在此补声明（生效面：附图入口 + 请求期图投影 + 选择器「视」徽标）'
                            }
                            onClick={() => onModelVisionToggle(id, !visionOn)}
                          >
                            {visionOn ? '已声明' : visionEffective ? '随声明' : '未声明'}
                          </button>
                          <span className="pp-model-param-src">{metaSource(provider, id, 'input')}</span>
                        </span>
                        {/* 思考档位（2026-09-23 思考下沉）：per-model 覆盖——缺省 = 用
                         *  本家默认档位（下方「默认思考档位」控件）。档位表仍由该模型的
                         *  声明裁决（API 拉取 / 目录；无声明则只给协议安全的自动/关闭）。 */}
                        <label className="pp-model-param">
                          <span>思考档位</span>
                          <select
                            className="sp-select"
                            value={provider.modelOverrides?.[id]?.thinking ?? INHERIT_THINKING}
                            onChange={(e) =>
                              onModelThinking(
                                id,
                                e.target.value === INHERIT_THINKING ? undefined : (e.target.value as StoredThinking),
                              )
                            }
                          >
                            <option value={INHERIT_THINKING}>
                              随本家默认（{thinkingModeLabel(provider.thinking)}）
                            </option>
                            {modelThinkingOptions(provider, id).map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <span className="pp-model-param-src">
                            {provider.modelOverrides?.[id]?.thinking !== undefined ? '手动设置' : '默认'}
                          </span>
                        </label>
                        <span className="pp-model-params-hint">
                          留空 = 用 API 拉取/目录值（都没有则上下文按未知处理、输出不钳制）；视觉生效 = 覆盖 ?? API 拉取
                          ?? 目录；思考档位缺省 = 本家默认档位
                          {modelThinkingOptions(provider, id).length === 0 ? '（该模型未声明档位——只有自动/关闭）' : ''}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="pp-models-add">
            <input
              id="pd-models-input"
              className="sp-input"
              value={newModel}
              placeholder="输入模型 id 添加，如 deepseek-reasoner"
              autoComplete="off"
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitAdd();
                }
              }}
            />
            <button type="button" className="sp-btn-sm" onClick={submitAdd}>
              添加
            </button>
          </div>
          {fetchMsg && <div className="pp-f-hint">{fetchMsg}</div>}

          {/* ── 模型目录（折叠）：远端事实 = 最近一次拉取的全量快照；勾选写「可用模型」 ── */}
          <div className="pp-catalog">
            <button
              type="button"
              className="pp-catalog-head"
              aria-expanded={catalogOpen}
              onClick={() => setCatalogOpen((v) => !v)}
            >
              <span className="pp-catalog-caret" aria-hidden="true">
                {catalogOpen ? '▾' : '▸'}
              </span>
              <span className="pp-catalog-title">模型目录</span>
              <span className="pp-catalog-meta">{catalogMeta}</span>
              <span className="pp-spacer" />
              {catalogIds.length > 0 && <span className="pp-chip">{catalogIds.length} 个</span>}
            </button>
            {catalogOpen && (
              <div className="pp-catalog-body">
                {catalogIds.length === 0 ? (
                  <div className="pp-f-hint">
                    还没有目录快照——点上方「刷新目录」从该提供方 /models
                    拉取。拉取只把远端清单取回来（不改可用模型），要从里面挑模型用，点行上的「添加」。
                  </div>
                ) : (
                  <>
                    <div className="pp-catalog-tools">
                      <input
                        className="sp-input"
                        value={catalogQuery}
                        placeholder="搜索模型…"
                        aria-label="搜索模型目录"
                        onChange={(e) => setCatalogQuery(e.target.value)}
                      />
                      <button
                        type="button"
                        className="sp-btn-sm"
                        title="把目录里的模型全部加入可用模型"
                        onClick={() => onSetEnabledModels([...new Set([...models, ...catalogIds])])}
                      >
                        全部添加
                      </button>
                      <button
                        type="button"
                        className="sp-btn-sm"
                        title="把目录里的模型全部移出可用模型（手动添加的保留）"
                        onClick={() => onSetEnabledModels(models.filter((m) => !catalogIds.includes(m)))}
                      >
                        全部移除
                      </button>
                    </div>
                    <div className="pp-catalog-list">
                      {catalogRows.map((id) => {
                        const on = models.includes(id);
                        const win = modelContextWindow(provider, id, 0);
                        return (
                          <label key={id} className={`pp-catalog-row${on ? ' on' : ''}`} title={id}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => onSetEnabledModels(on ? models.filter((m) => m !== id) : [...models, id])}
                            />
                            <span className="pp-catalog-name">{modelDescriptor(provider, id)?.name ?? id}</span>
                            {modelInput(provider, id).includes('image') && (
                              <span className="pp-model-chip-vision" title="视觉模型（覆盖 / API 拉取 / 目录声明）">
                                视
                              </span>
                            )}
                            {win > 0 && <span className="pp-catalog-win">{Math.round(win / 1000)}k</span>}
                            {/* 动作名写在行上（2026-09-23 用户 UX 复盘：「拉取」与「添加」
                                是两个动作——这一步必须有明确动词，不是裸勾选框） */}
                            <span className={`pp-catalog-verb${on ? ' on' : ''}`}>{on ? '移除' : '添加'}</span>
                          </label>
                        );
                      })}
                      {catalogRows.length === 0 && <div className="pp-f-hint">无匹配模型「{catalogQuery}」</div>}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="pp-f-hint">
            创作坞模型下拉只列「可用模型」；「新会话默认」= 最近在创作坞选用的模型，自动跟从（不可在此改）。 目录 =
            该提供方 /models 的最近一次快照（只读）——点行上的「添加」才进可用模型，手动添加的不受目录变动影响。
          </div>
        </div>

        <div className="pp-field">
          <div className="pp-f-label-row">
            <label className="pp-f-label" htmlFor="pd-baseurl">
              Base URL
            </label>
            <button
              type="button"
              className="sp-btn-sm"
              title={isFactoryUrl ? '当前已是默认地址' : '恢复出厂默认地址'}
              disabled={isFactoryUrl}
              onClick={onResetBaseUrl}
            >
              ↺ 默认
            </button>
          </div>
          <input
            id="pd-baseurl"
            className="sp-input"
            value={provider.baseUrl}
            onChange={(e) => onFieldChange('baseUrl', e.target.value)}
            onBlur={(e) => {
              // 剥离非 ASCII（URL 只允许 ASCII）
              // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII 范围判定必需
              e.target.value = e.target.value.replace(/[^\x00-\x7F]/g, '');
            }}
            placeholder="https://…/v1"
            autoComplete="off"
          />
        </div>

        {/* 本家默认思考档位（2026-09-23 思考下沉）：作用于**没单独设置过档位**的
            模型；单个模型的档位在「可用模型 → 参数」里覆盖。 */}
        <div className="pp-field">
          <div className="pp-f-label-row">
            <label className="pp-f-label" htmlFor="pd-thinking">
              默认思考档位
            </label>
            <span className="pp-chip">未单独设置的模型用它</span>
          </div>
          <select
            id="pd-thinking"
            className="sp-select"
            value={provider.thinking || ''}
            onChange={(e) => onFieldChange('thinking', e.target.value)}
          >
            {thinkingModes.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {/* D4（2026-08-27）：遗留数字 thinking（如 "4000"）不在档位表内——
                原实现把它显示成「自动」，一旦 onChange 就静默写成 ''，历史预算
                无声丢失。现在给存量值加显式 option，改不改由用户定。 */}
            {provider.thinking && !thinkingModes.some((o) => o.value === (provider.thinking || '')) && (
              <option value={provider.thinking}>自定义 ({provider.thinking})</option>
            )}
          </select>
          <div className="pp-f-hint">{thinkingHint}</div>
        </div>
      </div>

      {/* 高级连接配置（2026-09-17）：请求头——网关怪癖的用户可编辑面
           （key 化 provider 名以在切行时重置编辑态） */}
      <ProviderAdvanced key={provider.name} provider={provider} onChange={onAdvancedChange} />

      {/* 配置文件（2026-09-24 配方改文件批）：provider 连接配置的**唯一权威**
           是一份 YAML——人和 agent 都能直接改它，改完约 1 秒热生效。
           这里只给路径、错误与两个入口（打开目录 / 重读），不再有导入导出动作。 */}
      <ProviderDocCard doc={doc} myName={provider.name} onOpenDir={onOpenDocDir} onReload={onReloadDoc} msg={docMsg} />

      <div className="pp-card">
        <div className="pp-card-hd">
          <span className="pp-card-title">诊断</span>
          <span className="pp-rule" />
        </div>
        <div className="pp-test-row">
          <button
            type="button"
            className={`pp-btn-test${test.phase === 'testing' ? ' testing' : ''}`}
            disabled={test.phase === 'testing'}
            onClick={onTest}
          >
            {test.phase === 'testing' ? <span className="pp-spin" /> : '⟳ '}测试连接
          </button>
          {testBlock}
        </div>
        <div className="pp-f-hint">
          发送一次最小请求（1 token），验证 Key / Base URL / 模型三者可用。结果按提供方保存。
        </div>
        {provider.lastTest && (
          <div className="pp-test-last">
            上次测试：
            {provider.lastTest.status === 'ok'
              ? `成功 · ${formatLatency(provider.lastTest.latencyMs)}`
              : `失败${provider.lastTest.message ? ` · ${provider.lastTest.message}` : ''}`}{' '}
            · {formatTestAt(provider.lastTest.at)}
          </div>
        )}
      </div>

      {canDelete && (
        <div className="pp-card pp-danger-card">
          <div className="pp-card-hd">
            <span className="pp-card-title">危险区</span>
            <span className="pp-rule" />
          </div>
          <button type="button" className="sp-btn-sm pp-btn-danger" onClick={onDelete}>
            删除提供方 {provider.name}…
          </button>
          <div className="pp-f-hint">删除后系统凭据一并移除（保存后生效），不可恢复。</div>
        </div>
      )}
    </section>
  );
}
