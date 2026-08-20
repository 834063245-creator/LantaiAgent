// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// PluginsPage（S4-3）— 设置面板「插件」标签页。
//
// 三块（设计件 §2.6）：
//   1. 已装列表（plugin-store 现状渲染：name/version/status/error + 禁用
//      开关 + 卸载按钮）；
//   2. 安装输入框（source 三形态：registry 规格 / tarball URL 或本地路径 /
//      本地目录——同一解包校验路径）；
//   3. 常驻供应链警告条（完全信任模型原文——不做任何「已审核」标记）。
//
// 生效时机如实声明：安装/卸载/禁用均重启生效（装载是 boot 期一次性——
// 与组合层「下次装配」语义对齐）。

import { useState } from 'react';
import { typedRpc } from '../../../rpc-contract';
import { type PluginRecord, usePluginStore } from '../../../state/plugin-store';
import { Icon } from '../../Icon';

/** 状态标签（对应 PluginStatus）。 */
function statusBadge(s: PluginRecord['status']): { text: string; color: string } {
  if (s === 'active') return { text: '运行中', color: 'var(--obs-pass)' };
  if (s === 'disabled') return { text: '已禁用', color: 'var(--obs-text-2)' };
  return { text: '装载失败', color: 'var(--obs-warn)' };
}

/** 已装插件卡片。 */
function PluginCard({
  plugin,
  busy,
  onToggle,
  onUninstall,
}: {
  plugin: PluginRecord;
  busy: boolean;
  onToggle: (name: string, enabled: boolean) => void;
  onUninstall: (name: string) => void;
}) {
  const badge = statusBadge(plugin.status);
  const enabled = plugin.status !== 'disabled';
  return (
    <div className="sp-lsp-card">
      <span className="sp-lsp-card-icon" style={{ color: badge.color }}>
        <Icon name={plugin.status === 'error' ? 'alert-circle' : 'agent'} />
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
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button
            type="button"
            className="sp-btn sp-btn-cancel"
            style={{ padding: '2px 10px', fontSize: 11 }}
            disabled={busy}
            onClick={() => onToggle(plugin.name, !enabled)}
          >
            {enabled ? '禁用' : '启用'}
          </button>
          <button
            type="button"
            className="sp-btn sp-btn-cancel"
            style={{ padding: '2px 10px', fontSize: 11 }}
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

/** 插件标签页（S4-3）。 */
export function PluginsPage() {
  const plugins = usePluginStore((s) => s.plugins);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function run(action: () => Promise<string>): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const name = await action();
      setMessage({ kind: 'ok', text: `操作成功：${name}——重启后生效` });
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
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
          border: '1px solid var(--obs-warn)',
          borderRadius: 6,
          fontSize: 11,
          lineHeight: 1.6,
          color: 'var(--obs-text-1)',
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
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim() && !busy) {
                const p = parseInstallParams(input);
                void run(() => typedRpc('plugin_install', p));
              }
            }}
          />
          <button
            type="button"
            className="sp-btn sp-btn-save"
            style={{ whiteSpace: 'nowrap' }}
            disabled={busy || !input.trim()}
            onClick={() => {
              const p = parseInstallParams(input);
              void run(() => typedRpc('plugin_install', p));
            }}
          >
            安装
          </button>
        </div>
        <div className="sp-hint-sub">
          三种源：npm 包名（缺省 registry.npmjs.org）、tarball URL 或本地路径（npm pack 产物）、
          本地插件目录（复制进插件根）。安装/卸载/禁用均重启后生效。
        </div>
        {message && (
          <div className="sp-hint-sub" style={{ color: message.kind === 'ok' ? 'var(--obs-pass)' : 'var(--obs-warn)' }}>
            {message.text}
          </div>
        )}
      </div>

      {/* 已装列表 */}
      <div className="sp-section">
        <div className="sp-section-title">已安装（{plugins.length}）</div>
        {plugins.length === 0 ? (
          <div className="sp-hint" style={{ padding: 8 }}>
            暂无插件。手动放置：~/.hologram/plugins/&lt;name&gt;/（含 manifest.json）。
          </div>
        ) : (
          plugins.map((p) => (
            <PluginCard
              key={p.name}
              plugin={p}
              busy={busy}
              onToggle={(name, enabled) => {
                void run(() => typedRpc('plugin_set_enabled', { name, enabled }));
              }}
              onUninstall={(name) => {
                void run(() => typedRpc('plugin_uninstall', { name }));
              }}
            />
          ))
        )}
      </div>
    </>
  );
}
