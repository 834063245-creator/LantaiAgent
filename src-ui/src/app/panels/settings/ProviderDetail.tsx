// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页右侧「调谐控制台」：编辑选中提供方的连接配置 / 诊断 / 危险区。
// 状态展示与测试结果均按 provider 独立，切换提供方不会串台。

import type React from 'react';
import { useCallback, useState } from 'react';
import { getModel } from '../../../provider/catalog';
import { thinkingOptionsFor } from '../../../provider/thinking';
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
import { protocolLabel } from './protocol';
import { formatLatency, formatTestAt, providerStatus, STATUS_LABEL } from './status';

export type ProviderField = 'apiKey' | 'baseUrl' | 'model' | 'thinking';

/** per-model 参数的来源标注字段（provider-model-meta 四层链的展示面）。 */
type MetaField = 'contextWindow' | 'maxTokens' | 'input';

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
  /** per-model 覆盖（P14）：上下文窗口 / 最大输出，0 = 清回目录值。 */
  onModelOverride: (modelId: string, field: 'contextWindow' | 'maxTokens', value: number) => void;
  /** 视觉声明覆盖（B5 · D-8①）：on = ['text','image'] 强制开；off = 清覆盖回落目录。 */
  onModelVisionToggle: (modelId: string, on: boolean) => void;
  onTest: () => void;
  onClearKey: () => void;
  onResetBaseUrl: () => void;
  onToggleKeyVisible: () => void;
  onDelete: () => void;
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
    onModelOverride,
    onModelVisionToggle,
    onTest,
    onClearKey,
    onResetBaseUrl,
    onToggleKeyVisible,
    onDelete,
  } = actions;
  // ── 「可用模型」列表编辑器本地态（瞬时 UI，不持久化）──
  const models = effectiveModels(provider);
  const [newModel, setNewModel] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState('');
  // per-model 参数展开（参数编辑器作用到哪个模型）
  const [paramModel, setParamModel] = useState<string | null>(null);
  const handleFetch = useCallback(async () => {
    if (fetching) return;
    setFetching(true);
    setFetchMsg('');
    try {
      const count = await onFetchModels();
      setFetchMsg(count > 0 ? `已拉取 ${count} 个模型` : '未获取到模型');
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
  // P14 能力协商：档位表来自当前模型的**生效描述符**（provider 作用域合并链 =
  // 用户覆盖 + API 拉取元数据 + 目录 seed）——网关模型若在拉取时拿到档位声明
  // 同样生效；皆无 = 不显示选择器（思考走模型默认，无法控制），不编造档位。
  const modelDesc = modelDescriptor(provider, provider.model);
  const thinkingModes = thinkingOptionsFor(modelDesc);
  const thinkingHint =
    thinkingModes.length > 0
      ? '档位由该模型的声明提供（API 拉取或目录）；声明外的档位不可选（不会静默替换为其他档位）。'
      : '该模型暂无思考档位数据（端点未披露且目录外）——思考行为由模型默认决定，无法在此控制。';
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

        {/* 可用模型 = 唯一的模型配置面（2026-08-26）：创作坞下拉的可选列表 + 新会话
            默认（= 最近使用，自动跟从创作坞切换，不在此手动选「默认模型」） */}
        <div className="pp-field">
          <div className="pp-f-label-row">
            <label className="pp-f-label" htmlFor="pd-models-input">
              可用模型
            </label>
            <span className="pp-chip">{models.length} 个</span>
            {/* oauth 订阅（Codex）：登录后也可从账号 API 拉取真实模型——非「账号自动提供」 */}
            <button type="button" className="sp-btn-sm" disabled={fetching} onClick={handleFetch}>
              {fetching ? '拉取中…' : '从 API 拉取'}
            </button>
          </div>
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
                        <span className="pp-model-params-hint">
                          留空 = 用 API 拉取/目录值（都没有则上下文按未知处理、输出不钳制）；视觉生效 = 覆盖 ?? API 拉取
                          ?? 目录
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
          <div className="pp-f-hint">
            创作坞模型下拉只列这里的模型；「新会话默认」= 最近在创作坞选用的模型，自动跟从（不可在此改）。从 API
            拉取会并入新模型，手动添加的保留。
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

        {thinkingModes.length > 0 && (
          <div className="pp-field">
            <div className="pp-f-label-row">
              <label className="pp-f-label" htmlFor="pd-thinking">
                思考努力等级
              </label>
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
        )}
      </div>

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
