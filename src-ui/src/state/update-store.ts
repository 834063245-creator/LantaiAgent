// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// update-store — 应用更新的单一事实源（app 级单例，dock-store 同族）。
// 两个写入源共享一份状态面：
//   - 壳行 shell-update-check（启动延迟自动检查，见 shell/rows/update-check.ts）；
//   - 设置面板「关于」tab 的更新节（UpdateSection 消费——自动检查发现的新版本，
//     打开面板即见，不再自持 useState 各写各的）。
// 角标消费面：SessionsHome / PaperPanel 的设置入口按 status === 'available'
// && !badgeDismissed 显示朱砂点；打开设置面板（用户已看见）即熄，换新版本重新亮起。
//
// 状态机（2026-09-26 可见性重构——原实现的 downloading 只显示一句「下载中…」，
// 145 MB 的包全程零反馈）：
//   idle → checking → available → downloading → downloaded → installing → done
//                        ↘ up-to-date                    ↘ error（errorStage 标明阶段）
// 三条口径：
//   ① **下载与安装分离**：插件把两者拆开（download 验签后把字节挂在同一个 Update 句柄
//      的 Rust 资源上，install 再消费它）⇒「下载完成 → 用户点安装」必须共用同一句柄，
//      故 pending 随状态存本 store（进程级单例的第 3 类归属，见 CONVENTIONS §1.10；
//      不进 UI 订阅面，只是句柄寄存）。
//   ② **进度如实**：Content-Length 缺失时 percent 为 null（不知道总量不假装知道）；
//      发布节流 150ms——更新器每 chunk 回调一次，原样 set 会让整面板百 Hz 重渲。
//   ③ **限制如实**：Tauri 更新器不支持断点续传也不支持中止下载（无 Range、无临时
//      文件，整包在内存里）——UI 照实说，不提供假的「取消」按钮。
//
// 模块级可变态归属（CONVENTIONS §1.10）：zustand create 实例 = app 级单例
// （第 3 类「进程级单例」），生命周期 = 应用生命周期，无跨工作区串扰面。

import type { Update } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';
import { createProgressTracker, type ProgressTracker, type UpdateProgress } from './update-progress';

export type UpdateStatus =
  | 'idle' // 未检查（启动早期 / 面板首次打开）
  | 'checking' // 检查中
  | 'up-to-date' // 检查完成：已是最新
  | 'available' // 有新版本（角标 + 面板显示下载按钮）
  | 'downloading' // 下载中（progress 有读数）
  | 'downloaded' // 下载 + 验签完成，等待用户点「安装」
  | 'installing' // 已拉起安装程序（Windows：本进程随即 exit(0)）
  | 'done' // 收尾（非 Windows 或无重启平台；Windows 上一般看不到）
  | 'error'; // 失败（errorStage 标明阶段；面板可见 + 重试按钮；角标不亮）

/** 失败阶段——重试动作按阶段分派（检查 / 下载 / 安装三处失败的处理完全不同）。 */
export type UpdateErrorStage = 'check' | 'download' | 'install';

/** 新版本元信息（全部来自远端发布清单，展示用；不可信数据只作文本呈现）。 */
export interface UpdateInfo {
  currentVersion: string;
  version: string;
  /** RFC3339（远端 pub_date）；缺失 = null */
  date: string | null;
  /** 发布说明（远端 notes，即 changelog 正文）；缺失 = null */
  notes: string | null;
}

/** 下载来源（远端清单里本平台条目的直链——与更新器实际取用同一份数据）。 */
export interface UpdateSource {
  url: string | null;
  host: string | null;
  /** 清单里带签名（Tauri 用 minisign，公钥编译在壳里） */
  signed: boolean;
}

interface UpdateState {
  status: UpdateStatus;
  /** 可用新版本号（status === 'available' 时非空；角标 tooltip 消费） */
  version: string | null;
  /** 状态文案（一句话说明；进度细节走 progress，不塞进 message） */
  message: string;
  /** 用户是否已看过本次角标（打开设置面板即置 true；换版本号重新亮起） */
  badgeDismissed: boolean;
  /** 新版本元信息（available 起非空，供面板渲染） */
  info: UpdateInfo | null;
  /** 下载来源（available 起非空） */
  source: UpdateSource | null;
  /** 下载进度（downloading / downloaded 有值） */
  progress: UpdateProgress | null;
  /** 失败阶段（status === 'error' 时非空） */
  errorStage: UpdateErrorStage | null;
  /** 当前 Update 句柄——下载/安装分离的载体，也是资源表释放的责任人 */
  pending: Update | null;

  /** 检查更新（manual=true 为设置面板手动路径）。全路径内部 catch——
   *  自动检查失败静默留痕（console.warn + error 态），不打扰用户。 */
  checkForUpdates: (opts?: { manual?: boolean }) => Promise<void>;
  /** 下载安装包（不安装）：完成即验签通过，停在 downloaded 等用户点安装。 */
  startDownload: () => Promise<void>;
  /** 安装已下载的包（Windows：拉起安装程序后本进程退出）。 */
  installDownloaded: () => Promise<void>;
  /** 用户已看过角标（SettingsPanel mount 时调用）——角标熄灭。 */
  markBadgeSeen: () => void;
}

/** 进度发布节流：更新器每 chunk 回调一次，原样 set 会让整面板百 Hz 重渲。 */
const PROGRESS_PUBLISH_MS = 150;

function errText(e: unknown): string {
  return e instanceof Error ? e.message || String(e) : String(e);
}

/** 释放 Update 句柄（Rust 资源表的记录不会自己消失）。失败只留痕：释放不上不影响用户。 */
async function closeQuietly(update: Update | null): Promise<void> {
  if (!update) return;
  try {
    await update.close();
  } catch (e) {
    console.warn('[update] 释放更新句柄失败:', e);
  }
}

/**
 * 从远端清单里挑本平台的条目（只用于「下载来源」展示——真正的目标由 Rust 侧
 * bundle type 决定）。优先 NSIS：这是 Windows 主安装通道；再退到非 MSI 条目。
 */
function pickPlatformEntry(rawJson: Record<string, unknown> | undefined): { url: string; signed: boolean } | null {
  const platforms = rawJson?.platforms;
  if (!platforms || typeof platforms !== 'object') return null;
  const entries: Array<{ key: string; url: string; signed: boolean }> = [];
  for (const [key, value] of Object.entries(platforms as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const { url, signature } = value as { url?: unknown; signature?: unknown };
    if (typeof url !== 'string' || url.length === 0) continue;
    entries.push({ key, url, signed: typeof signature === 'string' && signature.length > 0 });
  }
  if (entries.length === 0) return null;
  const pick =
    entries.find((e) => e.key.endsWith('-nsis')) ?? entries.find((e) => !e.key.endsWith('-msi')) ?? entries[0];
  return { url: pick.url, signed: pick.signed };
}

function parseSource(rawJson: Record<string, unknown> | undefined): UpdateSource {
  const entry = pickPlatformEntry(rawJson);
  if (!entry) return { url: null, host: null, signed: false };
  let host: string | null = null;
  try {
    host = new URL(entry.url).host;
  } catch {
    // 远端给的 URL 解析不了 = 来源未知（不是下载失败：下载走壳层自己的解析）
    host = null;
  }
  return { url: entry.url, host, signed: entry.signed };
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  version: null,
  message: '',
  badgeDismissed: false,
  info: null,
  source: null,
  progress: null,
  errorStage: null,
  pending: null,

  checkForUpdates: async (opts) => {
    const manual = opts?.manual ?? false;
    set({ status: 'checking', message: '', errorStage: null });
    try {
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const update = await checkUpdate();
      // 上一轮句柄先释放（重查会换 rid；不释放就是资源表泄漏）
      const prev = get().pending;
      if (prev && prev !== update) void closeQuietly(prev);
      if (update) {
        const prevState = get();
        // 同版本号重查且用户已看过 → 角标保持熄灭；新版本号 → 重新亮起
        const dismissed = update.version === prevState.version ? prevState.badgeDismissed : false;
        set({
          status: 'available',
          version: update.version,
          message: `新版本 ${update.version} 可用`,
          badgeDismissed: dismissed,
          info: {
            currentVersion: update.currentVersion,
            version: update.version,
            date: update.date ?? null,
            notes: update.body ?? null,
          },
          source: parseSource(update.rawJson),
          progress: null,
          pending: update,
        });
      } else {
        set({
          status: 'up-to-date',
          version: null,
          message: '已是最新版本',
          info: null,
          source: null,
          progress: null,
          pending: null,
        });
      }
    } catch (e) {
      const msg = errText(e);
      // 自动检查是 best-effort：失败只留痕（console + error 态供面板展示），不弹提示
      if (!manual) console.warn('[update] 启动自动检查失败:', msg);
      set({ status: 'error', errorStage: 'check', message: msg });
    }
  },

  startDownload: async () => {
    set({ status: 'downloading', message: '正在准备下载…', errorStage: null, progress: null });
    let tracker: ProgressTracker | null = null;
    try {
      // 下载前重查一次：陈旧的句柄可能指向已被覆盖的发布产物（URL 与签名都会失效）。
      // 拿到的句柄同时是「下载好的字节」的宿主，安装阶段必须沿用同一个（②）。
      const { check: checkUpdate } = await import('@tauri-apps/plugin-updater');
      const fresh = await checkUpdate();
      const prev = get().pending;
      if (prev && prev !== fresh) void closeQuietly(prev);
      if (!fresh) {
        set({
          status: 'error',
          errorStage: 'download',
          message: '更新信息已过期——远端已没有该版本，请重新检查',
          pending: null,
        });
        return;
      }
      set({ pending: fresh, version: fresh.version, message: `正在下载 ${fresh.version}…` });

      const snapshotTracker = createProgressTracker();
      tracker = snapshotTracker;
      let publishedAt = 0;
      await fresh.download((ev) => {
        const now = Date.now();
        const snapshot = snapshotTracker.push(ev, now);
        if (ev.event === 'Finished' || now - publishedAt >= PROGRESS_PUBLISH_MS) {
          publishedAt = now;
          set({ progress: snapshot });
        }
      });
      set({
        status: 'downloaded',
        progress: snapshotTracker.push({ event: 'Finished' }, Date.now()),
        message: '下载完成，安装包已通过内置公钥校验',
      });
    } catch (e) {
      // 中止/失败时补最后读数：进度是按 150ms 节流发布的，失败常落在窗口内——
      // 不补的话面板会显示比实际少一截（「已接收 xx MB」是续传限制的取证）。
      if (tracker) set({ progress: tracker.snapshot() });
      set({ status: 'error', errorStage: 'download', message: errText(e) });
    }
  },

  installDownloaded: async () => {
    const update = get().pending;
    if (!update) {
      set({ status: 'error', errorStage: 'install', message: '安装包句柄已失效，请重新下载' });
      return;
    }
    set({ status: 'installing', message: '正在启动安装程序…兰台即将退出', errorStage: null });
    try {
      // Windows：写出临时安装器 → ShellExecuteW 拉起（/UPDATE 参数）→ 本进程 exit(0)。
      // 能走到下一行 = 安装程序已接管（非 Windows 或无重启平台）。
      await update.install();
      set({ status: 'done', message: '安装程序已启动' });
    } catch (e) {
      set({ status: 'error', errorStage: 'install', message: errText(e) });
    }
  },

  markBadgeSeen: () => {
    if (get().status === 'available') set({ badgeDismissed: true });
  },
}));
