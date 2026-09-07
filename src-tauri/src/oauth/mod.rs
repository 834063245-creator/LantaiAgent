// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OAuth 订阅平面（provider-refactor 方案乙 Phase 3，2026-09）——
// Rust 侧承载订阅类 provider 的 OAuth 登录（首批 ChatGPT Codex device-code）。
//
// 分层：
//   - device_flow.rs  通用 device-code 轮询原语（POST user_code → 展示 → 轮询 token）
//   - providers.rs    provider 注册表（首批 codex；预留 claude-pro/github-copilot/
//                     grok-xai 挂点）+ 请求注入面（Authorization/account-id/originator）
//   - grant store     经 crate::credential 的 oauth grant 平面（复用 OS 加密 + 写锁）
//
// 凭证形状（存 grant store，provider::account_id 复合键）：
//   { type:'oauth', access, refresh, expires_at, account_id, scope? }
//
// 生命周期（前端 provider/oauth.ts 编排）：
//   oauth_start(provider) → { verification_uri, user_code, device_code, interval }
//     → 前端 open_external 打开浏览器 + 展示 code
//   oauth_poll(provider, device_code) → 轮询直到授权成功/过期/失败
//   oauth_accounts(provider) → 已存 grant 列表（账号管理：设默认/登出/刷新）
//   oauth_set_default / oauth_logout / oauth_refresh
//   open_external(url) → 系统浏览器打开授权页

pub mod device_flow;
pub mod providers;

pub use device_flow::DeviceFlowStart;
use serde::{Deserialize, Serialize};

/// OAuth grant 凭证（存 credential 平面，复合键 `oauth:{provider}::{account_id}`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthGrant {
    #[serde(rename = "type")]
    pub kind: String, // "oauth"
    pub provider: String,
    pub access_token: String,
    pub refresh_token: String,
    /// epoch 秒（0 = 永不过期/未知——按需刷新判断）
    pub expires_at: i64,
    pub account_id: String,
    pub scope: Option<String>,
}

/// oauth grant 在 credential map 中的键前缀（与 apiKey 平面隔离）。
pub const OAUTH_KEY_PREFIX: &str = "oauth:";
