// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. All rights reserved.
// SPDX-License-Identifier: MIT

// provider 上路可达性（2026-09-13 诊断）——「不可恢复」类故障降级为「可见的失败」。
//
// 背景：诊断「模型不响应」时发现，整条链路只有一层活性守卫（`provider/idle-stream`
// 的 30s 空闲超时），而它只能 `ctrl.abort()` 一个 fetch——掐不断一个不理会 signal
// 的 await。而请求**上路之前**要过几个本机 IPC（代理端口 / 凭据 / OAuth grant），
// 它们既无超时、又把结果（含失败结果）永久缓存：
//   - `getProxyPort`：一次瞬态失败 → 进程此后恒走直连（对 CORS 不放行的厂商
//     等于每个请求都失败），直到重启；
//   - `resolveApiKey`：一次 IPC 抛错 → 被记成「这个提供方没有 Key」→ 恒报
//     MISSING_CREDENTIAL，而设置里 Key 明明在；
//   - `resolveOauthToken`：同款负缓存（把瞬态故障记成「未登录」）。
// 三者共同点：**失败被伪装成配置事实，且不可恢复**——用户除了重启毫无出路，
// 日志里连一行都没有。
//
// 本文件钉两件事：
//   ① 本机 IPC 卡死时，解析**有限时间内落定**（不无限 await）；
//   ② 解析失败**不留粘性缓存**：故障恢复后下一次请求能自己好。
// 外加一条同类修正：signal 已中止时的传输失败不得回退重发（一次取消 = 一次取消）。

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }));

import {
  _resetCredentialCacheForTests,
  invalidateOauthCache,
  type ResolvedOAuth,
  resolveApiKey,
  resolveOauthToken,
} from '../src/provider/credentials';
import { getProxyPort, PORT_RPC_TIMEOUT_MS, proxyFetch, resetProxyPort } from '../src/provider/transport';
import { providerId } from '../src/settings';

/** 永不落定的 promise —— 模拟 Rust 侧卡死 / 回包丢失。 */
const never = () => new Promise<never>(() => {});

/** 推进假时钟并把微任务排干（动态 import + promise 链都在微任务面）。 */
async function advance(ms: number, flushes = 8): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < flushes; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  mockRpc.mockReset();
  resetProxyPort();
  _resetCredentialCacheForTests();
  invalidateOauthCache(); // 模块级 OAuth 缓存（含负结果）跨用例存活，逐例清
  globalThis.fetch = vi.fn(async () => new Response('direct', { status: 200 })) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('② 代理端口解析（llm_proxy_port）', () => {
  it('IPC 卡死 → 超时后回退直连（有限时间落定，不无限 await）', async () => {
    vi.useFakeTimers();
    mockRpc.mockImplementation(() => never());

    let settled = -1;
    void getProxyPort().then((p) => {
      settled = p;
    });
    await advance(PORT_RPC_TIMEOUT_MS + 100);

    expect(settled, `${PORT_RPC_TIMEOUT_MS}ms 后仍未落定 = 无界 await`).toBe(0);
  });

  it('IPC 卡死超时后**不粘**：故障恢复后下一次调用重新解析拿到端口', async () => {
    vi.useFakeTimers();
    mockRpc.mockImplementation(() => never());

    const first = getProxyPort();
    await advance(PORT_RPC_TIMEOUT_MS + 100);
    expect(await first).toBe(0);

    // 后端恢复
    mockRpc.mockReset();
    mockRpc.mockResolvedValue('14570');
    // 旧实现：失败结果被永久钉住 → 这里仍是 0（此后恒走直连，直到重启）
    expect(await getProxyPort(), '一次瞬态失败把进程永久钉在直连上').toBe(14570);
  });
});

describe('② 凭据解析（credential_get）', () => {
  it('IPC 抛错 → 本次按无 key 处理，但**不进负缓存**（故障恢复后能自己好）', async () => {
    mockRpc.mockRejectedValueOnce(new Error('背板未就绪'));
    expect(await resolveApiKey(providerId('p1'))).toBe('');

    // 故障恢复（Key 一直在设置里）
    mockRpc.mockResolvedValue(JSON.stringify('sk-real'));
    // 旧实现：'' 被写进 _keyCache → 这里恒为 ''，整个进程生命周期报 MISSING_CREDENTIAL
    expect(await resolveApiKey(providerId('p1')), '瞬态 IPC 故障被记成「没有 Key」').toBe('sk-real');
  });

  it('确实没有 Key（解析出 null）→ 负缓存仍然有效（不重复 IPC）', async () => {
    mockRpc.mockResolvedValue('null');
    expect(await resolveApiKey(providerId('p1'))).toBe('');
    expect(await resolveApiKey(providerId('p1'))).toBe('');
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('IPC 卡死 → 超时后落定为「无 key」（不无限 await 卡死整轮对话）', async () => {
    vi.useFakeTimers();
    mockRpc.mockImplementation(() => never());

    let settled: string | null = null;
    void resolveApiKey(providerId('p1')).then((k) => {
      settled = k;
    });
    await advance(10_000 + 100);

    expect(settled).toBe('');
  });
});

describe('② OAuth grant 解析（oauth_access）', () => {
  const prov = {
    name: 'claude-sub',
    authMode: 'oauth' as const,
    oauthProvider: 'anthropic',
  } as unknown as Parameters<typeof resolveOauthToken>[0];

  it('真「未登录」（OAUTH_NO_GRANT）→ 负缓存有效', async () => {
    mockRpc.mockRejectedValue(new Error('OAUTH_NO_GRANT: provider "anthropic" 无已登录账号——请先登录'));
    expect(await resolveOauthToken(prov)).toBeNull();
    expect(await resolveOauthToken(prov)).toBeNull();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('IPC 抛错（非未登录）→ **不进负缓存**：恢复后拿到 token', async () => {
    mockRpc.mockRejectedValueOnce(new Error('rpc oauth_access 超时（30000ms）'));
    expect(await resolveOauthToken(prov)).toBeNull();

    mockRpc.mockResolvedValue(JSON.stringify({ access_token: 'tok', account_id: 'a1', expires_at: 999 }));
    const got = (await resolveOauthToken(prov)) as ResolvedOAuth | null;
    expect(got?.accessToken, '瞬态 IPC 故障被记成「未登录」，账号其实登着').toBe('tok');
  });
});

describe('① 传输边界：中止不得变成重发', () => {
  it('signal 已中止 → 代理层失败直接上抛，不回退直连（一次取消 = 一次请求）', async () => {
    mockRpc.mockResolvedValue('14570');
    const fetchSpy = vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      proxyFetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctrl.signal }),
    ).rejects.toThrow(/abort/i);
    expect(fetchSpy, '中止被吞掉后又重发了一次直连请求').toHaveBeenCalledTimes(1);
  });
});
