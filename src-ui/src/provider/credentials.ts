// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 凭据内存缓存 + 按名解析（Phase C，2026-08-24 工作区归属根治）。
//
// 形态对标 DSH credentials service：凭据不进 Models/Agent/provider 构造——
// 每次使用（live provider 发请求/预热/拉模型表）经 resolveApiKey(provider)
// 现解析。为避免每请求一次 credential_get IPC，这里加内存缓存：
//   - 命中即返回（含「已解析为空」的负缓存——空 Key 也是解析结果）
//   - 在途去重（并发 resolve 共享同一 promise）
//   - 写穿失效：persistSecrets（credential_store 成功后）与 removeSecret
//     （credential_delete）就地 invalidate——保存 Key 即刻生效，无需重启
// 模块级可变态归属（CONVENTIONS §1.10）：进程级键控缓存（键 = 提供方名，
// 生命周期 = 进程），写穿失效保证与系统凭据库一致。

import { loadSettings, type ProviderId, type ProviderSettings, parseRpcString } from '../settings';

const _keyCache = new Map<ProviderId, string>();
const _inflight = new Map<ProviderId, Promise<string>>();

/** 解析某提供方的 API Key（内存缓存 + 在途去重；空串 = 已解析为空）。 */
export async function resolveApiKey(name: ProviderId): Promise<string> {
  const cached = _keyCache.get(name);
  if (cached !== undefined) return cached;
  let p = _inflight.get(name);
  if (!p) {
    p = (async () => {
      let key = '';
      try {
        const { typedRpc } = await import('../rpc-contract');
        const stored = await typedRpc('credential_get', { provider: name });
        const parsed = parseRpcString(stored);
        // 长度护栏与 restoreSecrets 同规（INVARIANTS #11：>4096 必是毒值，拒收）
        if (parsed?.trim() && parsed.length <= 4096) key = parsed.trim();
      } catch {
        /* 无加密存储/解密失败 — 按无 key 处理（fail-loud 在使用点） */
      }
      _keyCache.set(name, key);
      return key;
    })();
    _inflight.set(name, p);
    p.finally(() => _inflight.delete(name)).catch(() => {});
  }
  return p;
}

// ── OAuth 订阅面（provider-refactor 方案乙 Phase 3D）──

/** OAuth 模式解析结果（authMode='oauth' 的 provider 运行时注入面）。
 *  敏感 token 只进程内持有，不落 localStorage。 */
export interface ResolvedOAuth {
  accessToken: string;
  accountId: string;
  expiresAt: number;
}

const _oauthCache = new Map<string, ResolvedOAuth | null>();

/** 解析 OAuth provider 的运行时注入面（access token + 账号 id）。
 *  provider 行 authMode !== 'oauth' → null（API Key 路径）。
 *  Rust oauth_access 负责取最近/指定账号 grant + 过期自动刷新——
 *  前端不持 refresh_token（刷新归 Rust，双写失效面归零）。
 *  ⚡ 只读缓存（含 null 负缓存）——oauth_logout/oauth_refresh 成功后
 *  invalidateOauthCache 写穿失效。 */
export async function resolveOauthToken(provider: ProviderSettings, accountId?: string): Promise<ResolvedOAuth | null> {
  if (provider.authMode !== 'oauth' || !provider.oauthProvider) return null;
  const cacheKey = `${provider.oauthProvider}::${provider.name}::${accountId ?? '*'}`;
  const cached = _oauthCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const { parseJson, typedRpc } = await import('../rpc-contract');
    const raw = await typedRpc('oauth_access', {
      provider: provider.oauthProvider,
      ...(accountId ? { account_id: accountId } : {}),
    });
    const grant = parseJson<{
      access_token: string;
      account_id: string;
      expires_at: number;
    }>(raw);
    const resolved: ResolvedOAuth = {
      accessToken: grant.access_token,
      accountId: grant.account_id,
      expiresAt: grant.expires_at,
    };
    _oauthCache.set(cacheKey, resolved);
    return resolved;
  } catch (e) {
    // OAUTH_NO_GRANT（未登录）/ 刷新失败 → 按无有效会话处理（fail-loud 使用点）
    console.warn('[oauth] resolveOauthToken 失败（provider 可能未登录/会话过期）:', e);
    _oauthCache.set(cacheKey, null);
    return null;
  }
}

/** 写穿失效（oauth_logout / oauth_refresh 成功后的缓存复位）。 */
export function invalidateOauthCache(provider?: string): void {
  if (provider !== undefined) {
    for (const key of [..._oauthCache.keys()]) {
      if (key.startsWith(`${provider}::`)) _oauthCache.delete(key);
    }
  } else {
    _oauthCache.clear();
  }
}

/** 提供方运行时配置（每次现取）：非凭据字段出自 settings（localStorage 同步
 *  读，零 IPC），凭据经 resolveApiKey（缓存）。提供方已不在设置中 → null
 *  （fail-loud 由使用点负责，不回退其他提供方）。 */
export async function resolveProviderRuntime(
  name: ProviderId,
): Promise<{ provider: ProviderSettings; apiKey: string } | null> {
  const ps = loadSettings().providers.find((p) => p.name === name);
  if (!ps) return null;
  const apiKey = await resolveApiKey(ps.name);
  return { provider: ps, apiKey };
}

/** 写穿失效：credential_store / credential_delete 成功后调用。 */
export function invalidateCredentialCache(name?: ProviderId): void {
  if (name !== undefined) {
    _keyCache.delete(name);
  } else {
    _keyCache.clear();
  }
}

/** 测试复位（生产不调用）。 */
export function _resetCredentialCacheForTests(): void {
  _keyCache.clear();
  _inflight.clear();
}
