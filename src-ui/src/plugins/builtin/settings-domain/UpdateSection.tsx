// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置面板「关于」tab 的更新节（产物包内组件）。
//
// 为什么独立成件：下载进度按 ~150ms 节流发布，订阅面必须只有这一节——
// SettingsPanel 是 940+ 行组件，让它跟着 4-7 Hz 重渲是纯浪费。
//
// 消费面 = state/update-store（app 级单例，经包内 './host' 宿主桥取真实例；
// useUpdateStore / autoUpdateCheckEnabled 都是既有 faceDeps 键 ⇒ 不新增宿主面键、
// 宿主面指纹不变）。本件不自己调插件：检查 / 下载 / 安装全在 store 里，
// 这里只渲染状态与派发动作（单一事实源，两个入口共享同一份进度）。
//
// 三条如实（配 store 里那套状态机）：
//   ① 进度不知道就不知道：无 Content-Length 时显示已下载量 + 不确定条，不假装百分比；
//   ② 安装是用户按的：下载完成停在「立即安装并重启」，不偷偷装；
//   ③ 限制如实说：Tauri 更新器不支持断点续传，中断后重试从 0 开始（不提供假的取消按钮）；
//      已下载的包只活在本次运行内（内存），退出应用后要重下。

import { useCallback } from 'react';
import type { AppSettings } from './host';
import { autoUpdateCheckEnabled, useUpdateStore } from './host';
import { formatBytes, formatEta, formatReleaseDate, formatSpeed } from './update-format';

interface UpdateSectionProps {
  /** 壳层报告的当前版本（检查前也要能显示） */
  currentVersion: string;
  settings: AppSettings;
  onAutoCheckChange: (enabled: boolean) => void;
}

/** 失败阶段 → 面板文案（检查 / 下载 / 安装的处理完全不同，别都叫「更新失败」）。 */
function stageLabel(stage: string | null): string {
  if (stage === 'download') return '下载';
  if (stage === 'install') return '安装';
  return '检查更新';
}

export function UpdateSection({ currentVersion, settings, onAutoCheckChange }: UpdateSectionProps) {
  const status = useUpdateStore((s) => s.status);
  const message = useUpdateStore((s) => s.message);
  const info = useUpdateStore((s) => s.info);
  const source = useUpdateStore((s) => s.source);
  const progress = useUpdateStore((s) => s.progress);
  const errorStage = useUpdateStore((s) => s.errorStage);
  /** 只用来判「安装失败后手上还有没有已下载的包」——有才给「重试安装」，否则重试会变成重下。 */
  const hasPending = useUpdateStore((s) => s.pending) != null;

  const check = useCallback(() => {
    void useUpdateStore.getState().checkForUpdates({ manual: true });
  }, []);
  const download = useCallback(() => {
    void useUpdateStore.getState().startDownload();
  }, []);
  const install = useCallback(() => {
    void useUpdateStore.getState().installDownloaded();
  }, []);
  /** 重试按失败阶段分派：安装失败且手上还有已下载的包 → 重试安装，不白重下。 */
  const retry = useCallback(() => {
    const state = useUpdateStore.getState();
    if (state.errorStage === 'install' && state.pending) void state.installDownloaded();
    else if (state.errorStage === 'download') void state.startDownload();
    else void state.checkForUpdates({ manual: true });
  }, []);

  const percent = progress?.percent ?? null;
  const downloaded = progress?.downloadedBytes ?? 0;
  const totalBytes = progress?.totalBytes ?? null;

  return (
    <div className="sp-section">
      <div className="sp-section-title">更新</div>
      <div className="sp-upd">
        {status === 'idle' && (
          <button type="button" className="sp-btn sp-btn-save" onClick={check}>
            检查更新
          </button>
        )}

        {status === 'checking' && <span className="sp-hint">检查中…（读取远端发布清单）</span>}

        {status === 'up-to-date' && (
          <>
            <div className="sp-upd-head">
              <span className="sp-upd-badge sp-upd-badge-ok">已是最新</span>
              <span className="sp-hint">当前版本 {currentVersion}</span>
            </div>
            <button type="button" className="sp-btn sp-btn-cancel" onClick={check}>
              再检查一次
            </button>
          </>
        )}

        {status === 'available' && (
          <>
            <div className="sp-upd-head">
              <span className="sp-upd-badge">新版本 {info?.version ?? '可用'}</span>
              <span className="sp-hint">当前版本 {info?.currentVersion ?? currentVersion}</span>
            </div>
            <dl className="sp-upd-meta">
              <dt>发布时间</dt>
              <dd>{formatReleaseDate(info?.date)}</dd>
              <dt>安装包大小</dt>
              <dd>下载开始时由发布方告知</dd>
              <dt>下载来源</dt>
              <dd>{source?.host ?? '未知'}</dd>
              <dt>完整性校验</dt>
              <dd>{source?.signed ? 'minisign 签名（内置公钥）' : '内置公钥验签'}</dd>
            </dl>
            {source?.url && (
              <div className="sp-upd-url" title={source.url}>
                {source.url}
              </div>
            )}
            {info?.notes && (
              <details className="sp-upd-notes">
                <summary>更新说明</summary>
                {/* ponytail: pre-wrap 直出远端 notes（纯文本），不引 Markdown 渲染器——
                    更新说明是发布方文本，进不了纸面渲染通道，也不值得为它开一条 */}
                <pre>{info.notes}</pre>
              </details>
            )}
            <button type="button" className="sp-btn sp-btn-save" onClick={download}>
              下载更新
            </button>
            <div className="sp-hint-sub">下载在兰台后端进行，可关闭本面板继续用；下载完成后由你点「安装」。</div>
          </>
        )}

        {status === 'downloading' && (
          <>
            <div className="sp-upd-head">
              <span className="sp-upd-badge">下载中{info?.version ? ` · ${info.version}` : ''}</span>
            </div>
            <div
              className="sp-upd-bar"
              role="progressbar"
              aria-label="更新包下载进度"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(percent == null
                ? { 'aria-valuetext': `已下载 ${formatBytes(downloaded)}` }
                : { 'aria-valuenow': Math.round(percent) })}
            >
              <div
                className={`sp-upd-bar-fill${percent == null ? ' is-unknown' : ''}`}
                style={percent == null ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            </div>
            <div className="sp-upd-stats">
              <span className="sp-upd-stat-em">{percent == null ? '下载中' : `${percent.toFixed(1)}%`}</span>
              <span>
                {formatBytes(downloaded)}
                {totalBytes != null ? ` / ${formatBytes(totalBytes)}` : ''}
              </span>
              <span>{formatSpeed(progress?.bytesPerSecond)}</span>
              <span>{formatEta(progress?.etaSeconds)}</span>
            </div>
            <div className="sp-hint-sub">
              来源 {source?.host ?? '未知'}。关掉本面板不会中断下载；更新器不支持断点续传， 中断后重试将从 0 开始。
            </div>
          </>
        )}

        {status === 'downloaded' && (
          <>
            <div className="sp-upd-head">
              <span className="sp-upd-badge sp-upd-badge-ok">下载完成 · 签名已校验</span>
              <span className="sp-hint">{formatBytes(totalBytes ?? downloaded)}</span>
            </div>
            <button type="button" className="sp-btn sp-btn-save" onClick={install}>
              立即安装并重启
            </button>
            {/* 不给「重新检查」：重查会换句柄、连同已下载的包一起释放（145 MB 白下）。
                要稍后装就关掉面板——包在本次运行内留着。 */}
            <div className="sp-hint-sub">
              安装会退出兰台并拉起安装程序（约 1-2 分钟，期间请勿断电）。也可以先关掉面板继续干活，
              稍后回来再点安装——已下载的包只保留在本次运行内，退出应用后需重新下载。
            </div>
          </>
        )}

        {status === 'installing' && <span className="sp-hint">{message}</span>}
        {status === 'done' && <span className="sp-hint sp-upd-ok">{message}</span>}

        {status === 'error' && (
          <>
            <div className="sp-hint sp-upd-err">
              {stageLabel(errorStage)}失败：{message}
            </div>
            {errorStage === 'download' && downloaded > 0 && (
              <div className="sp-hint-sub">
                已接收 {formatBytes(downloaded)}；更新器不支持断点续传，重试将从 0 开始。
              </div>
            )}
            <button type="button" className="sp-btn sp-btn-cancel" onClick={retry}>
              {errorStage === 'install' && hasPending ? '重试安装' : errorStage === 'download' ? '重新下载' : '重试'}
            </button>
          </>
        )}

        <div className="sp-field">
          <label className="sp-label sp-checkbox-label">
            <input
              type="checkbox"
              checked={autoUpdateCheckEnabled(settings)}
              onChange={(e) => onAutoCheckChange(e.target.checked)}
            />
            启动时自动检查更新
          </label>
          <div className="sp-hint-sub">发现新版本时在设置入口显示朱砂角标；关闭后仍可手动检查。</div>
        </div>
      </div>
    </div>
  );
}
