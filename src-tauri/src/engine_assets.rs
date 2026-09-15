// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 随包图谱引擎探测面（engine-bundled-mcp-distribution，2026-09-16）。
//
// 背景（缺口的另一半）：引擎**一直随包分发**——`tauri.conf.json` 的
// `bundle.resources` 含 `hologram-engine.exe` + grammars/onnxruntime/models
//（实测 196MB，2026-09-16）。但 09-09 图谱全量退役（`51047f99`）删掉了
// `engine_transport.rs`——里面装着「自动定位 + 每工作区 spawn」的配套胶水，
// 而**同一批没人回头动打包清单**（`git show 51047f99 -- tauri.conf.json`
// 为空）。结果是分发包留着、接线删了：兰台零行代码知道引擎在哪。
//
// 本模块补回「定位」这一半（接线在 TS 侧 `plugins/bundled-engine.ts`，走既有
// MCP 受治进程通道，不复活 engine_transport）。它与 `plugin_assets.rs` 同族——
// 都是「把随包资源的位置告诉前端」。
//
// 纪律（照抄 plugin_assets.rs 的教训）：
//   - **多候选梯**：单一期望位置不可靠，tauri v2 对 crate 外资源的落点随 conf
//     形式而变（`_up_` 转义目录是实测形态）；
//   - **全未命中不锁 None**：命中才写 OnceLock——早先 plugin_assets 遇主候选
//     缺席即 `set(None)`，把 OnceLock 钉死，令兜底分支沦为死代码（dev 下
//     「重新加载全报错」的真根因）；
//   - **env override**：`LANTAI_ENGINE_EXE` 供测试隔离 / 目录重定位。

use std::path::PathBuf;

/// 引擎可执行文件名（与 tauri.conf.json resources 的落点名一致）。
const ENGINE_EXE: &str = "hologram-engine.exe";

/// 已解析的引擎 exe 路径缓存（OnceLock——进程生命期一次解析）。
/// **只在命中时写**（全未命中保持未初始化，允许后续重试）。
static ENGINE_EXE_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// env 覆盖键（测试隔离 / 显式重定位）。
const ENGINE_EXE_ENV: &str = "LANTAI_ENGINE_EXE";

/// 随包引擎可执行文件的绝对路径。
///
/// 候选梯：
///   1. `LANTAI_ENGINE_EXE` 环境变量（测试隔离 / 显式覆盖）；
///   2. 当前 exe 同级 `<exe_dir>/hologram-engine.exe`
///      ——tauri.conf.json `resources` 的落点（`"../target/release/hologram-engine.exe"
///      → "hologram-engine.exe"`，与宿主 exe 同级）；
///   3. 当前 exe 上一级 `<exe_dir>/../hologram-engine.exe`
///      ——部分安装布局（历史 `engine_exe_path()` 的第二候选，2026-09-09 随
///      engine_transport 删除，此处按原语义恢复）；
///   4. 仓库开发态兜底 `<repo>/target/{release,debug}/hologram-engine.exe`
///      （dev / cargo test——打包态由候选 2 命中）。
///
/// 返回 None = 未找到（调用方走「引擎不可用」降级，不炸）。
pub(crate) fn engine_exe_path() -> Option<PathBuf> {
    if let Some(p) = ENGINE_EXE_PATH.get() {
        return Some(p.clone());
    }
    for candidate in engine_exe_candidates() {
        if candidate.is_file() {
            let _ = ENGINE_EXE_PATH.set(candidate.clone());
            return Some(candidate);
        }
    }
    None
}

/// 候选路径梯（纯函数——不碰 OnceLock，测试可直测顺序与形状）。
fn engine_exe_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // 1. env override
    if let Some(custom) = std::env::var_os(ENGINE_EXE_ENV) {
        if !custom.is_empty() {
            out.push(PathBuf::from(custom));
        }
    }

    // 2/3. 宿主 exe 同级与上一级
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(ENGINE_EXE));
            if let Some(parent) = dir.parent() {
                out.push(parent.join(ENGINE_EXE));
            }
        }
    }

    // 4. 仓库开发态兜底（构建产物默认落点）
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent() {
        out.push(root.join("target").join("release").join(ENGINE_EXE));
        out.push(root.join("target").join("debug").join(ENGINE_EXE));
    }

    out
}

/// 随包引擎的安装目录（宿主 exe 所在目录；未解析到引擎时为 None）。
///
/// 前端消费面：TS 侧 `bundled-engine.ts` 拿它作 `McpBridgeIO.pluginDir` 的锚点
/// ——`openStdio` 无条件调 `io.pluginDir(pluginName)`，而 `plugin_dir` RPC 对
/// 非已安装插件名报错（引擎不是插件）。给安装目录即可绕开，并让 stdio `args`
/// 里的 `./` 相对形态有正确锚点（`user-mcp.ts` 的同款先例）。
pub(crate) fn install_dir() -> Option<PathBuf> {
    engine_exe_path().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// 引擎二进制是否就位（RPC 面用；不暴露路径细节）。
pub(crate) fn engine_available() -> bool {
    engine_exe_path().is_some()
}

#[cfg(test)]
pub(crate) mod tests_support {
    /// env 读写的跨模块测试锁——`LANTAI_ENGINE_EXE` 是进程级变量，并行用例
    /// 会互相 clobber（间歇红）。与 `plugin_assets::PLUGINS_ROOT_TEST_LOCK`
    /// 同款纪律（该文件头注已记「env 变量进程级，并行 clobber 间歇红」）。
    pub(crate) static ENGINE_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}

#[cfg(test)]
mod tests {
    use super::tests_support::ENGINE_ENV_TEST_LOCK;
    use super::*;

    /// 持锁跑闭包（env 改动与其它用例串行）。
    fn with_env_lock<T>(f: impl FnOnce() -> T) -> T {
        let _guard = ENGINE_ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        f()
    }

    /// 候选梯顺序与形状：env 覆盖恒在首位（测试隔离的前提）。
    #[test]
    fn candidates_env_override_comes_first() {
        with_env_lock(|| {
            let marker = "Z:/nonexistent-engine-for-test/hologram-engine.exe";
            std::env::set_var(ENGINE_EXE_ENV, marker);
            let cands = engine_exe_candidates();
            std::env::remove_var(ENGINE_EXE_ENV);
            let first = cands.first().map(|p| p.to_string_lossy().replace('\\', "/"));
            assert_eq!(first, Some(marker.to_string()), "env 覆盖必须排首位: {cands:?}");
        });
    }

    /// 候选梯含「宿主 exe 同级」形态（候选 2——tauri resources 的落点语义）。
    #[test]
    fn candidates_include_exe_sibling() {
        with_env_lock(|| {
            let cands = engine_exe_candidates();
            let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf()));
            let Some(dir) = exe_dir else { return };
            let want = dir.join(ENGINE_EXE);
            assert!(cands.contains(&want), "候选梯必须含宿主 exe 同级 {want:?}: {cands:?}");
        });
    }

    /// 宿主 exe 上一级候选在场（候选 3——历史 engine_exe_path 的第二候选）。
    #[test]
    fn candidates_include_exe_parent() {
        with_env_lock(|| {
            let cands = engine_exe_candidates();
            let parent_cand = std::env::current_exe()
                .ok()
                .and_then(|e| e.parent().and_then(|d| d.parent()).map(|p| p.join(ENGINE_EXE)));
            if let Some(want) = parent_cand {
                assert!(cands.contains(&want), "候选梯必须含宿主 exe 上一级 {want:?}: {cands:?}");
            }
        });
    }

    /// 仓库兜底候选在场（dev/cargo test 面）。
    #[test]
    fn candidates_include_repo_fallback() {
        with_env_lock(|| {
            let cands = engine_exe_candidates();
            let has_repo = cands.iter().any(|p| {
                let s = p.to_string_lossy().replace('\\', "/");
                s.contains("/target/release/") || s.contains("/target/debug/")
            });
            assert!(has_repo, "候选梯必须含仓库开发态兜底: {cands:?}");
        });
    }

    /// env 指向真实文件时必须能命中（不执行它，只测探测）。
    #[test]
    fn env_override_hits_real_file() {
        with_env_lock(|| {
            let tmp = std::env::temp_dir().join(format!("lantai_engine_probe_{}", std::process::id()));
            let _ = std::fs::create_dir_all(&tmp);
            let fake = tmp.join(ENGINE_EXE);
            std::fs::write(&fake, b"stub").unwrap();

            std::env::set_var(ENGINE_EXE_ENV, fake.to_string_lossy().to_string());
            let found = engine_exe_candidates().into_iter().find(|p| p.is_file());
            std::env::remove_var(ENGINE_EXE_ENV);

            let ok = found.as_deref() == Some(fake.as_path());
            let _ = std::fs::remove_dir_all(&tmp);
            assert!(ok, "env 指向真文件时必须命中该文件（得 {found:?}）");
        });
    }

    /// 不存在的 env 值不得被误当命中（降级而非崩溃）。
    #[test]
    fn missing_env_target_is_not_a_hit() {
        with_env_lock(|| {
            std::env::set_var(ENGINE_EXE_ENV, "Z:/definitely/not/here/engine.exe");
            let hit = engine_exe_candidates().into_iter().find(|p| p.is_file());
            std::env::remove_var(ENGINE_EXE_ENV);
            // 仓库可能已构建引擎（兜底候选真存在）——那种命中合法；断言的是
            // 「不存在的 env 目标本身不被当成命中」。
            if let Some(p) = hit {
                assert!(
                    !p.to_string_lossy().replace('\\', "/").contains("definitely/not/here"),
                    "不存在的 env 目标不得被当作命中: {p:?}"
                );
            }
        });
    }

    /// 探测是纯查询：找不到时返回 None 而不是 panic（「引擎不可用」降级前提）。
    #[test]
    fn probe_degrades_without_panic() {
        with_env_lock(|| {
            // 无论仓库是否构建过引擎，这两个函数都不该 panic
            let _ = engine_exe_path();
            let _ = install_dir();
            let _ = engine_available();
        });
    }
}
