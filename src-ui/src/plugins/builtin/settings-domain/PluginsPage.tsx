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
// 内核依赖经包内宿主面取用（2026-09-24 批 1 归家：本页已迁
// plugins/builtin/settings-domain/；loader 的装卸面按既有循环注记运行期取用）。
import {
  activateExternalPlugin,
  collectPluginDiagnostics,
  deactivateExternalPlugin,
  Icon,
  type PluginDiagnostics,
  type PluginRecord,
  typedRpc,
  usePluginPrefs,
  usePluginStore,
} from './host';

/** 复制到剪贴板（无 API 环境返回 false——UI 如实说，不假装复制成功）。 */
async function copyText(text: string): Promise<boolean> {
  const clip = globalThis.navigator?.clipboard;
  if (!clip) return false;
  try {
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 插件医生展开面（只读快照：字段表 + 复制 JSON）。
 *  数据全由 `collectPluginDiagnostics` 拼装（单一入口）——这里只管摆放。 */
function describeInstallSource(diag: PluginDiagnostics): string {
  if (diag.installSource) return `${diag.installSource.source_kind} · ${diag.installSource.location}`;
  return diag.builtin ? '内置' : '未记录（旧版安装或手动放置）';
}

function PluginDiagnosticsView({ diag }: { diag: PluginDiagnostics }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const rows: Array<[string, string]> = [
    ['状态', diag.status + (diag.error ? `——${diag.error}` : '')],
    [
      '版本 / 入口',
      diag.manifest ? `v${diag.manifest.version} · ${diag.manifest.entry}` : '无 manifest（内核插件或校验失败）',
    ],
    ['契约版本', `v${diag.contractVersion}`],
    ['插件目录', diag.pluginDir ?? (diag.builtin ? '内置（无磁盘目录）' : '不可得')],
    ['数据目录', diag.dataDir ?? (diag.manifest ? '未声明 dataDir' : '—')],
    ['安装来源', describeInstallSource(diag)],
    ['声明工具', diag.tools.declared.length > 0 ? diag.tools.declared.join(' · ') : '未声明 tools'],
    [
      '受治进程',
      diag.tools.mcp.length > 0
        ? diag.tools.mcp
            .map(
              (m) =>
                `${m.server}: ${m.state} · ${m.toolCount} 工具` +
                (m.lastStopReason ? ` · 最近停止 ${m.lastStopReason}` : ''),
            )
            .join('；')
        : '无',
    ],
    ['窗口', diag.windows.declared ? `${diag.windows.mode ?? 'floating'} · 当前开 ${diag.windows.open}` : '未声明 app'],
    [
      '激活声明',
      diag.activation.declared
        ? `lazy=${diag.activation.lazy ? '是' : '否'} · 资源 ${diag.activation.resources.join('/') || '—'} · ${diag.activation.started ? '已启动' : '未启动'}`
        : '未声明 activation',
    ],
    ...(diag.activation.failure ? ([['激活失败', diag.activation.failure]] as Array<[string, string]>) : []),
    ...(diag.warnings.length > 0 ? ([['警告', diag.warnings.join('；')]] as Array<[string, string]>) : []),
  ];
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <table style={{ width: '100%', fontSize: 'var(--fs-caption)', borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key}>
              <td
                style={{ whiteSpace: 'nowrap', padding: '2px 8px 2px 0', color: 'var(--ink-2)', verticalAlign: 'top' }}
              >
                {key}
              </td>
              <td style={{ padding: '2px 0', wordBreak: 'break-all' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="sp-btn-sm"
        style={{ marginTop: 6 }}
        onClick={() => {
          void copyText(JSON.stringify(diag, null, 2)).then((ok) => setCopied(ok ? 'ok' : 'fail'));
        }}
      >
        {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败（剪贴板不可用）' : '复制 JSON'}
      </button>
    </div>
  );
}

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
  onReload,
  onDiagnose,
  diagnostics,
}: {
  plugin: PluginRecord;
  /** 操作中的插件名（按插件粒度禁用——全局 busy 会锁住无关插件，2026-08 UI 大清扫） */
  busyName: string | null;
  onToggle: (name: string, action: 'enable' | 'disable' | 'reload') => void;
  onUninstall: (name: string) => void;
  /** 外部插件「重新加载」（改完插件目录 → 点一下；失败保留旧 fiber）。 */
  onReload: (name: string) => void;
  onDiagnose: (name: string) => void;
  diagnostics?: React.ReactNode;
}) {
  const badge = statusBadge(plugin.status);
  const enabled = plugin.status !== 'disabled';
  const busy = busyName === plugin.name;
  // 卸载不可逆（目录挪进 .trash，但贡献面已拆）——两段式确认，防误点。
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  return (
    <div className="sp-lsp-card">
      <span className="sp-lsp-card-icon" style={{ color: badge.color }}>
        <Icon name={plugin.status === 'error' || plugin.status === 'blocked' ? 'alert-circle' : 'plugin'} />
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
          <button type="button" className="sp-btn-sm" disabled={busy} onClick={() => onReload(plugin.name)}>
            重新加载
          </button>
          <button type="button" className="sp-btn-sm" disabled={busy} onClick={() => onDiagnose(plugin.name)}>
            诊断
          </button>
          {confirmingUninstall ? (
            <>
              <button
                type="button"
                className="sp-btn-sm pp-btn-danger"
                disabled={busy}
                onClick={() => {
                  setConfirmingUninstall(false);
                  onUninstall(plugin.name);
                }}
              >
                确认卸载
              </button>
              <button type="button" className="sp-btn-sm" disabled={busy} onClick={() => setConfirmingUninstall(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="sp-btn-sm pp-btn-danger"
              disabled={busy}
              onClick={() => setConfirmingUninstall(true)}
            >
              卸载
            </button>
          )}
        </div>
        {confirmingUninstall && (
          <div className="sp-lsp-card-err" style={{ color: 'var(--ink-2)' }}>
            将卸载 {plugin.name}：目录挪进 <code>plugins-data/.trash</code>（可找回），贡献面立即回收。
          </div>
        )}
        {diagnostics}
      </div>
    </div>
  );
}

/** 第一方插件卡片（元数据来自 first-party-manifest；kind=service 时无开关）。
 *  P1e：内置渲染器插件（hologram/renderers）提供「重新加载」——
 *  从磁盘产物通道（dist-plugins/builtin/renderers，Rust 资产通道回退）
 *  重新装载覆盖行（bundle 行始终兜底，磁盘行覆盖——见 loader 装载语义）。
 *  增补四：kind=feature 全量通道化后，全部功能插件均可重载（位移式内置
 *  插件重载 = bundle 兜底行 → 产物行单活互换；工具面重载影响下次装配）。 */
function FirstPartyCard({
  plugin,
  onToggle,
  onReload,
  onDiagnose,
  diagnostics,
}: {
  plugin: PluginRecord;
  onToggle: (name: string, enabled: boolean) => void;
  onReload?: (name: string) => void;
  onDiagnose: (name: string) => void;
  diagnostics?: React.ReactNode;
}) {
  const meta = plugin.meta;
  const enabled = plugin.status !== 'disabled';
  const badge = statusBadge(plugin.status);
  const reloadable = plugin.meta?.kind === 'feature';
  return (
    <div className="sp-lsp-card">
      <span className="sp-lsp-card-icon" style={{ color: badge.color }}>
        <Icon name="plugin" />
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
          ) : plugin.meta?.required ? (
            /* 批 8b：`required` 产物（机制性默认面，如 paper-renderers 的十一 kind 全谱）
               ——不可禁用：禁用即主界面裸奔，故只显示状态、不出开关。 */
            <span className="sp-hint-sub">常驻 · 不可禁用</span>
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
          <button type="button" className="sp-btn-sm" onClick={() => onDiagnose(plugin.name)}>
            诊断
          </button>
        </div>
        {diagnostics}
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
  /** 展开中的插件医生（同一时刻只展一份——表宽、少噪声）。 */
  const [diag, setDiag] = useState<{ name: string; data: PluginDiagnostics } | null>(null);

  /** 展开/收起诊断（只读聚合；已展开的再点 = 收起）。 */
  function toggleDiagnostics(name: string): void {
    if (diag?.name === name) {
      setDiag(null);
      return;
    }
    const record = usePluginStore.getState().plugins.find((p) => p.name === name);
    if (!record) return;
    void collectPluginDiagnostics(record).then((data) => setDiag({ name, data }));
  }

  /** 某插件当前的诊断节点（未展开 = undefined）。 */
  function diagnosticsFor(name: string): React.ReactNode {
    return diag?.name === name ? <PluginDiagnosticsView diag={diag.data} /> : undefined;
  }

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
   *  plugin_install 的 result 是**裸插件名**（2026-11-18 真机修：旧实现
   *  `ok_json(Ok(name))` 返回的是带引号的 JSON 文本，这里的 `parseJson` 当场抛
   *  `Unexpected token 'h'` ⇒ 安装永远停在报错、插件装上也激活不了）。
   *  裸串直读，与 `composition_dir` 同判例；改回 JSON 会让 rpc 形状守卫红。 */
  async function installThenActivate(p: { source_kind: string; name?: string; location?: string }): Promise<string> {
    const name = await typedRpc('plugin_install', p as never);
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
    | { source_kind: 'local_dir'; location: string }
    | { source_kind: 'link'; location: string } {
    const t = raw.trim();
    // dev link：显式 link: 前缀 → 链接安装（plugins 根下建目录链接指向源码，
    // 改代码后「重新加载」即生效；卸载只删链接，源码不动）。
    if (/^link:/i.test(t)) return { source_kind: 'link', location: t.slice(5).trim() };
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
          fontSize: 'var(--fs-caption)',
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
            style={{ flex: 1, minWidth: 0 }}
            placeholder="npm 包名 / tarball URL 或 .tgz 路径 / 本地插件目录 / link:源码目录"
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
          四种源：npm 包名（缺省 registry.npmjs.org）、tarball URL 或本地路径（npm pack 产物）、
          本地插件目录（复制进插件根）、<code>link:</code> 源码目录（建目录链接，改代码后「重新加载」即生效，
          卸载只删链接不动源码）。装/卸/启用/禁用均运行时生效（D6）。
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
            <FirstPartyCard
              key={p.name}
              plugin={p}
              onToggle={toggleBuiltin}
              onDiagnose={toggleDiagnostics}
              diagnostics={diagnosticsFor(p.name)}
            />
          ))}
        </div>
      )}

      {/* 内置插件（第一方 kind=feature，可禁用；P1e 渲染器可重新加载） */}
      {builtinFeatures.length > 0 && (
        <div className="sp-section">
          <div className="sp-section-title">内置插件（{builtinFeatures.length}）</div>
          <div className="sp-hint-sub">
            第一方功能插件——禁用/启用下次启动生效；功能插件可经「重新加载」从产物通道热替换（秒级生效， 工具面在下次
            Agent 装配生效）。
          </div>
          {builtinFeatures.map((p) => (
            <FirstPartyCard
              key={p.name}
              plugin={p}
              onToggle={toggleBuiltin}
              onDiagnose={toggleDiagnostics}
              diagnostics={diagnosticsFor(p.name)}
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
              onReload={(name) => {
                // 外部插件重载 = 既有「先验后拆」路径（loader.activateExternalPlugin：
                // 新版过完全部拒载闸才 dispose 旧 fiber；被拒 = 场上旧版原样继续跑）
                void run(name, () => activateThenReport(name));
              }}
              onDiagnose={toggleDiagnostics}
              diagnostics={diagnosticsFor(p.name)}
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
