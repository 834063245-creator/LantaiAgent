// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 组合层热重载 watcher（S4-2）—— 监听 ~/.hologram/composition/ 根级
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
fn watch_loop(app_handle: AppHandle, running: std::sync::Arc<AtomicBool>) {
    let patch_path = root_patch_path();
    let mut last_mtime = file_mtime(&patch_path);
    let mut pending = false;
    let mut last_change_at: Option<std::time::Instant> = None;
    while running.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_secs(1));
        if !running.load(Ordering::SeqCst) {
            break;
        }
        let current = file_mtime(&patch_path);
        if current != last_mtime {
            last_mtime = current;
            pending = true;
            last_change_at = Some(std::time::Instant::now());
        }
        let settled = last_change_at
            .map(|t| t.elapsed() >= Duration::from_secs(1))
            .unwrap_or(false);
        if pending && settled {
            pending = false;
            last_change_at = None;
            // 事件载荷：触发原因（patch 出现/修改/删除）——前端 reload 幂等，
            // 载荷仅作诊断呈现。
            let reason = if current.is_some() { "modified" } else { "removed" };
            if let Err(e) = app_handle.emit("composition:changed", reason) {
                eprintln!("[composition-watcher] emit composition:changed 失败: {e}");
            }
        }
    }
}

/// 根级 patch 路径（composition_root 来自 plugin_assets——单一事实源）。
fn root_patch_path() -> PathBuf {
    crate::plugin_assets::composition_root_public().join("roster.patch.yml")
}

/// 文件 mtime（不存在/不可读 = None——删除也是变更事件）。
fn file_mtime(path: &std::path::Path) -> Option<u64> {
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
}
