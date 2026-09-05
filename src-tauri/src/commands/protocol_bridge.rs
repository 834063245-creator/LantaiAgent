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
use std::sync::mpsc;
use std::sync::Mutex;

use tauri::Emitter;
use tracing::info;

struct BridgeProc {
    child: Child,
    stdin: Option<ChildStdin>,
    /// 子进程退出通知（keepalive 用）。
    _exit_tx: mpsc::Sender<i32>,
}

static PROCS: std::sync::LazyLock<Mutex<HashMap<String, BridgeProc>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

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

    let app_out = app.clone();
    let bridge_id = id.clone();
    let (exit_tx, exit_rx) = mpsc::channel::<i32>();
    // stdout 读者线程：逐行 emit 到前端。
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let _ = app_out.emit(
                "protocol-bridge:output",
                serde_json::json!({ "id": bridge_id, "line": line }),
            );
        }
        // stdout EOF → 通知退出
        let _ = app_out.emit("protocol-bridge:exit", serde_json::json!({ "id": bridge_id }));
    });
    std::thread::spawn(move || {
        // 让 exit_rx 存活以接收 child 退出（未直接使用 child.wait 以免阻塞）
        let _ = exit_rx.recv();
    });

    PROCS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), BridgeProc { child, stdin, _exit_tx: exit_tx });
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
#[tauri::command]
pub(crate) fn protocol_bridge_kill(id: String) -> Result<String, String> {
    let mut procs = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut p) = procs.remove(&id) {
        kill_process_tree(&mut p.child);
        let _ = p.child.wait();
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
