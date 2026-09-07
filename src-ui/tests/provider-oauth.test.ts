// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OAuth 订阅前端封装守护（provider-refactor 方案乙 Phase 3D）：
//   - buildOauthHeaders：Codex 注入头形状（Bearer + chatgpt-account-id + originator）
//   - runDeviceLogin 编排：start → onAwaitingUser（展示 code）→ 轮询 →
//     onGranted / onError（取消/超时/失败）
//   - oauthPoll 对 "null" 与 grant JSON 的解析边界
//
// RPC mock 面：typedRpc 走 bridge.rpc（mock invoke）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// typedRpc → rpc → bridge.rpc —— mock bridge 层
const mockInvoke = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { buildOauthHeaders, oauthAccounts, oauthLogout, oauthPoll, oauthStart, runDeviceLogin } from '../src/provider/oauth';

/** 让下一次 typedRpc 调用返回指定 JSON 字符串。 */
function queueRpc(method: string, result: string): void {
  mockInvoke.mockImplementationOnce(async (_kind: string, args: { method: string }) => {
    if (args.method !== method) throw new Error(`unexpected rpc ${args.method}`);
    return result;
  });
}

describe('buildOauthHeaders（Codex 注入头）', () => {
  it('含 Bearer + chatgpt-account-id + originator 头', () => {
    const h = buildOauthHeaders({ accessToken: 'at1', accountId: 'user-9' });
    expect(h.Authorization).toBe('Bearer at1');
    expect(h['chatgpt-account-id']).toBe('user-9');
    expect(h.originator).toBe('codex_cli_rs');
  });
});

describe('oauth RPC 封装', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('oauthStart 解析 device flow 起始信息', async () => {
    queueRpc(
      'oauth_start',
      JSON.stringify({
        verification_uri: 'https://auth.openai.com/codex/device',
        user_code: 'ABCD-EFGH',
        device_auth_id: 'da1',
        interval: 5,
        expires_at: 0,
      }),
    );
    const flow = await oauthStart('codex');
    expect(flow.verification_uri).toBe('https://auth.openai.com/codex/device');
    expect(flow.user_code).toBe('ABCD-EFGH');
    expect(flow.device_auth_id).toBe('da1');
  });

  it('oauthStart 异常响应 → 抛错（错误不静默）', async () => {
    queueRpc('oauth_start', 'null');
    await expect(oauthStart('codex')).rejects.toThrow(/返回异常/);
  });

  it('oauthPoll："null" = 未批准 → null；grant JSON = 完成', async () => {
    queueRpc('oauth_poll', 'null');
    expect(await oauthPoll('codex', 'da1', 'CODE')).toBeNull();
    queueRpc(
      'oauth_poll',
      JSON.stringify({
        kind: 'oauth',
        provider: 'codex',
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: 0,
        account_id: 'user-1',
      }),
    );
    const grant = await oauthPoll('codex', 'da1', 'CODE');
    expect(grant?.access_token).toBe('at');
    expect(grant?.account_id).toBe('user-1');
  });

  it('oauthAccounts 解析账号清单（元数据）', async () => {
    queueRpc(
      'oauth_accounts',
      JSON.stringify([{ provider: 'codex', account_id: 'user-1', expires_at: 0, scope: null }]),
    );
    const accts = await oauthAccounts('codex');
    expect(accts).toHaveLength(1);
    expect(accts[0].account_id).toBe('user-1');
  });

  it('oauthLogout 透传 provider + account_id', async () => {
    let seen: unknown;
    mockInvoke.mockImplementationOnce(async (_kind: string, args: { method: string; params?: unknown }) => {
      seen = args.params;
      return 'null';
    });
    await oauthLogout('codex', 'user-1');
    expect(seen).toMatchObject({ provider: 'codex', account_id: 'user-1' });
  });
});

describe('runDeviceLogin（device-code 编排）', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('start → onAwaitingUser（展示 code）→ 轮询成功 → onGranted', async () => {
    // oauth_start
    mockInvoke.mockImplementationOnce(async () =>
      JSON.stringify({
        verification_uri: 'https://auth.openai.com/codex/device',
        user_code: 'CODE1',
        device_auth_id: 'da1',
        interval: 1,
        expires_at: 0,
      }),
    );
    // open_external
    mockInvoke.mockImplementationOnce(async () => 'null');
    // 第一拍 poll → 未批准（null）；第二拍 → grant
    mockInvoke.mockImplementationOnce(async () => 'null');
    mockInvoke.mockImplementationOnce(async () =>
      JSON.stringify({
        kind: 'oauth',
        provider: 'codex',
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: 0,
        account_id: 'user-1',
      }),
    );

    const awaiting: string[] = [];
    let granted = false;
    await runDeviceLogin('codex', {
      onAwaitingUser: (flow) => awaiting.push(flow.user_code),
      onGranted: () => {
        granted = true;
      },
      onError: (err) => {
        throw new Error(`不应 onError: ${err.message}`);
      },
      isCancelled: () => false,
    });
    expect(awaiting).toEqual(['CODE1']);
    expect(granted).toBe(true);
  });

  it('isCancelled 提前返回 → onError 取消', async () => {
    mockInvoke.mockImplementationOnce(async () =>
      JSON.stringify({
        verification_uri: 'https://auth.openai.com/codex/device',
        user_code: 'C',
        device_auth_id: 'da1',
        interval: 5,
        expires_at: 0,
      }),
    );
    let errMsg = '';
    await runDeviceLogin('codex', {
      onAwaitingUser: () => {},
      onGranted: () => {},
      onError: (err) => {
        errMsg = err.message;
      },
      isCancelled: () => true,
    });
    expect(errMsg).toContain('取消');
  });
});
