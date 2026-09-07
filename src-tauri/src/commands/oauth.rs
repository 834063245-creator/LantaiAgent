// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OAuth 命令族（provider-refactor 方案乙 Phase 3C）——oauth_start / oauth_poll /
// oauth_accounts / oauth_set_default / oauth_logout / oauth_refresh / open_external。
//
// 设计（对齐 RPC 单入口 + 前端驱动语义）：
//   - 网络操作都发生在 oauth 模块（reqwest async）；本文件是 rpc.rs 直呼的
//     纯函数壳（identity.rs 同款——不经 #[tauri::command] 注册）。
//   - 轮询 = 前端每 interval 拍一次 oauth_poll（每拍一次 HTTP），不占 Rust 长任务。
//   - 凭证存 credential.rs 的 OAuth grant 平面（复合键 oauth:{provider}::{account_id}）。
//   - open_external 用平台命令开系统浏览器（无 opener 插件；Windows cmd start /
//     macOS open / Linux xdg-open）。

use crate::oauth;

/// oauth_start：发起 device-code 流程（第一步 usercode）。
/// 返回 DeviceFlowStart（ok_json 序列化——verification_uri/user_code/
/// device_auth_id/interval/expires_at）。
pub async fn oauth_start(provider: &str) -> Result<oauth::DeviceFlowStart, String> {
    let def = oauth::providers::find_oauth_provider(provider)?;
    let uc = oauth::device_flow::request_user_code(def.issuer, def.client_id).await?;
    let verification_uri = format!("{}{}", def.issuer, def.verification_path);
    Ok(oauth::DeviceFlowStart {
        verification_uri,
        user_code: uc.user_code.clone(),
        device_auth_id: uc.device_auth_id,
        interval: uc.interval.max(3), // 服务端 interval 可能 1s——下限 3s 防狂轮
        expires_at: uc.expires_at.unwrap_or(0),
    })
}

/// oauth_poll：轮询一拍。返回：
///   Ok(Some(grant)) → 批准并完成 token 交换 + grant 落库（前端据此建 provider）；
///   Ok(None)        → "pending" 未批准，调用方 sleep interval 后继续；
///   终态错误 → Err（expired/access_denied 等）。
pub async fn oauth_poll(
    provider: &str,
    device_auth_id: &str,
    user_code: &str,
) -> Result<Option<oauth::OAuthGrant>, String> {
    let def = oauth::providers::find_oauth_provider(provider)?;
    let approved = oauth::device_flow::poll_device_token(def.issuer, device_auth_id, user_code).await?;
    let Some(approved) = approved else {
        return Ok(None);
    };
    let tokens = oauth::device_flow::exchange_code_for_tokens(
        def.issuer,
        def.client_id,
        &approved.authorization_code,
        &approved.code_verifier,
    )
    .await?;
    let grant = oauth::providers::build_grant(
        provider,
        &tokens.access_token,
        &tokens.refresh_token,
        &tokens.id_token,
        tokens.expires_in,
        None,
    )?;
    crate::credential::store_oauth_grant(&grant)?;
    Ok(Some(grant))
}

/// oauth_accounts：某 provider 已存 grant 的账号清单（不含 access/refresh——
/// 只给展示元数据；敏感面绝不出 IPCD 响应体）。
pub fn oauth_accounts(provider: &str) -> Result<Vec<serde_json::Value>, String> {
    let grants = crate::credential::list_oauth_grants(provider)?;
    Ok(grants
        .iter()
        .map(|g| {
            serde_json::json!({
                "provider": g.provider,
                "account_id": g.account_id,
                "expires_at": g.expires_at,
                "scope": g.scope,
            })
        })
        .collect())
}

/// oauth_access：取某 provider 指定账号的完整 grant（进程内请求装配用——
/// access_token 只在 Tauri 进程内流转，绝不出 IPC 到页面之外的本模块封装）。
/// 已过期 → 自动刷新一次并回写；仍失败 → Err（响亮，前端提示重新登录）。
/// account_id 缺省/空 = 最近登录（列表首条）。
pub async fn oauth_access(provider: &str, account_id: Option<String>) -> Result<oauth::OAuthGrant, String> {
    let grants = crate::credential::list_oauth_grants(provider)?;
    if grants.is_empty() {
        return Err(format!("OAUTH_NO_GRANT: provider \"{provider}\" 无已登录账号——请先登录"));
    }
    // 指定 account_id 或列表首条（最近登录）
    let grant = match account_id {
        Some(id) => grants
            .into_iter()
            .find(|g| g.account_id == id)
            .ok_or_else(|| format!("OAUTH_NO_GRANT: provider \"{provider}\" 无账号 {id}")),
        None => Ok(grants.into_iter().next().expect("非空已检查")),
    }?;
    // 未过期 → 直接返回
    if grant.expires_at <= 0 || grant.expires_at * 1000 > now_ms() {
        return Ok(grant);
    }
    // 过期 → 刷新一次
    let refreshed = oauth_refresh(provider, &grant.account_id).await?;
    Ok(refreshed)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// oauth_logout：删除 (provider, account_id) 的 grant。不存在不算错误。
pub fn oauth_logout(provider: &str, account_id: &str) -> Result<(), String> {
    crate::credential::delete_oauth_grant(provider, account_id)
}

/// oauth_refresh：用 refresh_token 续期并回写 grant（account_id 不变）。
/// 刷新响应带 id_token → build_grant（可能账号变更）；无 → 显式保留原 account_id。
pub async fn oauth_refresh(
    provider: &str,
    account_id: &str,
) -> Result<oauth::OAuthGrant, String> {
    let def = oauth::providers::find_oauth_provider(provider)?;
    let existing = crate::credential::get_oauth_grant(provider, account_id)?
        .ok_or_else(|| format!("oauth grant 不存在: {provider}::{account_id}"))?;
    let tokens = oauth::device_flow::refresh_tokens(def.issuer, def.client_id, &existing.refresh_token).await?;
    let grant = if !tokens.id_token.is_empty() {
        // 刷新带新 id_token → build_grant（账号可能变更，解析新 account_id）
        oauth::providers::build_grant(
            provider,
            &tokens.access_token,
            &tokens.refresh_token,
            &tokens.id_token,
            tokens.expires_in,
            existing.scope.clone(),
        )?
    } else {
        // 无 id_token → 显式保留原 account_id（多数 OAuth 服务器刷新不带新 id_token）
        oauth::OAuthGrant {
            kind: "oauth".to_string(),
            provider: provider.to_string(),
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.clone(),
            expires_at: tokens
                .expires_in
                .map(|s| {
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64 + s as i64)
                        .unwrap_or(0)
                })
                .unwrap_or(0),
            account_id: account_id.to_string(),
            scope: existing.scope.clone(),
        }
    };
    crate::credential::store_oauth_grant(&grant)?;
    Ok(grant)
}

/// open_external：用系统命令打开 URL（无 opener 插件——交接文档 3C 清单）。
/// Windows: cmd /c start "" <url>；macOS: open <url>；Linux: xdg-open <url>。
pub fn open_external(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("open_external: url 为空".to_string());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("open_external: 仅允许 http(s) URL".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .spawn()
            .map_err(|e| format!("open_external: cmd start 失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("open_external: open 失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("open_external: xdg-open 失败: {e}"))?;
    }
    Ok(())
}
