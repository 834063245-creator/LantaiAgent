// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 受限文件 I/O — 统一包装器（拆壳 D2 后形态）：**裁决留 exe，字节执行走后端进程**。
//
// 每个函数 = 两步：
//   1. 裁决（resolve_read/write_unchecked：worktree forward-map + 沙箱决议，
//      权限门在 dispatch 侧 PluginToolAdapter——P2-2 起免检变体即唯一形态）；
//   2. 把**已授权的物理路径**交给 primitives_client（受信后端进程）做字节执行。
//
// rename 保留双路径检查版（read(from)+write(to) 自检形态）——裁决仍在 exe，
// 后端只执行已裁决的 rename。
//
// 拆壳史：D0 把字节执行（read/write_atomic/list_dir_*/format_lines/preview/glob）
// 原样搬进 primitives-server（错误文案/guards 逐字一致），本文件退役字节层只留
// 裁决 + 转发。

use std::path::PathBuf;
use tauri::AppHandle;

use crate::WorkspaceState;

// ═══════════════════════════════════════════════════════════════
// 读取 — 裁决（exe）→ 后端字节执行
// ═══════════════════════════════════════════════════════════════

/// 文本读取。裁决后走后端 fs.read_text。
/// offset/limit/line_numbers 只对行号模式有意义（raw 模式后端直接返回原文）。
pub(crate) async fn read_text_unchecked(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<(PathBuf, String), String> {
    let real_path = crate::utils::resolve_read_unchecked(file_path, is_agent, agent_id, state)?;
    let real = real_path.to_string_lossy().to_string();
    // 透传 raw/offset/limit 决策：read_text_unchecked 保持「原文」语义
    // （行号格式化由调用方 raw 分支决定，见 tool_plugins/fs read_file_content——
    // 那里 raw=false 时走后端 lineNumbers 一次成型）。
    let resp = crate::primitives_client::call_async(
        "fs.read_text",
        &serde_json::json!({ "path": real, "lineNumbers": false }),
    )
    .await?;
    let content = resp
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| format!("primitives-server fs.read_text 响应缺 content: {resp}"))?
        .to_string();
    Ok((real_path, content))
}

/// 二进制读取（裁决 + 后端 fs.read_bytes → base64 壳侧解码）。
pub(crate) async fn read_bytes_unchecked(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<(PathBuf, Vec<u8>), String> {
    let real_path = crate::utils::resolve_read_unchecked(file_path, is_agent, agent_id, state)?;
    let real = real_path.to_string_lossy().to_string();
    let resp =
        crate::primitives_client::call_async("fs.read_bytes", &serde_json::json!({ "path": real })).await?;
    let b64 = resp
        .get("result")
        .and_then(|r| r.get("base64"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| format!("primitives-server fs.read_bytes 响应缺 base64: {resp}"))?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    Ok((real_path, bytes))
}

// ═══════════════════════════════════════════════════════════════
// 写入 — 裁决（exe）→ 后端字节执行
// ═══════════════════════════════════════════════════════════════

/// 原子写文本（裁决 + 后端 fs.write_text——原子 tmp→rename 在后端）。
pub(crate) async fn write_text_unchecked(
    file_path: &str,
    content: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<PathBuf, String> {
    let real_path = crate::utils::resolve_write_unchecked(file_path, is_agent, agent_id, state)?;
    let real = real_path.to_string_lossy().to_string();
    let resp = crate::primitives_client::call_async(
        "fs.write_text",
        &serde_json::json!({ "path": real, "content": content }),
    )
    .await?;
    if resp.get("error").is_some() {
        return Err(format!("primitives-server fs.write_text 失败: {resp}"));
    }
    Ok(real_path)
}

/// 创建目录（裁决 + 后端 fs.create_dir）。
pub(crate) async fn create_dir_unchecked(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<PathBuf, String> {
    let resolved = crate::utils::resolve_write_unchecked(path, is_agent, agent_id, state)?;
    let real = resolved.to_string_lossy().to_string();
    let resp =
        crate::primitives_client::call_async("fs.create_dir", &serde_json::json!({ "path": real })).await?;
    if resp.get("error").is_some() {
        return Err(format!("primitives-server fs.create_dir 失败: {resp}"));
    }
    Ok(resolved)
}

/// 删除（裁决 + 后端 fs.delete）。
pub(crate) async fn delete_unchecked(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<PathBuf, String> {
    let real = crate::utils::resolve_write_unchecked(path, is_agent, agent_id, state)?;
    let real_str = real.to_string_lossy().to_string();
    let resp =
        crate::primitives_client::call_async("fs.delete", &serde_json::json!({ "path": real_str })).await?;
    if resp.get("error").is_some() {
        return Err(format!("primitives-server fs.delete 失败: {resp}"));
    }
    Ok(real)
}

/// 重命名/移动。`from`/`to` 裁决在 exe（read(from) + write(to) 双路径检查）；
/// 后端只执行已裁决的 rename。
pub(crate) async fn rename(
    from: &str,
    to: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf), String> {
    let resolved_from = crate::utils::resolve_read_dispatch(from, is_agent, agent_id, state, app).await?;
    let resolved_to = crate::utils::resolve_write_dispatch(to, is_agent, agent_id, state, app).await?;
    let rf = resolved_from.to_string_lossy().to_string();
    let rt = resolved_to.to_string_lossy().to_string();
    let resp = crate::primitives_client::call_async(
        "fs.rename",
        &serde_json::json!({ "from": rf, "to": rt }),
    )
    .await?;
    if resp.get("error").is_some() {
        return Err(format!("primitives-server fs.rename 失败: {resp}"));
    }
    Ok((resolved_from, resolved_to))
}
