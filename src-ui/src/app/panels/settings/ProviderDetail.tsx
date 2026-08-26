// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页右侧「调谐控制台」：编辑选中提供方的连接配置 / 诊断 / 危险区。
// 状态展示与测试结果均按 provider 独立，切换提供方不会串台。

import type React from 'react';
import { useCallback, useState } from 'react';
import { getModel } from '../../../provider/catalog';
import { type StoredThinking, thinkingOptionsFor } from '../../../provider/thinking';
import type { Protocol } from '../../../provider/types';
import {
  type ConnectionProbe,
  effectiveModels,
  isFactoryBaseUrl,
  type ModelOverrides,
  type ProbeOutcome,
} from '../../../settings';
import { protocolLabel } from './protocol';
import { formatLatency, formatTestAt, providerStatus, STATUS_LABEL } from './status';

export type ProviderField = 'apiKey' | 'baseUrl' | 'model' | 'thinking';

/** 连接探针的 UI 阶段（瞬时态，不持久化）；结果本体见 ConnectionProbe。 */
export type ProbeUiPhase = 'idle' | 'testing' | ProbeOutcome;

export interface ProbeUiState {
  phase: ProbeUiPhase;
  msg: string;
}

interface ProviderDetailProps {
  provider: {
    name: string;
    kind: Protocol;
    apiKey: string;
    baseUrl: string;
    model: string;
    thinking?: StoredThinking;
    lastTest?: ConnectionProbe;
    /** per-model 覆盖（上下文窗口 / 最大输出）；0/缺省 = 用目录值。 */
    modelOverrides?: Record<string, ModelOverrides>;
    /** 该提供方「可用模型」id 列表（创作坞下拉的可选面；缺省 = [model]）。 */
    models?: string[];
  };
  isCurrent: boolean;
  canDelete: boolean;
  test: ProbeUiState;
  /** Key 栏 UI 状态簇：已保存 / 清除暂存 / 明文可见 / 输入框引用 */
  keyState: KeyUiState;
  /** 控制台全部回调簇 */
  actions: ProviderDetailActions;
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
  onTest: () => void;
  onSetCurrent: () => void;
  onClearKey: () => void;
  onResetBaseUrl: () => void;
  onToggleKeyVisible: () => void;
  onDelete: () => void;
}

export function ProviderDetail({ provider, isCurrent, canDelete, test, keyState, actions }: ProviderDetailProps) {
  const { saved: keySaved, pendingClear, visible: keyVisible, inputRef: keyInputRef } = keyState;
  const {
    onFieldChange,
    onFetchModels,
    onAddModel,
    onRemoveModel,
    onModelOverride,
    onTest,
    onSetCurrent,
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
  const st = providerStatus(provider);
  const statusCls = test.phase === 'testing' ? 'testing' : st;
  const statusLabel = test.phase === 'testing' ? '测试中…' : STATUS_LABEL[st];
  // P14 能力协商：档位表来自当前模型的目录声明（thinkingEfforts/thinkingOff），
  // 目录外模型 = 无声明 = 不显示选择器（思考走模型默认，无法控制），不编造档位。
  const modelDesc = getModel(provider.model);
  const thinkingModes = thinkingOptionsFor(modelDesc);
  const thinkingHint =
    thinkingModes.length > 0
      ? '档位由该模型的目录声明提供；目录外的档位不可选（不会静默替换为其他档位）。'
      : '该模型暂无思考档位数据（目录外或厂商未披露）——思考行为由模型默认决定，无法在此控制。';
  const isFactoryUrl = isFactoryBaseUrl(provider.baseUrl);

  const keyChip = provider.apiKey?.trim()
    ? keySaved
      ? '已保存到系统凭据'
      : '未保存 · 保存后写入'
    : pendingClear
      ? '清除待保存生效'
      : '未设置';
  const keyChipCls = provider.apiKey?.trim() ? (keySaved ? '' : ' unsaved') : ' clear';

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
        {isCurrent && <span className="pp-badge pp-badge-current">当前使用</span>}
        <span className="pp-spacer" />
        <button
          type="button"
          className="pp-btn-set-current"
          disabled={isCurrent}
          title={isCurrent ? '该提供方正在被 Agent 使用' : '切换为当前使用中的 Provider'}
          onClick={onSetCurrent}
        >
          {isCurrent ? '已在用' : '设为当前'}
        </button>
      </div>

      <div className="pp-card">
        <div className="pp-card-hd">
          <span className="pp-card-title">连接配置</span>
          <span className="pp-rule" />
        </div>

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

        {/* 可用模型 = 唯一的模型配置面（2026-08-26）：创作坞下拉的可选列表 + 新会话
            默认（= 最近使用，自动跟从创作坞切换，不在此手动选「默认模型」） */}
        <div className="pp-field">
          <div className="pp-f-label-row">
            <label className="pp-f-label" htmlFor="pd-models-input">
              可用模型
            </label>
            <span className="pp-chip">{models.length} 个</span>
            <button type="button" className="sp-btn-sm" disabled={fetching} onClick={handleFetch}>
              {fetching ? '拉取中…' : '从 API 拉取'}
            </button>
          </div>
          {models.length > 0 && (
            <div className="pp-models-list">
              {models.map((id) => (
                <div key={id} className="pp-model-item">
                  <span className={`pp-model-chip${id === provider.model ? ' is-default' : ''}`} title={id}>
                    <span className="pp-model-chip-name">{getModel(id)?.name ?? id}</span>
                    {id === provider.model && <span className="pp-model-chip-default">新会话默认</span>}
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
                          placeholder={String(getModel(id)?.contextWindow || 200000)}
                          onChange={(e) =>
                            onModelOverride(id, 'contextWindow', Number.parseInt(e.target.value, 10) || 0)
                          }
                        />
                      </label>
                      <label className="pp-model-param">
                        <span>最大输出</span>
                        <input
                          type="number"
                          min={0}
                          value={provider.modelOverrides?.[id]?.maxTokens ?? ''}
                          placeholder={String(getModel(id)?.maxTokens || 0)}
                          onChange={(e) => onModelOverride(id, 'maxTokens', Number.parseInt(e.target.value, 10) || 0)}
                        />
                      </label>
                      <span className="pp-model-params-hint">
                        留空 = 用目录值（自定义模型目录无值则上下文 200K / 输出不钳制）
                      </span>
                    </div>
                  )}
                </div>
              ))}
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
            创作坞模型下拉只列这里的模型；旧数据自动视为「默认模型」一个。从 API 拉取会替换整个列表。
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
