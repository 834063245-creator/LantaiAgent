// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// provider 配置文件热重载 watcher —— 监听 providers_file()（`~/.lantai/providers.yml`，
// `HOLOGRAM_PROVIDERS_FILE` 可重定位）的 mtime 变更 → emit `providers:changed`
// 事件（载荷 = 字符串 reason："modified" / "removed"，与 composition:changed 同形）。
//
// 为什么只做这一件事（语义边界）：
//   - provider「配方」由设置页剪贴板 JSON 改为磁盘 YAML 单文件统管：人可手写、
//     agent 可读写、改动热生效。壳侧只负责「这个文件变了」这一个事实——读文件、
//     解析 YAML、重建 provider 全在前端（本模块不认识 YAML，也不碰文件内容）；
//   - 只监听这一个文件：相邻路径（providers.yml.bak / providers/ 子目录）变更
//     不触发——事件面窄，前端重读才敢幂等；
//   - mtime 轮询（composition_watcher / workspace watcher 同款技术；notify crate
//     不在依赖树），1s 轮询 + 1s settle 去抖——配置文件是低频编辑对象，轮询成本
//     可忽略。去抖/存在性判定在 WatchState（与 composition_watcher **共用同一份**
//     状态机与 file_mtime——两条通道事件语义逐字相同，不复制第二份）；
//   - 失败可见：emit 失败 eprintln（不静默）。
//
// 测试隔离：HOLOGRAM_PROVIDERS_FILE 环境变量，真源 = plugin_assets::providers_file_public。
// env 是进程级变量，覆盖类断言只在 plugin_assets 内设一次（本模块测试不碰 env，
// 只钉 mtime 检测与事件语义——避免并行测试互相 clobber）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::composition_watcher::{file_mtime, WatchState};

/// watcher 线程共享的运行标志。
pub(crate) struct ProvidersWatcher {
    running: std::sync::Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for ProvidersWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

impl ProvidersWatcher {
    /// 启动 provider 配置 watcher（幂等：重复调用先停旧线程）。
    pub(crate) fn start(app_handle: AppHandle) -> Self {
        let running = std::sync::Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let thread = std::thread::spawn(move || watch_loop(app_handle, flag));
        Self { running, thread: Some(thread) }
    }

    /// 停止 watcher（幂等；2s 优雅退出后分离——composition watcher 同款）。
    pub(crate) fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                if handle.is_finished() {
                    let _ = handle.join();
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// 监听循环：providers.yml 的 mtime 变化（1s 轮询 + 1s settle 去抖）。
/// 决策逻辑在 WatchState（纯状态机——可单测）；AppHandle 发射半边留在本函数
/// （Tauri 运行时之外不可测）。
fn watch_loop(app_handle: AppHandle, running: std::sync::Arc<AtomicBool>) {
    let path = providers_file_path();
    let mut state = WatchState::new(file_mtime(&path));
    let debounce = Duration::from_secs(1);
    while running.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_secs(1));
        if !running.load(Ordering::SeqCst) {
            break;
        }
        let current = file_mtime(&path);
        if let Some(reason) = state.poll(current, std::time::Instant::now(), debounce) {
            // 事件载荷：触发原因（文件修改/删除）——前端重读幂等，
            // 载荷仅作诊断呈现。
            if let Err(e) = app_handle.emit("providers:changed", reason) {
                eprintln!("[providers-watcher] emit providers:changed 失败: {e}");
            }
        }
    }
}

/// providers.yml 路径（plugin_assets 单一真源——env 覆盖与默认落点都在那里，
/// 本模块不重算 home）。
fn providers_file_path() -> PathBuf {
    crate::plugin_assets::providers_file_public()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 真文件驱动：file_mtime + WatchState + reason 映射（providers:changed
    //     载荷契约——前端据 reason 决定"重读配方"还是"配方没了"）──

    /// 新建 → modified，删除 → removed（同一条通道两种 reason）。
    #[test]
    fn providers_file_change_fires_modified_then_removed() {
        let tmp = std::env::temp_dir()
            .join(format!("lantai_providers_watch_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("providers.yml");
        // 初始不存在 → None（首次出现就是变更）
        let mut s = WatchState::new(file_mtime(&file));
        let t0 = std::time::Instant::now();

        // 人/agent 写入 → 变化当轮不发射，静默满 1s 后发一次 modified
        std::fs::write(&file, b"providers:\n  - id: deepseek\n").unwrap();
        assert_eq!(s.poll(file_mtime(&file), t0, Duration::from_secs(1)), None, "变化当轮不发射");
        assert_eq!(
            s.poll(file_mtime(&file), t0 + Duration::from_millis(1100), Duration::from_secs(1)),
            Some("modified")
        );

        // 删除 → 同样是一条变更，发 removed
        std::fs::remove_file(&file).unwrap();
        assert_eq!(
            s.poll(file_mtime(&file), t0 + Duration::from_millis(1200), Duration::from_secs(1)),
            None
        );
        assert_eq!(
            s.poll(file_mtime(&file), t0 + Duration::from_millis(2400), Duration::from_secs(1)),
            Some("removed")
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── WatchState 事件语义（状态机与 composition_watcher 共用同一份实现；
    //     这组用例在 providers 通道边界把语义再钉一遍——reason 取值本身就是
    //     providers:changed 的载荷契约，AppHandle 发射半边在 Tauri 运行时之外
    //     不可测）──

    /// 无变化 → 永不发射（静默轮询零噪声）。
    #[test]
    fn watch_state_no_change_never_fires() {
        let mut s = WatchState::new(Some(100));
        let t0 = std::time::Instant::now();
        for tick in 0..5 {
            assert_eq!(
                s.poll(Some(100), t0 + Duration::from_secs(tick), Duration::from_secs(1)),
                None
            );
        }
    }

    /// 修改：变化 → 去抖窗口内不发射 → 静默满 1s 后发射一次（reason=modified）。
    #[test]
    fn watch_state_modified_fires_after_debounce() {
        let mut s = WatchState::new(Some(100));
        let t0 = std::time::Instant::now();
        // t=0：变化发生
        assert_eq!(s.poll(Some(200), t0, Duration::from_secs(1)), None, "变化当轮不发射");
        // t=0.5s：窗口内（编辑器连发的第二次写——mtime 未再变）
        assert_eq!(s.poll(Some(200), t0 + Duration::from_millis(500), Duration::from_secs(1)), None);
        // t=1.1s：静默期满 → 发射 modified
        assert_eq!(
            s.poll(Some(200), t0 + Duration::from_millis(1100), Duration::from_secs(1)),
            Some("modified")
        );
        // t=2s：无新变化 → 不再重复发射
        assert_eq!(s.poll(Some(200), t0 + Duration::from_secs(2), Duration::from_secs(1)), None);
    }

    /// 删除：mtime → None 也是变化 → 静默后发射 removed。
    #[test]
    fn watch_state_removed_fires_after_debounce() {
        let mut s = WatchState::new(Some(100));
        let t0 = std::time::Instant::now();
        assert_eq!(s.poll(None, t0, Duration::from_secs(1)), None);
        assert_eq!(
            s.poll(None, t0 + Duration::from_millis(1100), Duration::from_secs(1)),
            Some("removed")
        );
    }

    /// 新建：None → Some 也是变化 → modified。
    #[test]
    fn watch_state_created_fires_modified() {
        let mut s = WatchState::new(None);
        let t0 = std::time::Instant::now();
        assert_eq!(s.poll(Some(50), t0, Duration::from_secs(1)), None);
        assert_eq!(
            s.poll(Some(50), t0 + Duration::from_millis(1100), Duration::from_secs(1)),
            Some("modified")
        );
    }

    /// 连续变化重置去抖窗口（编辑器保存风暴 → 只在最终静默后发一次）。
    #[test]
    fn watch_state_rapid_changes_reset_debounce() {
        let mut s = WatchState::new(Some(100));
        let t0 = std::time::Instant::now();
        // t=0 变化 → t=0.9 再变（窗口重置）→ t=1.5 仍在扩展后的窗口内
        assert_eq!(s.poll(Some(200), t0, Duration::from_secs(1)), None);
        assert_eq!(
            s.poll(Some(300), t0 + Duration::from_millis(900), Duration::from_secs(1)),
            None
        );
        assert_eq!(
            s.poll(Some(300), t0 + Duration::from_millis(1500), Duration::from_secs(1)),
            None,
            "窗口被重置——1.5s 仍不发射"
        );
        // t=2.0：距最后变化 1.1s → 发射
        assert_eq!(
            s.poll(Some(300), t0 + Duration::from_millis(2000), Duration::from_secs(1)),
            Some("modified")
        );
    }

    /// 发射后重新武装：后续同 mtime 轮询零发射；再次变化重新走全流程。
    #[test]
    fn watch_state_rearms_after_fire() {
        let mut s = WatchState::new(Some(100));
        let t0 = std::time::Instant::now();
        assert_eq!(s.poll(Some(200), t0, Duration::from_secs(1)), None);
        assert_eq!(
            s.poll(Some(200), t0 + Duration::from_millis(1100), Duration::from_secs(1)),
            Some("modified")
        );
        // 静默期：同 mtime 不发射
        for tick in 2..4 {
            assert_eq!(
                s.poll(Some(200), t0 + Duration::from_secs(tick), Duration::from_secs(1)),
                None
            );
        }
        // 新变化 → 全流程重走
        assert_eq!(s.poll(Some(300), t0 + Duration::from_secs(4), Duration::from_secs(1)), None);
        assert_eq!(
            s.poll(Some(300), t0 + Duration::from_millis(5100), Duration::from_secs(1)),
            Some("modified")
        );
    }
}
