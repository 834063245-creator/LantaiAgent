// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OAuth provider 注册表（provider-refactor 方案乙 Phase 3A）——
// 首批 ChatGPT Codex；预留 claude-pro/github-copilot/grok-xai 挂点。
//
// ⚡ wire 依据（2026-09 实证，勿盲改）：
//   - client_id = app_EMoamEEZ73f0CkXaXp7hrann —— OpenAI 官方 Codex 应用注册
//     （Codex CLI / codex-oauth crate / cc-switch 同款，公开常量不可配置）；
//   - 端点族在 auth.openai.com 之下（usercode → deviceauth/token 轮询 →
//     oauth/token 交换/刷新），流程实现见 device_flow.rs；
//   - 授权页 = https://auth.openai.com/codex/device；
//   - id_token 是 JWT，payload.chatgpt_account_id 即 ChatGPT 账号 id——
//     发起 Codex 请求时须带 chatgpt-account-id 头（官方 Codex CLI 行为）；
//   - 模型端点 = https://chatgpt.com/backend-api/codex/responses（订阅面，
//     非平台 /v1/responses——平台 Key 走 openai 模板的 api.openai.com/v1）。
//     来源：openai/codex 仓库 codex-rs/login（device_code_auth.rs +
//     server.rs）、skg-provider-codex、2026-07 zylos 对生产后端实测。

use crate::oauth::OAuthGrant;
use serde_json::Value;

/// OAuth provider 元数据。
#[derive(Debug)]
pub struct OAuthProviderDef {
    /// 注册表寻址 id（vendor-templates oauthProvider / RPC provider 参数）。
    pub id: &'static str,
    /// auth 签发方（OpenAI OAuth 基础设施根）。
    pub issuer: &'static str,
    /// OAuth client_id（公开注册，不可配置）。
    pub client_id: &'static str,
    /// device-code 人类授权页（相对 issuer）。
    pub verification_path: &'static str,
    // 请求注入头（chatgpt-account-id/originator 等）在 TS 侧 buildOauthHeaders
    // 承载（provider/oauth.ts）——Rust 侧不重复实现；模型端点 baseUrl 在
    // vendor-templates.ts（codex 行）真源。
}

/// 出厂 OAuth provider 注册表（id → def）。预留挂点以注释列明。
pub fn oauth_providers() -> Vec<OAuthProviderDef> {
    vec![OAuthProviderDef {
        id: "codex",
        issuer: "https://auth.openai.com",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        verification_path: "/codex/device",
        // （预留挂点：claude-pro / github-copilot / grok-xai——各 provider
        //  未来在此追加一行，含各自 issuer/client_id/verification_path/模型端点）
    }]
}

/// 按 id 查 provider def。未知 → Err（响亮，不静默）。
pub fn find_oauth_provider(id: &str) -> Result<OAuthProviderDef, String> {
    oauth_providers()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| {
            format!(
                "OAUTH_PROVIDER: 未知 OAuth provider \"{id}\"（当前可用：{}）",
                oauth_providers()
                    .iter()
                    .map(|p| p.id)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

/// 从 id_token（JWT）解析 chatgpt_account_id claim。payload 是 base64url JSON。
/// 解析失败返回 Err（登录成功但缺账号 id = 无法注入请求头，响亮报错）。
pub fn chatgpt_account_id_from_id_token(id_token: &str) -> Result<String, String> {
    let segs: Vec<&str> = id_token.split('.').collect();
    if segs.len() < 2 {
        return Err("id_token 不是 JWT（缺 payload 段）".to_string());
    }
    use base64::Engine;
    let payload_b64 = segs[1];
    let padded = format!(
        "{}{}",
        payload_b64,
        "=".repeat((4 - payload_b64.len() % 4) % 4)
    );
    let bytes = base64::engine::general_purpose::URL_SAFE
        .decode(padded)
        .map_err(|e| format!("id_token payload base64 解码失败: {e}"))?;
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("id_token payload JSON 解析失败: {e}"))?;
    v.get("chatgpt_account_id")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "id_token 缺 chatgpt_account_id claim".to_string())
}

/// 从 grant 构造 OAuthGrant（登录成功的收口）。
pub fn build_grant(
    provider: &str,
    access_token: &str,
    refresh_token: &str,
    id_token: &str,
    expires_in: Option<u64>,
    scope: Option<String>,
) -> Result<OAuthGrant, String> {
    let account_id = chatgpt_account_id_from_id_token(id_token)?;
    let expires_at = match expires_in {
        Some(s) => {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64 + s as i64)
                .unwrap_or(0)
        }
        None => 0,
    };
    Ok(OAuthGrant {
        kind: "oauth".to_string(),
        provider: provider.to_string(),
        access_token: access_token.to_string(),
        refresh_token: refresh_token.to_string(),
        expires_at,
        account_id,
        scope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn find_known_provider() {
        let p = find_oauth_provider("codex").expect("codex 在册");
        assert_eq!(p.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
    }

    #[test]
    fn find_unknown_provider_loud() {
        let err = find_oauth_provider("nope").expect_err("未知 provider 必须报错");
        assert!(err.contains("OAUTH_PROVIDER"), "报错带前缀标记: {err}");
        assert!(err.contains("codex"), "报错点名可用 provider: {err}");
    }

    #[test]
    fn chatgpt_account_id_parses() {
        // 手造三段的 JWT（payload = {"chatgpt_account_id":"user-1"}）
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"chatgpt_account_id":"user-1"}"#);
        let token = format!("header.{payload}.sig");
        assert_eq!(chatgpt_account_id_from_id_token(&token).unwrap(), "user-1");
    }

    #[test]
    fn chatgpt_account_id_missing_is_err() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"someone-else"}"#);
        let token = format!("h.{payload}.s");
        let err = chatgpt_account_id_from_id_token(&token).expect_err("缺 claim 必须报错");
        assert!(err.contains("chatgpt_account_id"));
    }
}
