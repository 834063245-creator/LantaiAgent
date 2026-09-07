// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OAuth 订阅登录前端封装（provider-refactor 方案乙 Phase 3D）——
// 包 Rust 侧 oauth_* / open_external RPC：device-code 流程编排 + 账号管理 +
// token 解析（请求注入面经 live provider 行级解析扩展）。
//
// 设计要点：
//   - 全程不落 access/refresh 到 localStorage——grant 只存 Rust 系统加密凭据
//     （oauth grant 平面）；本模块只持有「当前进行中的 device 流程」与
//     「账号元数据」（account_id 等非敏感面）。
//   - 请求注入（Authorization: Bearer + chatgpt-account-id + originator）由
//     Responses provider 的 extraHeaders 承担——live provider 层解析 oauth
//     模式时从 grant 取 access_token 注入（见 credentials.ts resolveOauthToken）。
//   - 轮询由本模块按 interval 驱动（每拍一次 oauth_poll），期间可取消
//     （AbortSignal/主动 stop）。

import { parseJson, typedRpc } from '../rpc-contract';
import type { ProviderId } from '../settings';

/** device-code 流程起始信息（Rust oauth_start 返回）。 */
export interface DeviceFlowStart {
  verification_uri: string;
  user_code: string;
  device_auth_id: string;
  interval: number;
  expires_at: number;
}

/** 账号元数据（oauth_accounts 返回条目——不含敏感 token）。 */
export interface OAuthAccountMeta {
  provider: string;
  account_id: string;
  expires_at: number;
  scope?: string | null;
}

/** OAuth grant（oauth_poll/oauth_refresh 完成态；含敏感面但仅进程内传递）。
 *  落库在 Rust——此处返回用于一次性装配 Provider 请求注入。 */
export interface OAuthGrant {
  kind: 'oauth';
  provider: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id: string;
  scope?: string | null;
}

/** 发起 device-code 流程。返回展示/轮询所需信息。 */
export async function oauthStart(provider: string): Promise<DeviceFlowStart> {
  const raw = await typedRpc('oauth_start', { provider });
  const parsed = parseJson<DeviceFlowStart | null>(raw);
  if (!parsed?.verification_uri || !parsed.user_code) {
    throw new Error(`oauth_start: 返回异常（${String(raw).slice(0, 200)}）`);
  }
  return parsed;
}

/** 轮询一拍：Ok(grant) = 授权完成；null = 未批准（调用方 sleep interval 后重试）。 */
export async function oauthPoll(provider: string, deviceAuthId: string, userCode: string): Promise<OAuthGrant | null> {
  const raw = await typedRpc('oauth_poll', {
    provider,
    device_auth_id: deviceAuthId,
    user_code: userCode,
  });
  if (raw === 'null' || raw === null) return null;
  return parseJson<OAuthGrant>(raw);
}

/** 账号清单（元数据）。 */
export async function oauthAccounts(provider: string): Promise<OAuthAccountMeta[]> {
  const raw = await typedRpc('oauth_accounts', { provider });
  const parsed = parseJson<OAuthAccountMeta[] | null>(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/** 登出某账号。 */
export async function oauthLogout(provider: string, accountId: string): Promise<void> {
  await typedRpc('oauth_logout', { provider, account_id: accountId });
}

/** 刷新 token 并回写 grant。返回新 grant。 */
export async function oauthRefresh(provider: string, accountId: string): Promise<OAuthGrant> {
  const raw = await typedRpc('oauth_refresh', { provider, account_id: accountId });
  return parseJson<OAuthGrant>(raw);
}

/** 系统浏览器打开授权页。 */
export async function openExternal(url: string): Promise<void> {
  await typedRpc('open_external', { url });
}

// ── device-code 编排（UI 登录按钮调用）──

export interface DeviceLoginCallbacks {
  /** 需要用户打开授权页输入 code 时调用（展示 URL + code）。 */
  onAwaitingUser: (flow: DeviceFlowStart) => void;
  /** 授权完成。 */
  onGranted: (grant: OAuthGrant) => void;
  /** 用户取消/失败。 */
  onError: (err: Error) => void;
  /** 是否已取消（外部 AbortSignal/UI 状态）。 */
  isCancelled?: () => boolean;
}

/** 完整 device-code 登录编排：
 *  oauth_start → 开浏览器 + onAwaitingUser 展示 code → 按 interval 轮询
 *  oauth_poll → 完成回调 onGranted；15 分钟超时/取消 → onError。
 *  @param openBrowser 默认 true（open_external 打开授权页）。 */
export async function runDeviceLogin(
  provider: string,
  callbacks: DeviceLoginCallbacks,
  opts: { openBrowser?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const openBrowser = opts.openBrowser ?? true;
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  let flow: DeviceFlowStart;
  try {
    flow = await oauthStart(provider);
  } catch (e) {
    callbacks.onError(e instanceof Error ? e : new Error(String(e)));
    return;
  }
  if (openBrowser) {
    try {
      await openExternal(flow.verification_uri);
    } catch (e) {
      // 浏览器打开失败不终止——用户可手动复制 URL
      console.warn('[oauth] open_external 失败（用户可手动打开授权页）:', e);
    }
  }
  callbacks.onAwaitingUser(flow);

  const deadline = Date.now() + timeoutMs;
  // interval 下限 3s（Rust 已保证），本地补 1s 抖动防同拍狂轮
  const intervalMs = Math.max(3000, flow.interval * 1000);
  try {
    // 第一拍立即（用户可能已秒批）；随后按 interval
    for (;;) {
      if (callbacks.isCancelled?.()) {
        callbacks.onError(new Error('登录已取消'));
        return;
      }
      if (Date.now() > deadline) {
        callbacks.onError(new Error('登录超时（15 分钟）——请重新发起'));
        return;
      }
      let grant: OAuthGrant | null = null;
      try {
        grant = await oauthPoll(provider, flow.device_auth_id, flow.user_code);
      } catch {
        // 单拍失败（网络瞬断）不终止——短退避后重试（对齐 Rust 轮询语义）
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (grant) {
        callbacks.onGranted(grant);
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } catch (e) {
    callbacks.onError(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Provider 名提升为 ProviderId（oauth 关联 settings provider 行）。 */
export function oauthProviderId(provider: string): ProviderId {
  return provider as ProviderId;
}

/** 请求注入面（live provider 装配 oauthHeaders）——参数形状与 credentials.
 *  ResolvedOAuth 结构同（自含接口防环：credentials 动态 import 本模块）。 */

/** Codex 订阅请求的注入头（除 Authorization 外对齐官方 Codex CLI 行为）。
 *  由 live provider 从 resolveOauthToken 结果构建，经 ProviderRuntimeArgs.
 *  oauthHeaders 传方言。 */
export function buildOauthHeaders(oauth: { accessToken: string; accountId: string }): Record<string, string> {
  return {
    Authorization: `Bearer ${oauth.accessToken}`,
    'chatgpt-account-id': oauth.accountId,
    originator: 'codex_cli_rs',
    version: '0.153.4',
    'user-agent': 'codex_cli_rs/0.153.4 (Lantai)',
  };
}
