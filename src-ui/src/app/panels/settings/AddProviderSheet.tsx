// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 添加提供方弹层（两步式，2026-09-06 重做；OAuth 内联登录 2026-09-11；
//   目录/启用分层 2026-09-23）：
//   第一步「连接配置」：名称/协议/Base URL/API Key——目录 chips 点击 = 预填表单
//     （name/kind/baseUrl 带出），不再一键直加（目录模型名可能 stale）；
//   第二步「可用模型」：点「从 API 拉取模型」从提供方 /models 拉真实列表（无 Key
//     也可尝试——本地端点如 Ollama 无需鉴权；云端失败会如实报因），拉到的 id 进
//     **目录**并默认全勾（本弹层是从零建行，全勾=最小惊讶），用户可逐条取消/全选/
//     清空，勾上的才是「可用模型」（进创作坞下拉）；每行可点「设为默认」，也可手动
//     补一个模型 id（拉取失败/无 /models 端点的兜底）。
//   确认添加 → 一次性把 name/kind/key/baseUrl/models(启用)/catalog(目录)/model
//     交给父组件（即时落盘 + settings-saved 热广播，新提供方模型立刻全会话可选）。
//
//   ⚡ 2026-09-23（用户实测报告「拉过来就全在列表里，从没让我挑」）：拉取 = 刷目录，
//     不再等于配置；与详情页同一套三层语义（目录 / 启用 / 选中）。
//
//   OAuth 订阅（authMode='oauth'，codex 等）走弹层内登录（2026-09-11 重做）：
//     以前「确认添加 → 建行 → 再进详情页登录」两步割裂；现在登录直接发生在
//     添加弹层——选厂商 → 弹层内 device-flow 授权 → 登录后拉真实模型 → 确认添加
//     一次完成。grant 键 oauth:{provider}::{account} 与 provider 行解耦，弹层内
//     登录对尚未建的行同样成立（OAuth 登录不必等到行存在）。
//
// 校验在本地完成，父组件只负责落 state + 持久化。
//
// 2026-08-29 frontend-overlay-a11y-plan 档位 A-1：Escape/遮罩点关/背景 inert 收编到
// Overlay 原语（统一语义），本件只保留焦点环。

import { useEffect, useId, useRef, useState } from 'react';
import { activeLlmAdapters } from '../../../composition/services';
import { createProvider } from '../../../provider';
import { invalidateOauthCache, resolveOauthToken } from '../../../provider/credentials';
import type { ModelMeta } from '../../../provider/model-meta';
import { buildOauthHeaders, oauthAccounts, oauthLogout, runDeviceLogin } from '../../../provider/oauth';
import type { ModelDescriptor, Provider } from '../../../provider/types';
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
  /** 可用模型 id 列表（= 勾选启用的那些；创作坞下拉可选面）。 */
  models: string[];
  /** 模型目录快照（拉取到的全量 id）——详情页据此可继续勾选，不必重拉。 */
  catalog?: string[];
  /** 新会话默认模型（必须是 models 之一或与 model 一致）。 */
  model: string;
  /** API 拉取到的 per-model 元数据（provider-model-meta，2026-09-11）——拉取时
   *  由方言的宽容解析层产出（窗口/输出上限/视觉/推理），随添加一次性落盘到
   *  ProviderSettings.modelMeta。未拉取或端点未披露 = 缺省（不编造）。 */
  modelMeta?: Record<string, ModelMeta>;
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

/** OAuth 已登录账号清单（元数据只读面）。 */
interface OAuthAccount {
  accountId: string;
}

export function AddProviderSheet({ open, existingNames, onClose, onAdd }: AddProviderSheetProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Protocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  /** 勾选启用的模型（models 的真子集）——「可用模型」= 它，不再是目录全量。
   *  本弹层是从零建行：拉取后默认全勾（否则建出行却没有模型可用），用户可取消。 */
  const [enabled, setEnabled] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [manualModel, setManualModel] = useState('');
  // API 拉取到的 per-model 元数据（provider-model-meta）：随确认添加落盘到
  // ProviderSettings.modelMeta——新行出生即带窗口/视觉/推理，不必再回设置页拉一次。
  const [pulledMeta, setPulledMeta] = useState<Record<string, ModelMeta>>({});
  // 拉取状态面
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState('');
  const [pulled, setPulled] = useState(false);
  const [error, setError] = useState('');
  // Phase 3D：登录方式（模板预填；codex = oauth 订阅）
  const [authMode, setAuthMode] = useState<'api-key' | 'oauth'>('api-key');
  const [oauthProvider, setOauthProvider] = useState<string | undefined>(undefined);
  // OAuth 弹层内登录态（2026-09-11 重做）：登录直接发生在添加弹层——
  // 不再「添加完再去详情页登录」。已登录账号在此展示，可换/可登出。
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<{ tone: 'info' | 'ok' | 'fail'; msg: string } | null>(null);
  const [oauthAccountsState, setOauthAccountsState] = useState<OAuthAccount[]>([]);
  const oauthCancelRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  /** oauth 订阅行：无 API Key / 登录走 device-flow——表单形态与 api-key 两轨。 */
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
      setEnabled([]);
      setDefaultModel('');
      setManualModel('');
      setPulledMeta({});
      setFetching(false);
      setFetchMsg('');
      setPulled(false);
      setError('');
      setAuthMode('api-key');
      setOauthProvider(undefined);
      // OAuth 弹层态复位：清登录/账号展示（重新打开 = 从头选厂商）
      setOauthBusy(false);
      setOauthStatus(null);
      setOauthAccountsState([]);
      oauthCancelRef.current = false;
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
   *  ⚡ oauth 厂商（authMode='oauth'）：模型来自登录后账号 API（本弹层内
   *  先登录再拉取）；登录完成前不提供「添加」（行未配好就建会割裂）。 */
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
    setModels([]);
    setEnabled([]);
    setDefaultModel('');
    // authMode/oauthProvider 随模板预填（codex = oauth）
    setAuthMode(tpl.authMode ?? 'api-key');
    setOauthProvider(tpl.oauthProvider);
    if (tpl.authMode === 'oauth' && tpl.oauthProvider) {
      // 打开即拉一次该 provider 已登录账号（grant 与行解耦——可能已有账号）
      void refreshOauthAccounts(tpl.oauthProvider);
    }
  };

  /** 拉某 oauth provider 的已登录账号清单（弹层内展示）。 */
  const refreshOauthAccounts = async (pid: string) => {
    try {
      const accts = await oauthAccounts(pid);
      setOauthAccountsState(accts.map((a) => ({ accountId: a.account_id })));
    } catch {
      setOauthAccountsState([]);
    }
  };

  /** OAuth device-flow 登录（弹层内发起——不再等建行后去详情页）。
   *  成功后刷新账号清单 + 失效凭据缓存；登录成功不自动建行——
   *  用户仍可选「拉取模型」/直接确认。 */
  const handleOauthLogin = async () => {
    const pid = oauthProvider;
    if (!pid) return;
    setOauthBusy(true);
    oauthCancelRef.current = false;
    setOauthStatus({ tone: 'info', msg: '正在获取设备授权码…' });
    try {
      await runDeviceLogin(
        pid,
        {
          onAwaitingUser: (flow) => {
            setOauthStatus({
              tone: 'info',
              msg: `请在浏览器打开授权页并输入代码 ${flow.user_code}：${flow.verification_uri}`,
            });
          },
          onGranted: async () => {
            invalidateOauthCache(pid);
            await refreshOauthAccounts(pid);
            // 起步给模板默认模型作 seed（可被「从账号拉取模型」并入/替换——真实
            // 可用面以账号 API 为准；无 seed 则留给用户拉取/手动补）。
            const tpl = findVendorTemplate(name.trim());
            const seed = tpl?.defaultModel?.trim();
            setModels((prev) => (seed && !prev.includes(seed) ? (prev.length === 0 ? [seed] : [...prev, seed]) : prev));
            // seed 同时勾上（否则「确认添加」会因启用集空而被拦——seed 就是本行的默认模型）
            setEnabled((prev) => (seed && !prev.includes(seed) ? [...prev, seed] : prev));
            setDefaultModel((prev) => prev || seed || '');
            setOauthStatus({
              tone: 'ok',
              msg: seed
                ? `登录成功——已带出默认模型 ${seed}，可「从账号拉取模型」获取完整列表`
                : '登录成功——请拉取该账号的可用模型',
            });
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
  };

  /** 取消进行中的 device-flow。 */
  const handleOauthCancel = () => {
    oauthCancelRef.current = true;
    setOauthStatus({ tone: 'info', msg: '正在取消登录…' });
  };

  /** 登出弹层内展示的某账号（不清空已拉 models——模型列表与账号解耦展示）。 */
  const handleOauthLogout = async (accountId: string) => {
    const pid = oauthProvider;
    if (!pid) return;
    try {
      await oauthLogout(pid, accountId);
      invalidateOauthCache(pid);
      await refreshOauthAccounts(pid);
      setOauthStatus({ tone: 'ok', msg: `已登出账号 ${accountId}` });
    } catch (e) {
      setOauthStatus({ tone: 'fail', msg: `登出失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  /** oauth 订阅登录后拉真实模型：live provider（带 oauth grant 注入头）拉 /models。
   *  失败如实上抛——模型不靠「账号自动提供」的假话，靠真实拉取。 */
  const handleOauthFetchModels = async () => {
    const n = name.trim();
    const pid = oauthProvider;
    if (!n || !pid) return;
    setError('');
    setFetching(true);
    setFetchMsg('');
    try {
      // 登录后 grant 已存在——live provider 解析 oauth 注入头拉 /models
      const prov = await buildOauthModelProvider(n, pid, kind, baseUrl.trim());
      const found: ModelDescriptor[] = (await prov.fetchModels?.()) ?? [];
      const ids = found.map((m) => m.id).filter(Boolean);
      const merged = [...ids, ...models.filter((m) => !ids.includes(m))];
      setModels(merged);
      // 目录/启用分层：新拉到的 id 默认勾上（本弹层从零建行；用户可逐条取消）
      setEnabled((prev) => [...new Set([...prev, ...ids])]);
      setPulledMeta((prev) => ({ ...prev, ...(prov.lastModelMeta?.() ?? {}) }));
      setPulled(true);
      if (merged.length > 0 && !defaultModel) setDefaultModel(merged[0]);
      setFetchMsg(ids.length > 0 ? `已拉取 ${ids.length} 个模型` : '该端点未返回模型——可手动补模型 id');
    } catch (e) {
      // 拉取失败不阻断：如实提示，仍可手动补模型（错误不静默）
      setPulled(true);
      setFetchMsg(`拉取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setFetching(false);
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
      setEnabled(ids); // 新拉取 = 新目录 → 默认全勾（用户随即可取消/全选/清空）
      // 元数据（端点披露多少收多少）——确认添加时随行落盘
      setPulledMeta((prev) => ({ ...prev, ...(prov.lastModelMeta?.() ?? {}) }));
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

  /** 手动补充模型 id（拉取失败/端点无 /models 的兜底）——直接进目录并勾上。 */
  const submitManual = () => {
    const id = manualModel.trim();
    if (!id) return;
    setModels((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setEnabled((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setDefaultModel((prev) => prev || id);
    setManualModel('');
    setPulled(true);
  };

  /** 勾选/取消一个模型（= 写启用集）。取消的正是「新会话默认」时顶第一个可用项
   *  （否则默认模型落在启用集外，创作坞触发器会显示一个不在下拉里的模型）。 */
  const toggleEnabled = (id: string) => {
    setEnabled((prev) => {
      const on = prev.includes(id);
      const next = on ? prev.filter((m) => m !== id) : [...prev, id];
      if (on) setDefaultModel((cur) => (cur === id ? (next[0] ?? '') : cur));
      else setDefaultModel((cur) => cur || id);
      return next;
    });
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
    // oauth 订阅：无 API Key 可用——确认添加前必须已登录（登录就在本弹层内完成，
    // 否则会出现「建了行却没登录、还得去详情页补」的割裂。登录完才算配好）。
    if (authMode === 'oauth' && oauthAccountsState.length === 0) {
      setError('OAuth 订阅还没登录——请先在上方完成浏览器授权登录，再确认添加');
      return;
    }
    const ids = [...new Set(enabled.filter((m) => m?.trim()))];
    if (ids.length === 0) {
      setError('还没有可用模型——先登录（OAuth）/拉取模型并在列表里勾选，或手动补一个模型 id');
      modelInputRef.current?.focus();
      return;
    }
    const def = defaultModel.trim() && ids.includes(defaultModel.trim()) ? defaultModel.trim() : ids[0];
    const catalog = [...new Set(models.filter((m) => m?.trim()))];
    onAdd({
      name: providerId(n),
      kind,
      apiKey: authMode === 'oauth' ? undefined : key.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      models: ids,
      ...(catalog.length > 0 ? { catalog } : {}),
      model: def,
      ...(Object.keys(pulledMeta).length > 0 ? { modelMeta: pulledMeta } : {}),
      authMode,
      oauthProvider,
    });
  };

  const hasValidName = name.trim() && !existingNames.includes(name.trim());

  /** oauth 订阅已登录账号（弹层内登录面板 + 详情页共用展示形状）。 */
  const oauthAccountsEl =
    oauthAccountsState.length > 0 ? (
      <div className="pp-oauth-accounts">
        {oauthAccountsState.map((acct) => (
          <div key={acct.accountId} className="pp-model-item">
            <span className="pp-model-chip" title={acct.accountId}>
              <span className="pp-model-chip-name">{acct.accountId}</span>
              <button
                type="button"
                className="pp-model-chip-x"
                title={`登出 ${acct.accountId}`}
                aria-label={`登出 ${acct.accountId}`}
                onClick={() => handleOauthLogout(acct.accountId)}
              >
                登出
              </button>
            </span>
          </div>
        ))}
      </div>
    ) : (
      <div className="pp-f-hint">尚未登录任何账号。点击下方按钮，用浏览器完成 {name || '订阅'} 授权登录。</div>
    );

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
          {isOAuth && ' OAuth 订阅：先在下方完成浏览器授权登录，登录后即可拉取该账号的可用模型。'}
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
                // 改名后拉取结果作废（api-key 手动拉取与 name 相关；
                // oauth 的模型来自账号——与 name 解耦，不改动已拉列表）
                if (pulled && !isOAuth) {
                  setPulled(false);
                  setModels([]);
                  setEnabled([]);
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
                  setEnabled([]);
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
                  setEnabled([]);
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
            /* ── OAuth 登录面板（弹层内——不再等建行后去详情页）── */
            <div className="pp-fg">
              <div className="pp-f-label-row">
                <span className="pp-f-label">登录方式</span>
                <span className="pp-chip">OAuth 订阅</span>
              </div>
              {oauthAccountsEl}
              {oauthStatus && !oauthBusy && (
                <div className={`pp-oauth-status ${oauthStatus.tone}`}>{oauthStatus.msg}</div>
              )}
              <div className="pp-oauth-actions">
                <button
                  type="button"
                  className="sp-btn-sm"
                  disabled={oauthBusy}
                  onClick={() => void handleOauthLogin()}
                >
                  {oauthBusy ? '等待浏览器授权…' : oauthAccountsState.length > 0 ? '再登录一个账号' : '登录'}
                </button>
                {oauthBusy && (
                  <button type="button" className="sp-btn-sm pp-btn-danger" onClick={handleOauthCancel}>
                    取消登录
                  </button>
                )}
              </div>
              {oauthBusy && oauthStatus && (
                <div className="pp-f-hint">
                  {oauthStatus.msg}
                  <br />
                  （轮询中——授权完成后自动生效；可在浏览器取消）
                </div>
              )}
              <div className="pp-f-hint">
                账号登录凭证存本机系统凭据；多个账号可共存，这里展示的是此订阅已登录的账号。
              </div>
            </div>
          )}
        </div>

        <div className="pp-sheet-divider">
          <span>可用模型</span>
        </div>

        {isOAuth ? (
          /* oauth 订阅：登录后从账号 API 拉真实模型（无账号拉取必然失败——
             按钮未登录时禁用并说明；也保留手动补的兜底）。 */
          <div className="pp-add-pull-row">
            <button
              type="button"
              className="sp-btn-sm"
              disabled={fetching || oauthAccountsState.length === 0}
              onClick={() => void handleOauthFetchModels()}
              title={
                oauthAccountsState.length === 0
                  ? '先完成上方 OAuth 登录，才能拉取该账号可用模型'
                  : '用当前登录账号从提供方拉取可用模型'
              }
            >
              {fetching ? '拉取中…' : oauthAccountsState.length === 0 ? '登录后可拉取模型' : '从账号拉取模型'}
            </button>
            {fetchMsg && (
              <span className={`pp-add-pull-msg${fetchMsg.startsWith('拉取失败') ? ' fail' : ''}`}>{fetchMsg}</span>
            )}
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

        {models.length > 0 ? (
          <>
            {/* 目录 / 启用分层（2026-09-23）：拉取只填目录，勾选才进「可用模型」 */}
            <div className="pp-pick-head">
              <span className="pp-f-label">可用模型</span>
              <span className="pp-chip">
                已启用 {enabled.length} / 目录 {models.length}
              </span>
              <span className="pp-spacer" />
              <button type="button" className="sp-btn-sm" onClick={() => setEnabled(models)}>
                全选
              </button>
              <button
                type="button"
                className="sp-btn-sm"
                onClick={() => {
                  setEnabled([]);
                  setDefaultModel('');
                }}
              >
                清空
              </button>
            </div>
            <div className="pp-pick-models">
              {models.map((id) => {
                const on = enabled.includes(id);
                return (
                  <div key={id} className={`pp-pick-model${on ? ' selected' : ''}`} title={id}>
                    <label className="pp-pick-check">
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={`启用 ${id}`}
                        onChange={() => toggleEnabled(id)}
                      />
                      <span className="pp-pick-model-id">{id}</span>
                    </label>
                    {defaultModel === id && <span className="pp-model-chip-default">新会话默认</span>}
                    <button
                      type="button"
                      className="pp-pick-setdefault"
                      disabled={!on || defaultModel === id}
                      title={on ? '设为新会话默认模型' : '先勾选启用，才能设为默认'}
                      onClick={() => setDefaultModel(id)}
                    >
                      设为默认
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="pp-f-hint">
            {isOAuth
              ? '还没有模型——先完成上方登录，再点「从账号拉取模型」，或在下方手动补一个模型 id。'
              : '还没有模型——点上方「从 API 拉取模型」，或在下方手动补一个模型 id。'}
          </div>
        )}

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

/** 构建 OAuth 模式的模型拉取 provider（行尚未持久化——按名临时解析 grant 注入头）。
 *  复用 live provider 的 oauth 注入路径，但 fetchModels 需要真正拿到 grant；
 *  这里直接 resolveOauthToken 取最近登录账号 → 注入头 → 建 provider。 */
async function buildOauthModelProvider(
  name: string,
  oauthProvider: string,
  kind: Protocol,
  baseUrl: string,
): Promise<Provider> {
  const oauth = await resolveOauthToken({
    kind,
    name: providerId(name),
    apiKey: '',
    baseUrl,
    model: '',
    authMode: 'oauth',
    oauthProvider,
  });
  if (!oauth) {
    throw new Error('OAuth 账号未登录或会话已失效——请先完成登录');
  }
  return createProvider(
    {
      kind,
      name: providerId(name),
      apiKey: '',
      baseUrl,
      model: '',
    },
    { oauthHeaders: buildOauthHeaders(oauth) },
  );
}
