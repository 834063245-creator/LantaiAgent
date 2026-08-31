// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// PluginsPage（S4-3）— 设置面板「插件」标签页。
//
// 三块（设计件 §2.6；2026-08-29 收编第一方插件）：
//   1. 平台服务（常驻）——组合层 service / seam provider / 运行体本体，
//      只读陈列（第一方清单 kind=service），无开关（禁了应用就散架）；
//   2. 内置插件（第一方）——功能插件（kind=feature），可启用/禁用
//      （偏好经 plugin-prefs 持久化，**下次启动生效**——第一方是编译期
//      bundle，贡献面在 boot 期装载，跳过是诚实生效点）；
//   3. 已安装插件（第三方）——磁盘通道外部插件，运行时装/卸/启用/禁用
//      （D6）+ 卸载按钮。
// 顶部安装输入框 + 常驻供应链警告条（完全信任模型原文——不做「已审核」标记）。

import { useState } from 'react';
import { activateExternalPlugin, deactivateExternalPlugin } from '../../../plugins/loader';
import { parseJson, typedRpc } from '../../../rpc-contract';
import { usePluginPrefs } from '../../../state/plugin-prefs';
import { type PluginRecord, usePluginStore } from '../../../state/plugin-store';
import { Icon } from '../../Icon';

/** 状态标签（对应 PluginStatus）。 */
function statusBadge(s: PluginRecord['status']): { text: string; color: string } {
  if (s === 'active') return { text: '运行中', color: 'var(--pass)' };
  if (s === 'disabled') return { text: '已禁用', color: 'var(--ink-2)' };
  if (s === 'blocked') return { text: '待授权', color: 'var(--warn)' };
  return { text: '装载失败', color: 'var(--warn)' };
}

/** 第三方已装插件卡片（装/卸/启/禁走 RPC + 运行时 fiber 装卸）。 */
function PluginCard({
  plugin,
  busyName,
  onToggle,
  onUninstall,
}: {
  plugin: PluginRecord;
  /** 操作中的插件名（按插件粒度禁用——全局 busy 会锁住无关插件，2026-08 UI 大清扫） */
  busyName: string | null;
  onToggle: (name: string, action: 'enable' | 'disable' | 'reload') => void;
  onUninstall: (name: string) => void;
}) {
  const badge = statusBadge(plugin.status);
  const enabled = plugin.status !== 'disabled';
  const busy = busyName === plugin.name;
  return (
    <div className="sp-lsp-card">
      <span className="sp-lsp-card-icon" style={{ color: badge.color }}>
        <Icon name={plugin.status === 'error' || plugin.status === 'blocked' ? 'alert-circle' : 'agent'} />
      </span>
      <div className="sp-lsp-card-body">
        <div className="sp-lsp-card-header">
          <span className="lang-name">{plugin.name}</span>
          <span className="lang-status" style={{ color: badge.color }}>
            {badge.text}
          </span>
        </div>
        <div className="sp-lsp-card-meta">
          {plugin.manifest ? (
            <>
              <code>v{plugin.manifest.version}</code>
              {plugin.manifest.description ? <span> · {plugin.manifest.description}</span> : null}
            </>
          ) : (
            <span>manifest 不可用</span>
          )}
        </div>
        {plugin.error && <div className="sp-lsp-card-err">{plugin.error}</div>}
        {plugin.status === 'blocked' && plugin.missingPermissions && (
          <div className="sp-lsp-card-err">
            待授权权限类：{plugin.missingPermissions.join(' / ')}——在
            <code> ~/.lantai/plugins/plugins.json</code> 的 <code>granted</code> 段写入
            <code>
              {' '}
              {'{ "' + plugin.name + '": [' + plugin.missingPermissions.map((p) => `'${p}'`).join(', ') + '] }'}
            </code>
            后点「重新装载」立即生效。
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button
            type="button"
            className="sp-btn-sm"
            disabled={busy}
            onClick={() =>
              onToggle(plugin.name, plugin.status === 'blocked' ? 'reload' : enabled ? 'disable' : 'enable')
            }
          >
            {plugin.status === 'blocked' ? '重新装载' : enabled ? '禁用' : '启用'}
          </button>
          <button
            type="button"
            className="sp-btn-sm pp-btn-danger"
            disabled={busy}
            onClick={() => onUninstall(plugin.name)}
          >
            卸载
          </button>
        </div>
      </div>
    </div>
  );
}

/** 第一方插件卡片（元数据来自 first-party-manifest；kind=service 时无开关）。
 *  P1e：内置渲染器插件（hologram/renderers）提供「重新加载」——
 *  从磁盘产物通道（dist-plugins/builtin/renderers，Rust 资产通道回退）
 *  重新装载覆盖行（bundle 行始终兜底，磁盘行覆盖——见 loader 装载语义）。 */
function FirstPartyCard({
  plugin,
  onToggle,
  onReload,
}: {
  plugin: PluginRecord;
  onToggle: (name: string, enabled: boolean) => void;
  onReload?: (name: string) => void;
}) {
  const meta = plugin.meta;
  const enabled = plugin.status !== 'disabled';
  const badge = statusBadge(plugin.status);
  const reloadable = plugin.name === 'hologram/renderers';
  return (
    <div className="sp-lsp-card">
      <span className="sp-lsp-card-icon" style={{ color: badge.color }}>
        <Icon name="agent" />
      </span>
      <div className="sp-lsp-card-body">
        <div className="sp-lsp-card-header">
          <span className="lang-name">{plugin.name}</span>
          <span className="lang-status" style={{ color: badge.color }}>
            {badge.text}
          </span>
        </div>
        <div className="sp-lsp-card-meta">
          <code>v{meta?.version ?? '?'}</code>
          {meta?.description ? <span> · {meta.description}</span> : null}
        </div>
        {plugin.error && <div className="sp-lsp-card-err">{plugin.error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {plugin.meta?.kind === 'service' ? (
            <span className="sp-hint-sub">平台服务 · 常驻</span>
          ) : (
            <button type="button" className="sp-btn-sm" onClick={() => onToggle(plugin.name, !enabled)}>
              {enabled ? '禁用' : '启用'}
            </button>
          )}
          {reloadable && onReload && (
            <button type="button" className="sp-btn-sm" onClick={() => onReload(plugin.name)}>
              重新加载
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 插件标签页（S4-3）。 */
export function PluginsPage() {
  const plugins = usePluginStore((s) => s.plugins);
  // 三组：平台服务（常驻）/ 内置插件（第一方，可禁用）/ 已安装插件（第三方）
  const services = plugins.filter((p) => p.builtin && p.meta?.kind === 'service');
  const builtinFeatures = plugins.filter((p) => p.builtin && p.meta?.kind === 'feature');
  const externals = plugins.filter((p) => !p.builtin);
  /** 操作目标（插件名或 'install' 哨兵）——按目标粒度锁按钮，无关插件不受牵连 */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  /** 第一方禁用/启用（偏好持久化；下次启动生效——boot 期装载跳过）。 */
  function toggleBuiltin(name: string, enabled: boolean): void {
    usePluginPrefs.getState().setDisabled(name, !enabled);
    usePluginStore.getState().setPluginStatus(name, enabled ? 'active' : 'disabled');
    setMessage({ kind: 'ok', text: `${name}——下次启动生效` });
  }

  async function run(key: string, action: () => Promise<string>): Promise<string | null> {
    setBusyKey(key);
    setMessage(null);
    try {
      const name = await action();
      setMessage({ kind: 'ok', text: `${name}——运行时已生效（工具面在下次 Agent 装配生效）` });
      return name;
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      setBusyKey(null);
    }
  }

  /** 装/卸/启/禁的运行时生效面（D6）：RPC 落盘成功后即时装卸 fiber。
   *  plugin_install 的 result 是 JSON 字符串（ok_json）——parseJson 还原名。 */
  async function installThenActivate(p: { source_kind: string; name?: string; location?: string }): Promise<string> {
    const raw = await typedRpc('plugin_install', p as never);
    const name = parseJson<string>(raw);
    const record = await activateExternalPlugin(name);
    return `${name}（${record.status === 'active' ? '已装载' : `状态 ${record.status}${record.error ? `：${record.error}` : ''}`}）`;
  }
  async function enableThenActivate(name: string): Promise<string> {
    await typedRpc('plugin_set_enabled', { name, enabled: true });
    const record = await activateExternalPlugin(name);
    return `${name}（${record.status === 'active' ? '已装载' : `状态 ${record.status}${record.error ? `：${record.error}` : ''}`}）`;
  }
  /** blocked → 授权后的重新装载（plugins.json granted 已手改；RPC 侧无状态要写）。 */
  async function activateThenReport(name: string): Promise<string> {
    const record = await activateExternalPlugin(name);
    return `${name}（${record.status === 'active' ? '已装载' : `状态 ${record.status}${record.error ? `：${record.error}` : ''}`}）`;
  }
  async function disableThenDeactivate(name: string): Promise<string> {
    await typedRpc('plugin_set_enabled', { name, enabled: false });
    await deactivateExternalPlugin(name);
    return `${name}（已停用并回收贡献）`;
  }
  async function uninstallThenDeactivate(name: string): Promise<string> {
    await deactivateExternalPlugin(name);
    await typedRpc('plugin_uninstall', { name });
    usePluginStore.getState().removePlugin(name);
    return `${name}（已卸载并回收贡献）`;
  }

  /** P1e：内置渲染器插件重新加载——从磁盘产物通道重新激活覆盖行
   *  （bundle 行始终兜底；activateExternalPlugin 先 dispose 旧覆盖行再
   *  重 fetch entry.js 重新装载——D6 链路，秒级生效）。 */
  async function reloadBuiltin(name: string): Promise<string> {
    const record = await activateExternalPlugin(name);
    return `${name}（${record.status === 'active' ? '已从产物通道重载' : `状态 ${record.status}${record.error ? `：${record.error}` : ''}`}）`;
  }

  /** 解析安装输入（三形态，设计件 §2.6）：npm 名 / tarball（URL 或本地
   *  .tgz 路径）/ 本地目录（绝对/盘符路径形态——Rust 侧校验存在性）。 */
  function parseInstallParams(
    raw: string,
  ):
    | { source_kind: 'registry'; name: string }
    | { source_kind: 'tarball'; location: string }
    | { source_kind: 'local_dir'; location: string } {
    const t = raw.trim();
    if (t.startsWith('http://') || t.startsWith('https://')) return { source_kind: 'tarball', location: t };
    if (/\.t(ar\.)?gz$/i.test(t)) return { source_kind: 'tarball', location: t };
    // 本地目录形态：Windows 盘符路径（D:\... 或 D:/...）或 POSIX 绝对路径
    // （/...）——npm 包名不含这些形态（scope 名也没有盘符冒号/前导斜杠）
    if (/^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('\\')) {
      return { source_kind: 'local_dir', location: t };
    }
    return { source_kind: 'registry', name: t };
  }

  return (
    <>
      {/* 供应链警告（常驻——完全信任模型，ADR §5） */}
      <div
        style={{
          padding: '8px 10px',
          marginBottom: 12,
          border: '1px solid var(--warn)',
          borderRadius: 6,
          fontSize: 11,
          lineHeight: 1.6,
        }}
      >
        ⚠ 插件是本机全信任代码：可读写文件、起子进程、调用全部 RPC。npm 上的包 ≠ 审核过的包——只安装你信任来源的插件。
      </div>

      {/* 安装输入 */}
      <div className="sp-section">
        <div className="sp-section-title">安装插件</div>
        <div className="sp-field" style={{ display: 'flex', gap: 8 }}>
          <input
            className="sp-input"
            placeholder="npm 包名 / tarball URL 或 .tgz 路径 / 本地插件目录"
            value={input}
            disabled={busyKey === 'install'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim() && busyKey === null) {
                const p = parseInstallParams(input);
                void run('install', () => installThenActivate(p));
              }
            }}
          />
          <button
            type="button"
            className="sp-btn sp-btn-save"
            style={{ whiteSpace: 'nowrap' }}
            disabled={busyKey === 'install' || !input.trim()}
            onClick={() => {
              const p = parseInstallParams(input);
              void run('install', () => installThenActivate(p));
            }}
          >
            安装
          </button>
        </div>
        <div className="sp-hint-sub">
          三种源：npm 包名（缺省 registry.npmjs.org）、tarball URL 或本地路径（npm pack 产物）、
          本地插件目录（复制进插件根）。装/卸/启用/禁用均运行时生效（D6）。
        </div>
        {message && (
          <div className="sp-hint-sub" style={{ color: message.kind === 'ok' ? 'var(--pass)' : 'var(--warn)' }}>
            {message.text}
          </div>
        )}
      </div>

      {/* 平台服务（第一方 kind=service，常驻） */}
      {services.length > 0 && (
        <div className="sp-section">
          <div className="sp-section-title">平台服务（{services.length}）</div>
          <div className="sp-hint-sub">组合层服务 / 引擎缝 / 运行体本体——应用运行所需，不可禁用。</div>
          {services.map((p) => (
            <FirstPartyCard key={p.name} plugin={p} onToggle={toggleBuiltin} />
          ))}
        </div>
      )}

      {/* 内置插件（第一方 kind=feature，可禁用；P1e 渲染器可重新加载） */}
      {builtinFeatures.length > 0 && (
        <div className="sp-section">
          <div className="sp-section-title">内置插件（{builtinFeatures.length}）</div>
          <div className="sp-hint-sub">
            第一方功能插件——禁用/启用下次启动生效；渲染器插件可经「重新加载」从产物通道热替换（秒级生效）。
          </div>
          {builtinFeatures.map((p) => (
            <FirstPartyCard
              key={p.name}
              plugin={p}
              onToggle={toggleBuiltin}
              onReload={(name) => {
                // 渲染器重载即时生效——不经 run 的通用后缀（「工具面下次装配」
                // 语义不适用）；直接执行并展示 reloadBuiltin 的精确文案。
                setBusyKey(name);
                setMessage(null);
                reloadBuiltin(name)
                  .then((text) => setMessage({ kind: 'ok', text }))
                  .catch((e) => setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
                  .finally(() => setBusyKey(null));
              }}
            />
          ))}
        </div>
      )}

      {/* 已装列表（第三方外部插件） */}
      <div className="sp-section">
        <div className="sp-section-title">已安装（{externals.length}）</div>
        {externals.length === 0 ? (
          <div className="sp-hint" style={{ padding: 8 }}>
            暂无插件。手动放置：~/.lantai/plugins/&lt;name&gt;/（含 manifest.json）。
          </div>
        ) : (
          externals.map((p) => (
            <PluginCard
              key={p.name}
              plugin={p}
              busyName={busyKey}
              onToggle={(name, action) => {
                void run(name, () => {
                  if (action === 'enable') return enableThenActivate(name);
                  if (action === 'reload') return activateThenReport(name);
                  return disableThenDeactivate(name);
                });
              }}
              onUninstall={(name) => {
                void run(name, () => uninstallThenDeactivate(name));
              }}
            />
          ))
        )}
      </div>
    </>
  );
}
