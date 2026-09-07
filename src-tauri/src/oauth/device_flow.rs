// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 通用 device-code 轮询原语（provider-refactor 方案乙 Phase 3A）——
// RFC 8628 device authorization grant 的 OpenAI Codex 变体。
//
// ⚡ wire 校准（2026-09 实证，来源见 providers/codex.rs 头注）：
// 官方 Codex CLI 与 2026-07 对生产后端的实测一致——OpenAI 的 device 流程在
// RFC 8628 之上加了 PKCE 中间跳：
//   ① POST {issuer}/api/accounts/deviceauth/usercode  body {client_id}
//        → { device_auth_id, user_code, interval, expires_at }
//   ② 人类到 {issuer}/codex/device 输入 user_code（15 分钟窗口）
//   ③ 轮询 POST {issuer}/api/accounts/deviceauth/token
//        body {device_auth_id, user_code}；未批准 → 403/404（继续轮询）；
//        批准 → 200 { authorization_code, code_challenge, code_verifier }
//   ④ POST {issuer}/oauth/token
//        form grant_type=authorization_code&code&redirect_uri={issuer}/deviceauth/callback
//            &client_id&code_verifier
//        → { access_token, refresh_token, id_token, ... }
//   ⑤ id_token JWT 解析出 chatgpt_account_id（请求注入头用）
//
// 轮询健壮性（zylos 实测教训）：轮询循环是长寿命操作（可达 15 分钟），
// 单次瞬时网络错（reset/timeout）不得终止整个登录——捕获后短退避重试；
// 只有 403/404（未批准/等待）才 sleep interval 续轮，expired/access_denied
// 类终态错误才上报终止。

use serde::{Deserialize, Serialize};

/// device-auth 第一步响应。
#[derive(Debug, Clone, Deserialize)]
pub struct UserCodeResponse {
    pub device_auth_id: String,
    #[serde(alias = "usercode")]
    pub user_code: String,
    /// 轮询间隔秒——服务端可能返回数字或字符串（官方 CLI 兼容两种）。
    #[serde(default, deserialize_with = "deserialize_u64_lenient")]
    pub interval: u64,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// 容忍 interval 为数字或字符串（服务端两形态并存——官方 CLI deserialize_interval 同款）。
fn deserialize_u64_lenient<'de, D>(d: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct V;
    impl<'de> serde::de::Visitor<'de> for V {
        type Value = u64;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("数字或数字字符串")
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<u64, E> {
            Ok(v)
        }
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<u64, E> {
            Ok(v.max(0) as u64)
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<u64, E> {
            v.trim().parse().map_err(E::custom)
        }
    }
    d.deserialize_any(V)
}

/// 轮询批准后的授权码 + PKCE verifier。
#[derive(Debug, Clone, Deserialize)]
pub struct PollApproved {
    pub authorization_code: String,
    /// 服务端返回的 PKCE challenge——本流程不主动验证（verifier 已随授权码
    /// 回传；code_challenge 保留供未来响应校验/审计）。非消费字段。
    #[allow(dead_code)]
    pub code_challenge: String,
    pub code_verifier: String,
}

/// token 交换结果。
#[derive(Debug, Clone, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: String,
    /// 绝对过期时间（epoch 秒）——缺失按 0（未知）。
    #[serde(default)]
    pub expires_in: Option<u64>,
}

/// device 流程的完整上下文（第一步结果，供 UI 展示 + 后续轮询）。
#[derive(Debug, Clone, Serialize)]
pub struct DeviceFlowStart {
    pub verification_uri: String,
    pub user_code: String,
    pub device_auth_id: String,
    pub interval: u64,
    /// 过期 epoch 秒（0 = 未知）。
    pub expires_at: i64,
}

/// 向 OpenAI 请求 user code（第一步）。
pub async fn request_user_code(
    issuer: &str,
    client_id: &str,
) -> Result<UserCodeResponse, String> {
    let url = format!("{issuer}/api/accounts/deviceauth/usercode");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "client_id": client_id }).to_string())
        .send()
        .await
        .map_err(|e| format!("deviceauth usercode 请求失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "deviceauth usercode 失败（HTTP {status}）: {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str(&body).map_err(|e| format!("解析 usercode 响应失败: {e} — {body}"))
}

/// 轮询批准（第三步）。返回 Ok(Some) = 已批准拿到授权码；Ok(None) = 未批准
/// （调用方 sleep interval 后继续轮询）。瞬时网络错内部短退避重试，不终止。
pub async fn poll_device_token(
    issuer: &str,
    device_auth_id: &str,
    user_code: &str,
) -> Result<Option<PollApproved>, String> {
    let url = format!("{issuer}/api/accounts/deviceauth/token");
    let client = reqwest::Client::new();
    for attempt in 0..3 {
        match client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(
                serde_json::json!({ "device_auth_id": device_auth_id, "user_code": user_code })
                    .to_string(),
            )
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                // 未批准/等待 → 继续轮询（RFC 8628：authorization_pending）
                if status == reqwest::StatusCode::FORBIDDEN
                    || status == reqwest::StatusCode::NOT_FOUND
                {
                    return Ok(None);
                }
                let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
                if !status.is_success() {
                    // expired_token/access_denied 等终态——错误上报
                    return Err(format!(
                        "deviceauth token 轮询失败（HTTP {status}）: {}",
                        body.chars().take(300).collect::<String>()
                    ));
                }
                return serde_json::from_str(&body)
                    .map(Some)
                    .map_err(|e| format!("解析轮询响应失败: {e} — {body}"));
            }
            Err(e) => {
                // 瞬时网络错：短退避重试（zylos 教训——单次 reset 不该终止登录）
                if attempt == 2 {
                    return Err(format!("deviceauth token 轮询网络失败: {e}"));
                }
                tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt + 1))).await;
            }
        }
    }
    unreachable!("attempt 循环必返回")
}

/// 用授权码交换 token（第四步）。
pub async fn exchange_code_for_tokens(
    issuer: &str,
    client_id: &str,
    authorization_code: &str,
    code_verifier: &str,
) -> Result<TokenSet, String> {
    let url = format!("{issuer}/oauth/token");
    let redirect_uri = format!("{issuer}/deviceauth/callback");
    let client = reqwest::Client::new();
    // reqwest 无 form feature（default-features=false）——手拼 x-www-form-urlencoded
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", authorization_code)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("client_id", client_id)
        .append_pair("code_verifier", code_verifier)
        .finish();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("oauth/token 交换失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "oauth/token 交换失败（HTTP {status}）: {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str(&body).map_err(|e| format!("解析 token 响应失败: {e} — {body}"))
}

/// 用 refresh_token 续期（登录后的长寿命刷新）。
pub async fn refresh_tokens(
    issuer: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenSet, String> {
    let url = format!("{issuer}/oauth/token");
    let client = reqwest::Client::new();
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "refresh_token")
        .append_pair("client_id", client_id)
        .append_pair("refresh_token", refresh_token)
        .finish();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("oauth/token 刷新失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "oauth/token 刷新失败（HTTP {status}）: {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str(&body).map_err(|e| format!("解析刷新响应失败: {e} — {body}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_code_resp_accepts_usercode_alias() {
        let raw = r#"{"device_auth_id":"da1","usercode":"ABCD-EFGH","interval":"5","expires_at":123}"#;
        let parsed: UserCodeResponse = serde_json::from_str(raw).expect("parse");
        assert_eq!(parsed.device_auth_id, "da1");
        assert_eq!(parsed.user_code, "ABCD-EFGH");
        assert_eq!(parsed.interval, 5); // string interval 容忍
    }

    #[test]
    fn user_code_resp_accepts_snake_field() {
        let raw = r#"{"device_auth_id":"da1","user_code":"XYZW","interval":10}"#;
        let parsed: UserCodeResponse = serde_json::from_str(raw).expect("parse");
        assert_eq!(parsed.user_code, "XYZW");
        assert_eq!(parsed.interval, 10);
        assert!(parsed.expires_at.is_none());
    }

    #[test]
    fn poll_approved_shape() {
        let raw = r#"{"authorization_code":"auth-code-1","code_challenge":"cc1","code_verifier":"cv1"}"#;
        let parsed: PollApproved = serde_json::from_str(raw).expect("parse");
        assert_eq!(parsed.authorization_code, "auth-code-1");
        assert_eq!(parsed.code_verifier, "cv1");
    }

    #[test]
    fn token_set_shape() {
        let raw = r#"{"access_token":"at1","refresh_token":"rt1","id_token":"it1","expires_in":3600}"#;
        let parsed: TokenSet = serde_json::from_str(raw).expect("parse");
        assert_eq!(parsed.access_token, "at1");
        assert_eq!(parsed.refresh_token, "rt1");
        assert_eq!(parsed.id_token, "it1");
        assert_eq!(parsed.expires_in, Some(3600));
    }
}
