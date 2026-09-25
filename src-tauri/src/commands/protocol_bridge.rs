// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// MCP / ACP stdio 桥：让 webview 里的 TS MCP client / ACP server 通过 Tauri 起一个
// 子进程（外部 MCP server / ACP host），并在 webview 与子进程 stdin/stdout 之间双向搬
// 运 JSON-RPC 行。stdout 行经 `protocol-bridge:output` 事件推给前端；前端用
// `protocol_bridge_spawn` 起,`protocol_bridge_write` 写 stdin,`protocol_bridge_kill` 关。
//
// app shell S2（受治进程治理，app-shell-software-plugin-plan §5-S2）：
//   - spawn 增补 env 注入（`LANTAI_PLUGIN_DATA_DIR` 等宿主注入面——插件数据
//     目录路径由 TS 侧 mcp-bridge 构造传入，进程用自身 fs 读写自己的地盘）；
//   - kill 升级为进程树终止（受治进程的优雅回收必须含子进程——node shim 链
//     会拉孙进程，只杀直接子进程 = 泄露，决策 4「泄露即 bug」）。
// spawn_process / kill_process_tree 抽为无 AppHandle 依赖的纯函数——cargo 单测
// 直测（命令包装层只剩 stdout→emit 布线，与既有行为一致）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;

use tauri::Emitter;
use tracing::{debug, info};

struct BridgeProc {
    child: Child,
    stdin: Option<ChildStdin>,
}

static PROCS: std::sync::LazyLock<Mutex<HashMap<String, BridgeProc>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 退出探测轮询间隔（ms）——受治进程退出到宿主知情的**最坏**延迟。
const EXIT_POLL_MS: u64 = 100;

/// 单次采样结果（退出守护线程的判据）。
enum ExitSample {
    /// 已退出，携带真实退出码（None = 无码，如被信号/任务管理器终结）。
    Exited(Option<i32>),
    /// 仍在跑。
    Running,
    /// 注册表里没有本行——已被 `protocol_bridge_kill` 摘走（归 kill 路径记账），
    /// 或 `try_wait` 失败（进程句柄不可用）。
    Gone,
}

/// 瞬时采样子进程状态（锁只在取样瞬间持有——不跨 sleep、不跨阻塞调用）。
fn sample_exit(id: &str) -> ExitSample {
    let mut procs = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    match procs.get_mut(id) {
        None => ExitSample::Gone,
        Some(p) => match p.child.try_wait() {
            Ok(Some(status)) => ExitSample::Exited(status.code()),
            Ok(None) => ExitSample::Running,
            Err(e) => {
                debug!(id = %id, error = %e, "protocol bridge try_wait 失败——放弃退出探测");
                ExitSample::Gone
            }
        },
    }
}

/// 等受治进程退出并把它从注册表摘掉；返回真实退出码。
///
/// **单一退出出口**（#2 可观测性）：修此之前，进程「怎么没的」在任何日志里都
/// 查不到——本文件只记 `spawned`，退出面只有一条不带码的 stdout-EOF 事件，
/// 2026-09-25 排查「引擎在长任务跑到一半时消失」只能靠「最后一条 MCP 调用 +
/// 5 分钟」反推 + 「没有 shutdown 告别」猜是硬杀（实测排查成本极高）。
///
/// 返回 None = 已被 `protocol_bridge_kill` 摘走（那条路径自己记原因）。
/// **不阻塞锁**：每次 `sample_exit` 瞬时持锁，sleep 在锁外。
pub(crate) fn wait_proc_exit(id: &str) -> Option<Option<i32>> {
    loop {
        match sample_exit(id) {
            ExitSample::Exited(code) => {
                PROCS.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
                return Some(code);
            }
            ExitSample::Gone => return None,
            ExitSample::Running => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(EXIT_POLL_MS));
    }
}

/// 起一个 stdio 子进程（管道三通 + 隐藏控制台 + 可选 env 注入）——受治进程
/// spawn 的纯核心，无 AppHandle 依赖（cargo 直测面）。
///
/// env 是**追加**不是替换（继承宿主环境——PATH 等存活必需；注入面 = 宿主
/// 给受治进程的寻址信息，如 LANTAI_PLUGIN_DATA_DIR）。
pub(crate) fn spawn_process(
    command: &str,
    args: &[String],
    env: Option<&HashMap<String, String>>,
) -> Result<Child, String> {
    let mut cmd = std::process::Command::new(command);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(env) = env {
        cmd.envs(env);
    }
    // 2026-08-17 根治：外部 MCP/ACP server 常是 node/python 等 CUI 程序，
    // 且会再拉起孙进程（node shim 链）。必须隐藏控制台继承，否则从 GUI 主进程
    // spawn 会在桌面弹出可见 cmd 黑窗。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::utils::HIDDEN_CONSOLE);
    }
    // unix：立独立进程组（组 id = 子 pid），kill_process_tree 按组连树杀。
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn()
        .map_err(|e| format!("protocol_bridge_spawn: {command} 启动失败: {e}"))
}

/// 终止整棵进程树（含孙进程链）——受治进程回收出口。树杀失败回落直接
/// child.kill()（单杀保底，好过不杀）。
pub(crate) fn kill_process_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // taskkill /T：按 PID 枚举子树连杀（/F 强制——受治进程不参与优雅退出
        // 协议，回收即终结；进程树枚举由系统完成，孙进程链无遗漏）。
        let out = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(crate::utils::HIDDEN_CONSOLE)
            .output();
        match out {
            Ok(o) if o.status.success() => {}
            _ => {
                let _ = child.kill();
            }
        }
    }
    #[cfg(unix)]
    {
        // spawn 时 process_group(0) 立组 → 组 id = pid；kill -9 -PGID 连树杀。
        let pgid = format!("-{pid}");
        let ok = std::process::Command::new("kill")
            .args(["-9", &pgid])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            let _ = child.kill();
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = child.kill();
    }
}

/// 生成一个 stdio 子进程（外部 MCP server / ACP host），返回其 bridge id。
#[tauri::command]
pub(crate) fn protocol_bridge_spawn(
    id: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut child = spawn_process(&command, &args, env.as_ref())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "protocol_bridge_spawn: 无法捕获 stdout".to_string())?;
    let stdin = child.stdin.take();

    // 先入注册表再起两个线程：退出守护按 id 查注册表，晚一步插就可能在首轮
    // 采样时读到 Gone（退出事件静默丢失）。
    PROCS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), BridgeProc { child, stdin });

    // stdout 读者线程：逐行 emit 到前端。EOF **不再兼作退出信号**——退出统一由
    // 守护线程报（带真实退出码），两条路径各自 emit 会重复且其中一条没码。
    let app_out = app.clone();
    let out_id = id.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let _ = app_out.emit(
                "protocol-bridge:output",
                serde_json::json!({ "id": out_id, "line": line }),
            );
        }
    });

    // 退出守护线程：轮询取真实退出码 → 落 bridge.log（持久证据）+ emit。
    let app_exit = app.clone();
    let exit_id = id.clone();
    std::thread::spawn(move || {
        let Some(code) = wait_proc_exit(&exit_id) else { return };
        info!(id = %exit_id, exit_code = ?code, "protocol bridge exited");
        let _ = app_exit.emit(
            "protocol-bridge:exit",
            serde_json::json!({ "id": exit_id, "code": code }),
        );
    });

    info!(id = %id, command = %command, "protocol bridge spawned");
    Ok(id)
}

/// 向指定 bridge 子进程的 stdin 写一行（不含换行）。
#[tauri::command]
pub(crate) fn protocol_bridge_write(id: String, line: String) -> Result<String, String> {
    let mut procs = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    let proc = procs
        .get_mut(&id)
        .ok_or_else(|| format!("protocol_bridge_write: unknown bridge {id}"))?;
    let stdin = proc
        .stdin
        .as_mut()
        .ok_or_else(|| format!("protocol_bridge_write: {id} stdin closed"))?;
    stdin
        .write_all(format!("{}\n", line).as_bytes())
        .map_err(|e| format!("protocol_bridge_write: {id} 写入失败: {e}"))?;
    stdin.flush().map_err(|e| format!("protocol_bridge_write: {id} flush 失败: {e}"))?;
    Ok(id)
}

/// 关闭指定 bridge：杀整棵进程树（含孙进程——受治进程回收完整性，S2）+ 移除。
///
/// `reason` = 宿主侧停止原因（`mcp-bridge` 的 GovernorStopReason：idle-timeout /
/// window-closed / plugin-unloaded / activation-released / startup-failed）——
/// **落 bridge.log**，于是「进程为什么没的」有持久证据（#2）。
#[tauri::command]
pub(crate) fn protocol_bridge_kill(id: String, reason: Option<String>) -> Result<String, String> {
    // 先摘行再杀：① 退出守护线程据此判「归 kill 记账」；② 不在锁内做阻塞的
    // taskkill + wait（CONVENTIONS §2.3「锁内不阻塞 IO」）。
    let mut proc = PROCS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    match proc.as_mut() {
        Some(p) => {
            info!(
                id = %id,
                reason = %reason.as_deref().unwrap_or("unspecified"),
                "protocol bridge kill requested"
            );
            kill_process_tree(&mut p.child);
            let _ = p.child.wait();
        }
        // 已经自行退出（守护线程已摘行走 exit 路径）——幂等出口，不是错误
        None => debug!(id = %id, "protocol bridge kill: 进程已自行退出，无需回收"),
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// 轮询等待文件出现（进程树测试的同步锚——孙进程写 PID 文件有启动延迟）。
    fn wait_for_file(path: &std::path::Path, timeout_ms: u128) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms as u64);
        while std::time::Instant::now() < deadline {
            if path.is_file() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        false
    }

    fn read_file(path: &std::path::Path) -> String {
        let mut buf = String::new();
        std::fs::File::open(path)
            .and_then(|mut f| f.read_to_string(&mut buf))
            .expect("读测试产物文件");
        buf
    }

    fn test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hologram_protocol_bridge_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 跨平台「立即以 code 退出」的命令（自然退出路径）。
    fn exit_cmd(code: i32) -> (&'static str, Vec<String>) {
        #[cfg(windows)]
        {
            ("cmd", vec!["/C".to_string(), format!("exit {code}")])
        }
        #[cfg(unix)]
        {
            ("sh", vec!["-c".to_string(), format!("exit {code}")])
        }
    }

    /// #2 单一退出出口：自然退出必须取到**真实退出码**，并把该行摘出注册表。
    /// 旧行为 = 退出面只有一条 stdout-EOF 事件（不带码），进程「怎么没的」在
    /// 任何日志里都查不到——2026-09-25 引擎中途消失只能靠时间戳反推。
    #[test]
    fn wait_proc_exit_reports_real_code_and_reaps_entry() {
        let id = format!("test-exit-ok-{}", std::process::id());
        let (cmd, args) = exit_cmd(3);
        let child = spawn_process(cmd, &args, None).expect("spawn 应成功");
        PROCS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), BridgeProc { child, stdin: None });
        assert_eq!(wait_proc_exit(&id), Some(Some(3)), "应回报真实退出码");
        assert!(
            !PROCS.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&id),
            "退出后应摘掉注册表行（否则重启换代的行会无限堆积）"
        );
    }

    /// 已被 `protocol_bridge_kill` 摘走的行：守护线程如实返回 None（归 kill 记账
    /// ——它记原因）；且 kill 对不存在的 id 幂等（收尾竞态不是错误）。
    #[test]
    fn wait_proc_exit_and_kill_are_idempotent_on_reaped_id() {
        let id = format!("test-exit-gone-{}", std::process::id());
        assert_eq!(wait_proc_exit(&id), None, "注册表无此行 ⇒ 不认领退出");
        assert!(protocol_bridge_kill(id.clone(), Some("idle-timeout".to_string())).is_ok());
        assert_eq!(wait_proc_exit(&id), None);
    }

    /// env 注入端到端（Windows）：spawn 的追加 env 在子进程环境可见——
    /// powershell 落盘验证（继承面不受影响：PATH 同盘可查）。脚本只用单引号
    /// 拼接——cmd.exe 不认 MSVC 式 \" 转义，嵌双引号的 arg 会被打碎。
    #[cfg(windows)]
    #[test]
    fn spawn_process_injects_env() {
        let dir = test_dir("env");
        let out_file = dir.join("env.txt");
        let mut env = HashMap::new();
        env.insert("LANTAI_TEST_DATA_DIR".to_string(), dir.join("data").to_string_lossy().into_owned());
        let script = format!(
            "Set-Content -Path '{}' -Value ('LANTAI_TEST_DATA_DIR=' + $env:LANTAI_TEST_DATA_DIR + '|PATH_PRESENT=' + [bool]$env:PATH)",
            out_file.display()
        );
        let args = vec!["-NoProfile".to_string(), "-Command".to_string(), script];
        let mut child = spawn_process("powershell", &args, Some(&env)).expect("powershell spawn 应成功");
        let _ = child.wait();
        assert!(out_file.is_file(), "env 落盘文件应存在");
        let content = read_file(&out_file);
        let want = env.get("LANTAI_TEST_DATA_DIR").unwrap();
        assert!(
            content.contains(&format!("LANTAI_TEST_DATA_DIR={want}")),
            "注入 env 应在子进程可见:\n{content}"
        );
        assert!(content.contains("PATH_PRESENT=True"), "继承 env 应保留（PATH 存在）:\n{content}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 进程树终止（Windows）：root powershell 经 Start-Process 拉孙进程并把孙
    /// PID 落盘；kill_process_tree 后孙进程必须消失（taskkill /T 连树杀——
    /// 只杀直接子进程的旧行为会让孙进程存活 120s，测试即红）。
    #[cfg(windows)]
    #[test]
    fn kill_process_tree_reaps_grandchildren() {
        use std::os::windows::process::CommandExt;
        let dir = test_dir("tree");
        let pid_file = dir.join("grand.pid");
        let script = format!(
            "$g = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep','-Seconds','120' -WindowStyle Hidden -PassThru; \
             Set-Content -Path '{}' -Value $g.Id; Start-Sleep -Seconds 120",
            pid_file.display()
        );
        let args = vec!["-NoProfile".to_string(), "-Command".to_string(), script];
        let mut root = spawn_process("powershell", &args, None).expect("powershell spawn 应成功");
        assert!(wait_for_file(&pid_file, 15_000), "孙进程 PID 应在时限内落盘");
        let grand_pid: u32 = read_file(&pid_file).trim().parse().expect("PID 文件应是数字");
        // 树杀
        kill_process_tree(&mut root);
        let _ = root.wait();
        // 孙进程在 ~5s 内消失（若树杀失效，孙进程常驻 120s → 轮询窗口后断言红）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut gone = false;
        while std::time::Instant::now() < deadline {
            let out = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {grand_pid}"), "/FO", "CSV", "/NH"])
                .creation_flags(crate::utils::HIDDEN_CONSOLE)
                .output()
                .expect("tasklist 应可执行");
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            if !text.contains(&format!("\"{grand_pid}\"")) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        assert!(gone, "kill_process_tree 应连孙进程（PID {grand_pid}）一并回收");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
