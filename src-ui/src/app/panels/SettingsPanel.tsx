// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings 面板 — Provider | Agent | Display | Languages | About 五个标签页。
// Provider 页已拆为 settings/ProviderPage（提供方控制台），本文件只保留
// 外壳：tab 切换、dirty 状态、保存/取消、凭据暂存（删除/清除）统一落盘。

import { getVersion } from '@tauri-apps/api/app';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { selectPreset } from '../../composition/preset-assembly';
import { setLang } from '../../i18n';
import { typedJsonRpc } from '../../rpc-contract';
import type { AppSettings, ConnectionProbe, ProviderId } from '../../settings';
import {
  autoUpdateCheckEnabled,
  graphEngineEnabled,
  loadSettings,
  loadSettingsWithSecrets,
  persistSecrets,
  removeSecret,
  saveSettings,
} from '../../settings';
import { notifyAgentConfigChanged } from '../../state/agent-config-store';
import { useCompositionStore } from '../../state/composition-store';
import { useDockStore } from '../../state/dock-store';
import { usePresetStore } from '../../state/preset-store';
import { useUpdateStore } from '../../state/update-store';
import { iconHtml } from '../../ui/icons';
import { ConfirmDialog } from './settings/ConfirmDialog';
import { PluginsPage } from './settings/PluginsPage';
import { ProviderPage } from './settings/ProviderPage';

type Tab = 'provider' | 'agent' | 'display' | 'languages' | 'plugins' | 'about';

interface LspServer {
  command: string;
  language_id: string;
  extensions: string[];
  available: boolean;
  installed?: boolean;
  error?: string;
}
interface LspData {
  available: string[];
  missing: string[];
  servers: LspServer[];
}

// ── 主组件 ──

const SettingsPanelApp: React.FC<{
  onClose: () => void;
  onSave: (() => void) | null;
}> = ({ onClose, onSave }) => {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [activeTab, setActiveTab] = useState<Tab>('provider');
  const [appVersion, setAppVersion] = useState('…');
  // S4-2：组合诊断 + preset 选择（Agent tab「组合」节——只读诊断 + 缺省选择器）
  const compositionStatus = useCompositionStore((s) => s.status);
  const compositionPatchOrigin = useCompositionStore((s) => s.patchOrigin);
  const compositionError = useCompositionStore((s) => s.error);
  const compositionDiagnostics = useCompositionStore((s) => s.resolved.diagnostics);
  const presetRoster = usePresetStore((s) => s.roster);
  const presetSelected = usePresetStore((s) => s.selected);
  // ⚡ 2026-08-04 状态治理：apiKey 权威在系统加密凭据 —
  // localStorage 无明文，打开面板时异步回填密钥供表单展示。
  // ⚡ 2026-08-07 竞态修复：回填用函数式合并、只填充仍为空的 key——
  // 旧实现 restoreSecrets(loadSettings()) 的快照在用户已输入后到达，
  // 会整体覆盖 state，把刚填的 key 冲掉。
  useEffect(() => {
    let alive = true;
    loadSettingsWithSecrets()
      .then((filled) => {
        if (!alive) return;
        setSettings((s) => {
          const next = structuredClone(s);
          for (const p of next.providers) {
            if (!p.apiKey || p.apiKey.trim() === '') {
              const f = filled.providers.find((x) => x.name === p.name);
              if (f?.apiKey?.trim()) p.apiKey = f.apiKey.trim();
            }
          }
          return next;
        });
      })
      .catch(() => {
        // Key 回填失败不再静默（2026-08-29 走查）：否则已配 Key 的 provider
        // 显示空 Key 字段，用户误以为没配过。
        setSaveError('已配置 Key 回填失败——下方 Key 字段显示为空；保存前请先重开面板确认。');
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion('9.0.1'));
  }, []);

  // 更新检测状态消费 update-store（app 级单例，state/update-store.ts）——
  // 壳行 shell-update-check 的启动自动检查与面板手动检查共享同一状态面：
  // 自动检查发现的新版本，打开面板即见（不再自持 useState 各写各的）。
  // mount 即 markBadgeSeen：用户已看见，入口角标熄灭。
  const updateStatus = useUpdateStore((s) => s.status);
  const updateMsg = useUpdateStore((s) => s.message);
  useEffect(() => {
    useUpdateStore.getState().markBadgeSeen();
  }, []);
  const checkUpdate = useCallback(async () => {
    await useUpdateStore.getState().checkForUpdates({ manual: true });
  }, []);
  const doUpdate = useCallback(async () => {
    await useUpdateStore.getState().downloadAndInstall();
  }, []);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Provider 页独立 dirty：与其他 tab 的全局保存互不牵连
  const [providerDirty, setProviderDirty] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [closeConfirm, setCloseConfirm] = useState(false);
  // 凭据暂存：删除 Provider / 清除 Key 只进 state，保存时才删系统凭据——
  // 用户取消/关闭面板不会丢 Key（P0 修复）。
  const [pendingDeletes, setPendingDeletes] = useState<ProviderId[]>([]);
  const [pendingClears, setPendingClears] = useState<ProviderId[]>([]);
  const [saveVersion, setSaveVersion] = useState(0);

  // LSP 状态（pollCount 供进度展示——30s 黑盒等待可感知）
  const [lspStatus, setLspStatus] = useState<LspData | null>(null);
  const [lspLoading, setLspLoading] = useState(false);
  const [lspPollShown, setLspPollShown] = useState(0);
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  // ── 语言依赖标签页打开时加载 LSP 状态 ──
  const lspLoaded = useRef(false);
  const lspPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lspPollCount = useRef(0);
  const MAX_LSP_POLLS = 15; // 最多 30 秒
  useEffect(() => {
    if (activeTab !== 'languages' || lspLoaded.current) return;
    lspLoaded.current = true;
    setLspLoading(true);

    const fetchStatus = () => {
      typedJsonRpc<{ lsp?: LspData }>('hologram_call', { tool: 'engine_status', args: {} })
        .then((parsed) => {
          if (parsed?.lsp?.servers) {
            setLspStatus(parsed.lsp);
            // 当所有已安装服务器都已确定状态（运行或错误）时停止，
            // 或轮询次数足够时停止。
            lspPollCount.current += 1;
            setLspPollShown(lspPollCount.current);
            const allResolved = parsed.lsp.servers.every((s) => s.available || s.error || !s.installed);
            if ((allResolved || lspPollCount.current >= MAX_LSP_POLLS) && lspPollTimer.current) {
              clearInterval(lspPollTimer.current);
              lspPollTimer.current = null;
            }
          }
        })
        .catch(() => {})
        .finally(() => setLspLoading(false));
    };

    fetchStatus();
    // 每 2 秒轮询一次，直到所有已安装服务器报告最终状态。
    lspPollTimer.current = setInterval(fetchStatus, 2000);
    return () => {
      if (lspPollTimer.current) clearInterval(lspPollTimer.current);
    };
  }, [activeTab]);

  // ── 处理函数 ──
  // 手动落盘（2026-08-07 回退）：任何改动只进 state 并标 dirty，
  // 点「保存」才落盘 + 写系统凭据 + 重建 Agent。自动落盘曾导致设置页
  // 卡死整个软件（每次击键 saveSettings → 通知订阅者 → credential IPC 风暴），已废弃。

  const markDirty = useCallback(() => setDirty(true), []);

  /** 整体替换（添加/删除/切换等单次操作），落盘由「保存」按钮统一负责。 */
  const commit = useCallback(
    (next: AppSettings): void => {
      setSettings(next);
      markDirty();
    },
    [markDirty],
  );

  /** Provider 页专用提交：只标 providerDirty，不污染其他 tab 的全局 dirty。 */
  const commitProvider = useCallback((next: AppSettings): void => {
    setSettings(next);
    setProviderDirty(true);
  }, []);

  /** 立即落盘但不标 dirty——用于非配置类状态（如测试结果）。
   *  B4（2026-08-27）：改为「读盘 → 只改 lastTest → 写回」最小面。原实现
   *  直接落整份面板 state（saveSettings(next)），把所有未保存的
   *  baseUrl/model/maxTokens 暂存改动一并隐性提交——用户点「取消」后改动
   *  早已在盘上，「未保存的更改将丢失」的确认弹窗成了谎言。 */
  const persistProbe = useCallback((name: string, probe: ConnectionProbe): void => {
    // 面板态：只更新该 provider 的 lastTest 展示（不触碰其他暂存字段）
    setSettings((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.name === name ? { ...p, lastTest: probe } : p)),
    }));
    // 磁盘：读盘-改探针-写回，暂存中的配置改动不随探针落盘
    try {
      const disk = loadSettings();
      saveSettings({
        ...disk,
        providers: disk.providers.map((p) => (p.name === name ? { ...p, lastTest: probe } : p)),
      });
    } catch (e) {
      console.warn('[settings] 测试结果落盘失败（仅面板内展示）:', e);
    }
  }, []);

  const stageDelete = useCallback(
    (name: ProviderId) => setPendingDeletes((d) => (d.includes(name) ? d : [...d, name])),
    [],
  );
  const stageClear = useCallback(
    (name: ProviderId) => setPendingClears((c) => (c.includes(name) ? c : [...c, name])),
    [],
  );
  const unstageClear = useCallback((name: ProviderId) => setPendingClears((c) => c.filter((x) => x !== name)), []);

  /* ── 关闭守卫（2026-08 UI 大清扫）────────────────────────────
   * 修复：Esc（useGlobalKeys → esc-layer）/ Ctrl+,（settings/toggle 贡献）此前
   * 直连 dock.closePanel——绕过 dirty 确认，未保存更改静默丢失。守卫注册进
   * dock-store：任何关闭路径（closePanel/togglePanel）先问守卫；dirty 时弹
   * 确认并拦截。确认后的真关闭走 forceClose（先摘守卫再关）。 */
  const dirtyRef = useRef(0); // 1 = 全局 dirty，2 = providerDirty，3 = 双
  dirtyRef.current = (dirty ? 1 : 0) | (providerDirty ? 2 : 0);
  const forceClose = useCallback(() => {
    useDockStore.getState().unregisterCloseGuard('settings');
    onClose();
  }, [onClose]);
  useEffect(() => {
    useDockStore.getState().registerCloseGuard('settings', () => {
      if (dirtyRef.current !== 0) {
        setCloseConfirm(true);
        return false; // 拦截：确认弹层已在路上
      }
      return true;
    });
    return () => {
      // 卸载兜底：确认弹层开着时面板被外力强关（如 escLayer 直调 closePanel 的
      // 历史路径已不存在，防御性保留）——守卫随面板摘除
      useDockStore.getState().unregisterCloseGuard('settings');
    };
  }, []);

  const handleClose = useCallback(() => {
    if (dirty || providerDirty) {
      setCloseConfirm(true);
      return;
    }
    forceClose();
  }, [dirty, providerDirty, forceClose]);

  /** 保存管道：落盘 + 删暂存凭据 + 写新 Key + 重建 Agent。返回是否成功。 */
  const runSavePipeline = useCallback(async (): Promise<boolean> => {
    saveSettings(settings);
    // 1) 先删「清除 Key / 删除 Provider」暂存的系统凭据（removeSecret 幂等、失败静默）
    for (const name of [...new Set([...pendingClears, ...pendingDeletes])]) {
      await removeSecret(name);
    }
    // 2) 再写新 Key（P0-7：写失败必须据实提示）
    const failed = await persistSecrets(settings);
    if (failed.length > 0) {
      setSaveError(
        `API Key 写入系统凭据失败：${failed.join('、')}。\n设置本身已保存，但重启后这些 Key 会丢失，请重试或检查系统加密服务。`,
      );
      return false;
    }
    setPendingClears([]);
    setPendingDeletes([]);
    setLang(settings.display.language);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    if (onSave) onSave();
    return true;
  }, [settings, pendingClears, pendingDeletes, onSave]);

  /** 全局保存（Agent / 显示等 tab） */
  const handleSave = useCallback(async () => {
    const ok = await runSavePipeline();
    if (ok) {
      setDirty(false);
      // runSavePipeline 是全量落盘：Provider 页的暂存改动也会一并持久化，
      // 因此两个 dirty 标志必须同时复位，避免保存条/保存按钮残留假状态。
      setProviderDirty(false);
      setSaveVersion((v) => v + 1);
    }
  }, [runSavePipeline]);

  /** Provider 页独立保存 */
  const handleSaveProviders = useCallback(async () => {
    const ok = await runSavePipeline();
    if (ok) {
      setProviderDirty(false);
      setDirty(false); // 同上：全量落盘，其他 tab 的 dirty 一并复位
      setSaveVersion((v) => v + 1);
    }
  }, [runSavePipeline]);

  const closeMsg =
    dirty && providerDirty
      ? '有未保存的设置与提供方更改，关闭后将全部丢失。确定关闭？'
      : dirty
        ? '有未保存的设置更改，关闭后将丢失。确定关闭？'
        : '有未保存的提供方更改，关闭后将丢失。确定关闭？';

  // ── 渲染 ──

  return (
    <>
      {/* 背板点击关闭（a11y：背板非交互元素本体，键盘路径走面板内按钮/Esc） */}
      <div id="settings-panel-overlay" className="sp-open" onMouseDown={handleClose} aria-hidden="true" />
      <div id="settings-panel" className="sp-open">
        {/* 头部 */}
        <div className="sp-header">
          <span
            className="sp-title"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容为 icons.ts 常量表静态 SVG + 字面量，无外部输入
            dangerouslySetInnerHTML={{ __html: iconHtml('settings', 14) + ' <span class="zh">设置</span>' }}
          />
          <button
            type="button"
            className="sp-close-btn"
            onClick={handleClose}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG，无外部输入
            dangerouslySetInnerHTML={{ __html: iconHtml('close', 14) }}
          />
        </div>

        {/* 标签页 */}
        <div className="sp-tabs">
          {(
            [
              ['provider', 'agent', '提供方'],
              ['agent', 'code', 'Agent'],
              ['display', 'mode-standard', '显示'],
              ['languages', 'code', '语言依赖'],
              ['plugins', 'agent', '插件'],
              ['about', 'info', '关于'],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              type="button"
              key={id}
              className={`sp-tab${activeTab === id ? ' active' : ''}`}
              onClick={() => setActiveTab(id)}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG + 字面量，无外部输入
              dangerouslySetInnerHTML={{ __html: iconHtml(icon, 11) + ' ' + label }}
            />
          ))}
        </div>

        {/* 内容 */}
        <div className="sp-content">
          {/* ═══ Provider 标签页（提供方控制台）═══ */}
          <div
            className="sp-tab-content"
            data-tab="provider"
            style={{ display: activeTab === 'provider' ? '' : 'none' }}
          >
            <ProviderPage
              settings={settings}
              onCommitProvider={commitProvider}
              onPersistProbe={persistProbe}
              onStageDelete={stageDelete}
              onStageClear={stageClear}
              onUnstageClear={unstageClear}
              pendingClears={pendingClears}
              saveVersion={saveVersion}
              providerDirty={providerDirty}
              onSaveProviders={handleSaveProviders}
            />
          </div>

          {/* ═══ Agent 标签页 ═══ */}
          <div className="sp-tab-content" data-tab="agent" style={{ display: activeTab === 'agent' ? '' : 'none' }}>
            <div className="sp-section">
              <div className="sp-section-title">组合 / Composition</div>
              <div className="sp-field">
                <label className="sp-label" htmlFor="sp-preset-select">
                  Preset（行组合预设）
                </label>
                <select
                  id="sp-preset-select"
                  className="sp-input"
                  value={presetSelected}
                  onChange={(e) => {
                    const id = e.target.value;
                    // selectPreset：store 同步 + settings 持久化（S4-1a）。
                    // 装配作用域下次装配生效（新案卷即见）；壳作用域重启生效。
                    selectPreset(id);
                  }}
                >
                  {presetRoster.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.metadata?.name ?? p.id}
                      {p.patch === null ? '（损坏）' : ''}
                    </option>
                  ))}
                </select>
                <div className="sp-hint-sub">
                  生效时机：新 Agent 装配（新案卷）即用新组合；在途案卷保持创建时点的组合。
                  {presetRoster.find((p) => p.id === presetSelected)?.error
                    ? ` 当前 preset 装载失败: ${presetRoster.find((p) => p.id === presetSelected)?.error}`
                    : ''}
                </div>
              </div>
              <div className="sp-field">
                <div className="sp-hint-sub">
                  用户层 patch 状态：
                  {compositionStatus === 'factory' && '出厂组合（无 patch 或被拒）'}
                  {compositionStatus === 'ok' && `已应用（来源: ${compositionPatchOrigin ?? 'roster.patch.yml'}）`}
                  {compositionStatus === 'error' && `被拒——回退出厂组合（${compositionError ?? '未知原因'}）`}
                  ；热重载已启用（改 ~/.lantai/composition/roster.patch.yml 即时生效于新装配）。
                </div>
                {compositionDiagnostics.disabled.length > 0 && (
                  <div className="sp-hint-sub">
                    禁用行（{compositionDiagnostics.disabled.length}）：
                    <code>{compositionDiagnostics.disabled.join(', ')}</code>
                  </div>
                )}
              </div>
            </div>
            <div className="sp-section">
              <div className="sp-section-title">图谱引擎</div>
              <div className="sp-field">
                <label className="sp-label sp-checkbox-label">
                  <input
                    type="checkbox"
                    checked={graphEngineEnabled(settings)}
                    onChange={(e) => {
                      commit({ ...settings, graphEngine: { enabled: e.target.checked } });
                    }}
                  />
                  新工作区默认启用图谱引擎
                </label>
                <div className="sp-hint-sub">
                  关闭 = 新工作区只做纯 Agent 工作区：不分析、无图/简报工具、不监视文件（fs/shell/git
                  照常，内存占用更低）。此为新建工作区时的默认勾选值；已有工作区在首页卡片的
                  「开/关图谱」单独切换（下次进入生效），在途工作区不活拆。
                </div>
              </div>
            </div>
          </div>

          {/* ═══ 显示标签页 ═══ */}
          <div className="sp-tab-content" data-tab="display" style={{ display: activeTab === 'display' ? '' : 'none' }}>
            {/* 语言选项已摘除（2026-08 UI 大清扫：i18n 只覆盖已退役的观测台图例，
                纸面全硬编码中文——假选项误导用户。真有多语言需求时再恢复）。 */}
            <div className="sp-section" style={{ marginTop: 18 }}>
              <div className="sp-section-title">字体缩放 / Font Scale</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="range"
                  name="fontScale"
                  min={0.8}
                  max={2.0}
                  step={0.05}
                  value={settings.display.fontScale}
                  style={{ flex: 1, height: 4, accentColor: 'var(--indigo)' }}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    commit({ ...settings, display: { ...settings.display, fontScale: v } });
                  }}
                />
                <span
                  className="sp-fs-value"
                  style={{
                    fontFamily: 'var(--f-mono)',
                    fontSize: 'calc(11px * var(--font-scale))',
                    color: 'var(--indigo)',
                    minWidth: 40,
                    textAlign: 'right',
                  }}
                >
                  {settings.display.fontScale.toFixed(2)}x
                </span>
              </div>
            </div>
            <div className="sp-hint">缩放所有界面文字。更改后保存即生效（Terminal / 编辑器需重新打开文件）。</div>
          </div>

          {/* ═══ 语言依赖标签页 ═══ */}
          <div
            className="sp-tab-content"
            data-tab="languages"
            style={{ display: activeTab === 'languages' ? '' : 'none' }}
          >
            {lspLoading ? (
              <div className="sp-hint" style={{ padding: 24, textAlign: 'center' }}>
                检测中…（{lspPollShown}/{MAX_LSP_POLLS}）
              </div>
            ) : !lspStatus ? (
              <div className="sp-hint" style={{ padding: 24, textAlign: 'center' }}>
                无法获取语言依赖状态
                <br />
                <small>引擎未响应，请重试</small>
              </div>
            ) : (
              <>
                <div className="sp-section">
                  <div className="sp-section-title">语言服务器状态</div>
                  <div className="sp-hint" style={{ marginBottom: 10 }}>
                    {[
                      lspStatus.available.length > 0 && `${lspStatus.available.length} 运行中`,
                      lspStatus.servers.filter((s) => !s.available && s.installed).length > 0 &&
                        `${lspStatus.servers.filter((s) => !s.available && s.installed).length} 待启动`,
                      lspStatus.servers.filter((s) => !s.available && !s.installed).length > 0 &&
                        `${lspStatus.servers.filter((s) => !s.available && !s.installed).length} 未安装`,
                    ]
                      .filter(Boolean)
                      .join('  ·  ') || '没有检测到已安装的语言服务器'}
                  </div>
                  {lspStatus.servers.map((srv) => {
                    const installed = srv.installed === true;
                    let icon: string, statusText: string, color: string, rowClass: string;
                    if (srv.available) {
                      icon = 'check-circle';
                      statusText = '运行中';
                      color = 'var(--pass)';
                      rowClass = 'running';
                    } else if (installed) {
                      icon = 'alert-circle';
                      statusText = '已安装';
                      color = 'var(--warn)';
                      rowClass = 'installed';
                    } else {
                      icon = 'close';
                      statusText = '未安装';
                      color = 'var(--ink-2)';
                      rowClass = '';
                    }
                    return (
                      <div key={srv.language_id} className={`sp-lsp-card ${rowClass}`}>
                        <span
                          className="sp-lsp-card-icon"
                          style={{ color }}
                          // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG，无外部输入
                          dangerouslySetInnerHTML={{ __html: iconHtml(icon, 13) }}
                        />
                        <div className="sp-lsp-card-body">
                          <div className="sp-lsp-card-header">
                            <span className="lang-name">{srv.language_id}</span>
                            <span className="lang-status" style={{ color }}>
                              {statusText}
                            </span>
                          </div>
                          <div className="sp-lsp-card-meta">
                            <code>{srv.command}</code>
                            &nbsp;·&nbsp; .{srv.extensions.join(', .')}
                          </div>
                          {!srv.available && srv.error && <div className="sp-lsp-card-err">{srv.error}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="sp-section">
                  <button
                    type="button"
                    className="sp-install-toggle"
                    onClick={() => setShowInstallGuide((v) => !v)}
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG + 字面量，无外部输入
                    dangerouslySetInnerHTML={{
                      __html: iconHtml(showInstallGuide ? 'chevron-down' : 'chevron-right', 9) + ' 安装指南',
                    }}
                  />
                  {showInstallGuide && (
                    <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.8 }}>
                      {[
                        ['Python', 'npm install -g pyright'],
                        ['TypeScript', 'npm install -g typescript-language-server typescript'],
                        ['Rust', 'rustup component add rust-analyzer'],
                        ['Go', 'go install golang.org/x/tools/gopls@latest'],
                        ['C/C++', 'scoop install clangd'],
                        ['Java', 'scoop install jdtls'],
                        ['C#', 'dotnet tool install --global OmniSharp'],
                        ['PHP', 'npm install -g intelephense'],
                        ['Kotlin', 'scoop install kotlin-language-server'],
                      ].map(([lang, cmd]) => (
                        <div key={lang} className="sp-install-row">
                          <span className="lang-label">{lang}</span>
                          <code>{cmd}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ═══ 插件标签页（S4-3 安装通道）═══ */}
          <div className="sp-tab-content" data-tab="plugins" style={{ display: activeTab === 'plugins' ? '' : 'none' }}>
            <PluginsPage />
          </div>

          {/* ═══ 关于标签页 ═══ */}
          <div className="sp-tab-content" data-tab="about" style={{ display: activeTab === 'about' ? '' : 'none' }}>
            <div className="sp-section">
              <div className="sp-section-title">兰台 Lantai</div>
              <div className="sp-hint" style={{ marginBottom: 16 }}>
                一张纸上的 Agent 工作台 · 图谱引擎 HoloGram
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '6px 12px', fontSize: 12 }}>
                <span style={{ color: 'var(--ink-2)' }}>版本</span>
                <span style={{ fontFamily: 'var(--f-mono)' }}>{appVersion}</span>
                <span style={{ color: 'var(--ink-2)' }}>许可</span>
                <span>MIT</span>
                <span style={{ color: 'var(--ink-2)' }}>作者</span>
                <span>Wenbing Jing</span>
              </div>
            </div>
            <div className="sp-section">
              <div className="sp-section-title">更新</div>
              <div style={{ marginTop: 8 }}>
                {updateStatus === 'idle' && (
                  <button type="button" className="sp-btn sp-btn-save" onClick={checkUpdate}>
                    检查更新
                  </button>
                )}
                {updateStatus === 'checking' && <span className="sp-hint">检查中…</span>}
                {updateStatus === 'available' && (
                  <div>
                    <div className="sp-hint" style={{ marginBottom: 8 }}>
                      {updateMsg}
                    </div>
                    <button type="button" className="sp-btn sp-btn-save" onClick={doUpdate}>
                      下载并安装
                    </button>
                  </div>
                )}
                {updateStatus === 'downloading' && <span className="sp-hint">{updateMsg}</span>}
                {updateStatus === 'done' && (
                  <div>
                    <span className="sp-hint" style={{ color: 'var(--pass)' }}>
                      {updateMsg}
                    </span>
                    <br />
                    <button
                      type="button"
                      className="sp-btn sp-btn-cancel"
                      style={{ marginTop: 8 }}
                      onClick={checkUpdate}
                    >
                      再检查一次
                    </button>
                  </div>
                )}
                {updateStatus === 'error' && (
                  <div>
                    <span className="sp-hint" style={{ color: 'var(--warn)' }}>
                      检查失败: {updateMsg}
                    </span>
                    <br />
                    <button
                      type="button"
                      className="sp-btn sp-btn-cancel"
                      style={{ marginTop: 8 }}
                      onClick={checkUpdate}
                    >
                      重试
                    </button>
                  </div>
                )}
                <div className="sp-field" style={{ marginTop: 12 }}>
                  <label className="sp-label sp-checkbox-label">
                    <input
                      type="checkbox"
                      checked={autoUpdateCheckEnabled(settings)}
                      onChange={(e) => {
                        commit({ ...settings, updates: { autoCheck: e.target.checked } });
                      }}
                    />
                    启动时自动检查更新
                  </label>
                  <div className="sp-hint-sub">发现新版本时在设置入口显示朱砂角标；关闭后仍可手动检查。</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {saveError && (
          <div className="pp-error-banner">
            <span className="pp-error-text">{saveError}</span>
            <button type="button" className="pp-error-close" onClick={() => setSaveError('')} title="关闭">
              ✕
            </button>
          </div>
        )}

        {/* 底部 */}
        <div className="sp-footer">
          <button type="button" className="sp-btn sp-btn-cancel" onClick={handleClose}>
            取消
          </button>
          {/* Provider tab 用页内「保存 Provider」按钮，全局保存只负责其他 tab */}
          {activeTab !== 'provider' && (
            <button
              type="button"
              className={`sp-btn sp-btn-save${saved ? ' sp-btn-ok' : ''}`}
              disabled={!dirty}
              onClick={handleSave}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: icons.ts 常量表静态 SVG + 字面量，无外部输入
              dangerouslySetInnerHTML={{
                __html: saved ? iconHtml('check-circle', 11) + ' 已保存' : iconHtml('save', 11) + ' 保存',
              }}
            />
          )}
        </div>

        {/* 面板内确认（替换原生 alert/confirm） */}
        <ConfirmDialog
          open={closeConfirm}
          title="放弃未保存更改"
          message={closeMsg}
          confirmLabel="放弃并关闭"
          tone="danger"
          onConfirm={forceClose}
          onCancel={() => setCloseConfirm(false)}
        />
      </div>
    </>
  );
};

// ── 面板根（P3：DockPanel 条件挂载 — 关闭即卸载，重开从 localStorage 重读）──

export function SettingsPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  // 保存成功后只发显式事件；热切换由 main.ts → Workspace.applyAgentConfig 统一处理。
  return (
    <SettingsPanelApp
      onClose={() => closePanel('settings')}
      onSave={() => notifyAgentConfigChanged('settings-saved')}
    />
  );
}
