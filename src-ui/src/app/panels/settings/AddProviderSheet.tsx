// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 添加提供方弹层（两步式，2026-09-06 重做）：
//   第一步「连接配置」：名称/协议/Base URL/API Key——目录 chips 点击 = 预填表单
//     （name/kind/baseUrl 带出），不再一键直加（目录模型名可能 stale）；
//   第二步「可用模型」：点「拉取模型」从提供方 /models 拉真实列表（无 Key 也可
//     尝试——本地端点如 Ollama 无需鉴权；云端失败会如实报因），勾选「新会话默认」，
//     也可手动补一个模型 id（拉取失败/无 /models 端点的兜底）。
//   确认添加 → 一次性把 name/kind/key/baseUrl/models/model 交给父组件（即时落盘 +
//     settings-saved 热广播，新提供方模型立刻全会话可选）。
//
// 校验在本地完成，父组件只负责落 state + 持久化。
//
// 2026-08-29 frontend-overlay-a11y-plan 档位 A-1：Escape/遮罩点关/背景 inert 收编到
// Overlay 原语（统一语义），本件只保留焦点环。

import { useEffect, useId, useRef, useState } from 'react';
import { activeLlmAdapters } from '../../../composition/services';
import { createProvider } from '../../../provider';
import { CORE_PROTOCOLS, type Protocol } from '../../../provider/types';
import { findVendorTemplate, getVendorTemplateVendors } from '../../../provider/vendor-templates';
import { defaultBaseUrl, type ProviderId, type ProviderSettings, providerId } from '../../../settings';
import { mountDialogFocus } from '../../dialog-focus';
import { Overlay } from '../../overlay';
import { protocolLabel } from './protocol';

export interface AddProviderEntry {
  name: ProviderId;
  kind: Protocol;
  apiKey?: string;
  baseUrl?: string;
  /** 可用模型 id 列表（创作坞可选面）。 */
  models: string[];
  /** 新会话默认模型（必须是 models 之一或与 model 一致）。 */
  model: string;
  /** 登录方式（Phase 3D）：codex chip 预填 authMode='oauth'。 */
  authMode?: 'api-key' | 'oauth';
  /** authMode='oauth' 时的 Rust oauth provider id。 */
  oauthProvider?: string;
}

interface AddProviderSheetProps {
  open: boolean;
  existingNames: ProviderId[];
  onClose: () => void;
  /** 确认添加（父组件负责即时持久化 + settings-saved 广播）。 */
  onAdd: (entry: AddProviderEntry) => void;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 空 ProviderSettings 行（用于构建临时 provider 调 /models）。 */
function buildRow(name: string, kind: Protocol, baseUrl: string, apiKey: string): ProviderSettings {
  return {
    kind,
    name: providerId(name),
    apiKey,
    baseUrl,
    model: '',
  };
}

export function AddProviderSheet({ open, existingNames, onClose, onAdd }: AddProviderSheetProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Protocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [manualModel, setManualModel] = useState('');
  // 拉取状态面
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState('');
  const [pulled, setPulled] = useState(false);
  const [error, setError] = useState('');
  // Phase 3D：登录方式（模板预填；codex = oauth 订阅）
  const [authMode, setAuthMode] = useState<'api-key' | 'oauth'>('api-key');
  const [oauthProvider, setOauthProvider] = useState<string | undefined>(undefined);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  /** oauth 订阅行：无 API Key / 无 /models 可拉——表单形态与 api-key 两轨。 */
  const isOAuth = authMode === 'oauth';

  // 协议下拉选项：内核白名单（出厂两族）恒在、顺序在前；ctx.llm adapter 注册表
  // 贡献的其余协议并入（开放协议，按 kind 去重——adapter 的 label 作展示，缺省
  // 回落 kind 本身）。运行时取：装载前（无服务）= 只有内核两族。每次渲染快照
  // 注册表（模块态非响应，开销极小——协议选项个位数）。
  const protocolOptions = (() => {
    const seen = new Set<Protocol>(CORE_PROTOCOLS);
    const opts: Array<{ value: Protocol; label: string }> = [...CORE_PROTOCOLS].map((k) => ({
      value: k,
      label: protocolLabel(k),
    }));
    for (const a of activeLlmAdapters()) {
      if (seen.has(a.kind)) continue;
      seen.add(a.kind);
      opts.push({ value: a.kind, label: protocolLabel(a.kind, a.label) });
    }
    return opts;
  })();

  useEffect(() => {
    if (open) {
      setName('');
      setKind('openai');
      setBaseUrl('');
      setKey('');
      setModels([]);
      setDefaultModel('');
      setManualModel('');
      setFetching(false);
      setFetchMsg('');
      setPulled(false);
      setError('');
      setAuthMode('api-key');
      setOauthProvider(undefined);
    }
  }, [open]);

  // 焦点圈定 + 打开即聚焦名称输入（键盘用户主路径）+ 关闭归还焦点
  // （2026-08-29 走查：此前 Tab 可逃逸弹层、关闭焦点落 body）
  useEffect(() => {
    if (!open || !sheetRef.current) return;
    return mountDialogFocus(sheetRef.current, { initial: nameInputRef.current });
  }, [open]);

  /** 厂商 chip → 预填连接表单（不直加——进入拉模型两步）。
   *  来源 = 模板表（vendor-templates.ts 连接参数；模型一律运行时拉取）。
   *  ⚡ oauth 厂商（authMode='oauth'）：无 /models 可拉（订阅端点），模型由
   *  模板 defaultModel 固定——点选即把默认模型写入可用列表，表单免拉取直添
   *  （登录在添加成功后的 Detail 面板完成）。 */
  const handlePickVendor = (provName: string) => {
    const tpl = findVendorTemplate(provName);
    if (!tpl) return;
    setName(provName);
    setKind(tpl.kind);
    setBaseUrl(tpl.baseUrl);
    setKey('');
    setPulled(false);
    setFetchMsg('');
    setError('');
    setManualModel('');
    // authMode/oauthProvider 随模板预填（codex = oauth）
    setAuthMode(tpl.authMode ?? 'api-key');
    setOauthProvider(tpl.oauthProvider);
    if (tpl.authMode === 'oauth') {
      // oauth 订阅：模板 defaultModel = 可用模型（无 /models 可拉）
      const seed = tpl.defaultModel?.trim() ? [tpl.defaultModel.trim()] : [];
      setModels(seed);
      setDefaultModel(seed[0] ?? '');
    } else {
      setModels([]);
      setDefaultModel('');
    }
  };

  /** 从已填连接拉取 /models（无 Key 也尝试——本地端点无鉴权）。 */
  const handleFetch = async () => {
    const n = name.trim();
    if (!n || existingNames.includes(n)) return;
    setError('');
    setFetching(true);
    setFetchMsg('');
    try {
      const prov = createProvider(buildRow(n, kind, baseUrl.trim() || defaultBaseUrl(n, kind) || '', key.trim()));
      const found = (await prov.fetchModels?.()) ?? [];
      const ids = found.map((m) => m.id).filter(Boolean);
      setModels(ids);
      setPulled(true);
      if (ids.length > 0) setDefaultModel(ids[0]);
      setFetchMsg(ids.length > 0 ? `已拉取 ${ids.length} 个模型` : '该端点未返回模型——可手动输入模型 id');
    } catch (e) {
      // 拉取失败不阻断：如实提示，仍可手动补模型（错误不静默）
      setPulled(true);
      setFetchMsg(`拉取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetching(false);
    }
  };

  /** 手动补充模型 id（拉取失败/端点无 /models 的兜底）。 */
  const submitManual = () => {
    const id = manualModel.trim();
    if (!id) return;
    setModels((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setDefaultModel((prev) => prev || id);
    setManualModel('');
    setPulled(true);
  };

  const handleConfirm = () => {
    const n = name.trim();
    if (!n) {
      setError('名称不能为空');
      nameInputRef.current?.focus();
      return;
    }
    if (!NAME_RE.test(n)) {
      setError('名称只能包含字母、数字、下划线和连字符（中文名暂不支持，可用拼音）');
      nameInputRef.current?.focus();
      return;
    }
    if (existingNames.includes(n)) {
      setError(`Provider「${n}」已存在`);
      nameInputRef.current?.focus();
      return;
    }
    // oauth 订阅：模板默认模型即可用列表（登录在 Detail 面板完成，不在此拉取）
    if (authMode === 'oauth') {
      const ids = [...new Set(models.filter((m) => m?.trim()))];
      if (ids.length === 0) {
        setError('该订阅没有默认模型——请先在连接配置里确认');
        return;
      }
      const def = defaultModel.trim() || ids[0];
      onAdd({
        name: providerId(n),
        kind,
        apiKey: undefined, // oauth 无 API Key——凭据 = 系统 OAuth grant
        baseUrl: baseUrl.trim() || undefined,
        models: ids,
        model: def,
        authMode,
        oauthProvider,
      });
      return;
    }
    const ids = [...new Set(models.filter((m) => m?.trim()))];
    if (ids.length === 0) {
      setError('还没有可用模型——点「拉取模型」或手动补一个模型 id');
      modelInputRef.current?.focus();
      return;
    }
    const def = defaultModel.trim() || ids[0];
    onAdd({
      name: providerId(n),
      kind,
      apiKey: key.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      models: ids,
      model: def,
      authMode,
      oauthProvider,
    });
  };

  const hasValidName = name.trim() && !existingNames.includes(name.trim());

  return (
    <Overlay open={open} onClose={onClose} className="cd-overlay" inertBackground>
      <div ref={sheetRef} className="cd-sheet pp-add-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="cd-hd">
          <span id={titleId} className="cd-title">
            添加提供方
          </span>
          <button type="button" className="cd-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        <div className="pp-sheet-note">
          选择厂商预填连接（或手动配置）→ 拉取该提供方的真实模型 → 选定新会话默认 → 添加即生效。
        </div>

        <div className="pp-cat-grid">
          {getVendorTemplateVendors().map((provName) => {
            const tpl = findVendorTemplate(provName);
            if (!tpl) return null;
            const used = existingNames.includes(provName);
            return (
              <button
                type="button"
                key={provName}
                className={`pp-cat-chip${used ? ' used' : ''}${name === provName ? ' selected' : ''}`}
                title={used ? `${provName} 已存在` : `预填 ${tpl.baseUrl}`}
                disabled={used}
                onClick={() => handlePickVendor(provName)}
              >
                <div className="pp-cat-name">{tpl.label ?? provName}</div>
                <div className="pp-cat-model">{tpl.baseUrl}</div>
                <div className="pp-cat-kind">{protocolLabel(tpl.kind)}</div>
              </button>
            );
          })}
        </div>

        <div className="pp-sheet-divider">
          <span>连接配置</span>
        </div>

        <div className="pp-form-grid">
          <div className="pp-fg">
            <label htmlFor="aps-name">名称（唯一标识，创建后不可修改）</label>
            <input
              id="aps-name"
              ref={nameInputRef}
              className="sp-input"
              value={name}
              aria-invalid={error !== ''}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError('');
                // 改名后拉取结果作废
                if (pulled) {
                  setPulled(false);
                  setModels([]);
                  setDefaultModel('');
                  setFetchMsg('');
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleFetch();
                }
              }}
              placeholder="如 my-gateway"
              autoComplete="off"
            />
          </div>
          <div className="pp-fg">
            <label htmlFor="aps-kind">协议</label>
            <select
              id="aps-kind"
              className="sp-select"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                if (pulled) {
                  setPulled(false);
                  setModels([]);
                  setDefaultModel('');
                  setFetchMsg('');
                }
              }}
            >
              {/* 协议下拉选项 = 内核白名单 + ctx.llm adapter 贡献（开放协议，
               *  如 Responses——Phase 2 起注册后自动入列）。 */}
              {protocolOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="pp-fg">
            <label htmlFor="aps-baseurl">Base URL</label>
            <input
              id="aps-baseurl"
              className="sp-input"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                if (pulled) {
                  setPulled(false);
                  setModels([]);
                  setDefaultModel('');
                  setFetchMsg('');
                }
              }}
              placeholder="https://…/v1（留空用厂商默认）"
              autoComplete="off"
            />
          </div>
          {!isOAuth && (
            <div className="pp-fg">
              <label htmlFor="aps-key">API Key（可选——本地端点无需）</label>
              <input
                id="aps-key"
                type="password"
                className="sp-input"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  if (pulled) {
                    setPulled(false);
                    setModels([]);
                    setDefaultModel('');
                    setFetchMsg('');
                  }
                }}
                placeholder="sk-…"
                autoComplete="off"
              />
            </div>
          )}
          {isOAuth && (
            <div className="pp-fg">
              <span className="pp-f-label">登录方式</span>
              <div className="pp-f-hint">OAuth 订阅——确认添加后进入「提供方」详情完成浏览器授权登录。</div>
            </div>
          )}
        </div>

        {isOAuth ? (
          /* oauth 订阅无 /models 端点——不提供拉取，模型由模板固定 */
          <div className="pp-add-pull-row">
            <span className="pp-add-pull-msg">该订阅的可用模型由账号自动提供，无需拉取。</span>
          </div>
        ) : (
          <div className="pp-add-pull-row">
            <button
              type="button"
              className="sp-btn-sm"
              disabled={fetching || !hasValidName}
              onClick={handleFetch}
              title={!hasValidName ? '先填名称（唯一且不重复）' : '从该提供方 /models 端点拉取可用模型'}
            >
              {fetching ? '拉取中…' : '从 API 拉取模型'}
            </button>
            {fetchMsg && (
              <span className={`pp-add-pull-msg${fetchMsg.startsWith('拉取失败') ? ' fail' : ''}`}>{fetchMsg}</span>
            )}
          </div>
        )}

        <div className="pp-sheet-divider">
          <span>可用模型</span>
        </div>

        {isOAuth ? (
          /* oauth 订阅：模型由模板固定（单条只读展示，无交互），无拉取/手动补 */
          <div className="pp-pick-models">
            {models.map((id) => (
              <div key={id} className="pp-pick-model selected" title={id}>
                <span className="pp-pick-model-id">{id}</span>
                <span className="pp-model-chip-default">默认</span>
              </div>
            ))}
          </div>
        ) : models.length > 0 ? (
          <div className="pp-pick-models" role="listbox" aria-label="可用模型">
            {models.map((id) => (
              <button
                type="button"
                key={id}
                role="option"
                aria-selected={defaultModel === id}
                className={`pp-pick-model${defaultModel === id ? ' selected' : ''}`}
                title={id}
                onClick={() => setDefaultModel(id)}
              >
                <span className="pp-pick-model-id">{id}</span>
                {defaultModel === id && <span className="pp-model-chip-default">新会话默认</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="pp-f-hint">还没有模型——点上方「从 API 拉取模型」，或在下方手动补一个模型 id。</div>
        )}

        {!isOAuth && (
          <div className="pp-models-add">
            <input
              className="sp-input"
              ref={modelInputRef}
              value={manualModel}
              placeholder="手动补模型 id，如 deepseek-reasoner"
              autoComplete="off"
              aria-label="手动补模型 id"
              onChange={(e) => setManualModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitManual();
                }
              }}
            />
            <button type="button" className="sp-btn-sm" onClick={submitManual}>
              添加
            </button>
          </div>
        )}

        {error && <div className="pp-form-error">{error}</div>}

        <div className="cd-actions">
          <button type="button" className="sp-btn sp-btn-cancel" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sp-btn sp-btn-save" onClick={handleConfirm}>
            确认添加
          </button>
        </div>
      </div>
    </Overlay>
  );
}
