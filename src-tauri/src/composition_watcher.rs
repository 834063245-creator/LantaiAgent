// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 组合层热重载 watcher（S4-2）—— 监听 ~/.lantai/composition/ 根级
// roster.patch.yml 变更 → emit composition:changed 事件（前端 patch-loader
// 重跑 reload，设计件 §2.5）。
//
// 语义边界（设计件 §2.5「作用域」）：
//   - 只对根级 roster.patch.yml 触发事件——preset 文件（presets/ 子树）变更
//     不自动重解析（在途会话组合本就冻结；preset 切换是显式动作 = 下次解析
//     即重扫），文档如实声明；
//   - mtime 轮询（workspace watcher 同款技术；notify crate 未在依赖树），
//     1s 轮询 + 1s settle 去抖——patch 文件是低频编辑对象，轮询成本可忽略；
//   - 失败可见：emit 失败 eprintln（不静默）。
//
// 测试隔离：HOLOGRAM_COMPOSITION_ROOT 环境变量与 plugin_assets 同源
// （composition_root()），watcher 测试用临时目录覆盖。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// watcher 线程共享的运行标志。
pub(crate) struct CompositionWatcher {
    running: std::sync::Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for CompositionWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

impl CompositionWatcher {
    /// 启动组合层 watcher（幂等：重复调用先停旧线程）。
    pub(crate) fn start(app_handle: AppHandle) -> Self {
        let running = std::sync::Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let thread = std::thread::spawn(move || watch_loop(app_handle, flag));
        Self { running, thread: Some(thread) }
    }

    /// 停止 watcher（幂等；2s 优雅退出后分离——workspace watcher 同款）。
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

/// 监听循环：根级 roster.patch.yml 的 mtime 变化（1s 轮询 + 1s settle 去抖）。
/// 决策逻辑在 WatchState（纯状态机——可单测；S4-2 验收条款「watcher 事件
/// 语义」的测试面），AppHandle 发射半边留在本函数（Tauri 运行时之外不可测）。
fn watch_loop(app_handle: AppHandle, running: std::sync::Arc<AtomicBool>) {
    let patch_path = root_patch_path();
    let mut state = WatchState::new(file_mtime(&patch_path));
    let debounce = Duration::from_secs(1);
    while running.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_secs(1));
        if !running.load(Ordering::SeqCst) {
            break;
        }
        let current = file_mtime(&patch_path);
        if let Some(reason) = state.poll(current, std::time::Instant::now(), debounce) {
            // 事件载荷：触发原因（patch 修改/删除）——前端 reload 幂等，
            // 载荷仅作诊断呈现。
            if let Err(e) = app_handle.emit("composition:changed", reason) {
                eprintln!("[composition-watcher] emit composition:changed 失败: {e}");
            }
        }
    }
}

/// watcher 决策状态机（S4-2 事件语义，纯逻辑可单测）：
/// mtime 变化 → 进入 pending；debounce 窗口静默后 → 发射一次（reason 按
/// 当前存在性区分 modified/removed）；窗口内连续变化重置去抖（编辑器保存
/// 常连发多次写——只在静默后发一次，避免 reload 风暴）；发射后回到静默，
/// 无新变化不再重复发射。
///
/// 共用面（providers.yml 统管通道）：`providers_watcher` 的 mtime 轮询 +
/// 去抖语义与此**逐字相同**（1s 轮询 + 1s settle，载荷同形），故本状态机
/// 与 `file_mtime` 提为 `pub(crate)` 供其复用——不复制第二份状态机。
pub(crate) struct WatchState {
    last_mtime: Option<u64>,
    pending: bool,
    last_change_at: Option<std::time::Instant>,
}

impl WatchState {
    pub(crate) fn new(initial_mtime: Option<u64>) -> Self {
        Self { last_mtime: initial_mtime, pending: false, last_change_at: None }
    }

    /// 一次轮询的转移。返回 Some(reason) = 本轮应发射变更事件
    /// （composition:changed / providers:changed——载荷取同一对取值）。
    pub(crate) fn poll(
        &mut self,
        current: Option<u64>,
        now: std::time::Instant,
        debounce: Duration,
    ) -> Option<&'static str> {
        if current != self.last_mtime {
            self.last_mtime = current;
            self.pending = true;
            self.last_change_at = Some(now);
        }
        let settled = self
            .last_change_at
            .map(|t| now.duration_since(t) >= debounce)
            .unwrap_or(false);
        if self.pending && settled {
            self.pending = false;
            self.last_change_at = None;
            Some(if current.is_some() { "modified" } else { "removed" })
        } else {
            None
        }
    }
}

/// 根级 patch 路径（composition_root 来自 plugin_assets——单一事实源）。
fn root_patch_path() -> PathBuf {
    crate::plugin_assets::composition_root_public().join("roster.patch.yml")
}

/// 文件 mtime（不存在/不可读 = None——删除也是变更事件）。
/// 共用面：providers_watcher 同用（见 WatchState 注）。
pub(crate) fn file_mtime(path: &std::path::Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    modified.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// watcher 事件语义（纯函数面）：mtime 变化检测 + settle 判定。
    /// （完整 AppHandle emit 面在 Tauri 运行时之外不可测——wl 层的
    /// composition_http_end_to_end 已覆盖通道；此处钉检测原语。）
    #[test]
    fn file_mtime_detects_changes() {
        let tmp = std::env::temp_dir().join(format!("hologram_comp_watch_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("roster.patch.yml");
        // 不存在 → None
        assert_eq!(file_mtime(&file), None);
        // 创建 → Some
        std::fs::write(&file, b"tools: []\n").unwrap();
        let t0 = file_mtime(&file);
        assert!(t0.is_some());
        // 同内容快速重写——Windows mtime 秒级精度下可能相同；用显式不同
        // mtime 的“删除→重建”路径验证变化检测
        std::fs::remove_file(&file).unwrap();
        assert_eq!(file_mtime(&file), None); // 删除 = None（变更事件）
        std::thread::sleep(Duration::from_millis(1100));
        std::fs::write(&file, b"tools:\n  - id: builtin/wait\n    disabled: true\n").unwrap();
        let t1 = file_mtime(&file);
        assert!(t1.is_some());
        assert_ne!(t0, t1, "重建后 mtime 应变化（1.1s 间隔绕开秒级精度）");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// root_patch_path：经 HOLOGRAM_COMPOSITION_ROOT 测试隔离生效。
    #[test]
    fn root_patch_path_respects_env() {
        let tmp = std::env::temp_dir().join(format!("hologram_comp_watch_path_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("HOLOGRAM_COMPOSITION_ROOT", &tmp);
        let p = root_patch_path();
        assert_eq!(p, tmp.join("roster.patch.yml"));
        std::env::remove_var("HOLOGRAM_COMPOSITION_ROOT");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── WatchState 事件语义（S4-2 验收条款：watcher 事件语义——决策状态机
    //     的完整钉面；AppHandle 发射半边在 Tauri 运行时之外不可测）──

    /// 无变化 → 永不发射（静默轮询零噪声）。
    #[test]
    fn watch_state_no_change_never_fires() {
        let mut s = WatchState::new(Some(100));
        let t0 = std::time::Instant::now();
        for tick in 0..5 {
            assert_eq!(s.poll(Some(100), t0 + Duration::from_secs(tick), Duration::from_secs(1)), None);
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
        assert_eq!(s.poll(None, t0 + Duration::from_millis(1100), Duration::from_secs(1)), Some("removed"));
    }

    /// 新建：None → Some 也是变化 → modified。
    #[test]
    fn watch_state_created_fires_modified() {
        let mut s = WatchState::new(None);
        let t0 = std::time::Instant::now();
        assert_eq!(s.poll(Some(50), t0, Duration::from_secs(1)), None);
        assert_eq!(s.poll(Some(50), t0 + Duration::from_millis(1100), Duration::from_secs(1)), Some("modified"));
    }

    /// 连续变化重置去抖窗口（编辑器保存风暴 → 只在最终静默后发一次）。
    #[test]
    fn watch_state_rapid_changes_reset_debounce() {
        let mut s = WatchState::new(Some(100));
        let t0 = std::time::Instant::now();
        // t=0 变化 → t=0.9 再变（窗口重置）→ t=1.5 仍在扩展后的窗口内
        assert_eq!(s.poll(Some(200), t0, Duration::from_secs(1)), None);
        assert_eq!(s.poll(Some(300), t0 + Duration::from_millis(900), Duration::from_secs(1)), None);
        assert_eq!(s.poll(Some(300), t0 + Duration::from_millis(1500), Duration::from_secs(1)), None, "窗口被重置——1.5s 仍不发射");
        // t=2.0：距最后变化 1.1s → 发射
        assert_eq!(s.poll(Some(300), t0 + Duration::from_millis(2000), Duration::from_secs(1)), Some("modified"));
    }

    /// 发射后回到静默：后续同 mtime 轮询零发射；再次变化重新走全流程。
    #[test]
    fn watch_state_rearms_after_fire() {
        let mut s = WatchState::new(Some(100));
        let t0 = std::time::Instant::now();
        assert_eq!(s.poll(Some(200), t0, Duration::from_secs(1)), None);
        assert_eq!(s.poll(Some(200), t0 + Duration::from_millis(1100), Duration::from_secs(1)), Some("modified"));
        // 静默期：同 mtime 不发射
        for tick in 2..4 {
            assert_eq!(s.poll(Some(200), t0 + Duration::from_secs(tick), Duration::from_secs(1)), None);
        }
        // 新变化 → 全流程重走
        assert_eq!(s.poll(Some(300), t0 + Duration::from_secs(4), Duration::from_secs(1)), None);
        assert_eq!(s.poll(Some(300), t0 + Duration::from_millis(5100), Duration::from_secs(1)), Some("modified"));
    }
}
