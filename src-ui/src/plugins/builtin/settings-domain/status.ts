// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页「提供方状态」推导 — 唯一事实源：
// 无 Key 且从未测通 = 未配置；有 Key 且最近测试通过 = 正常；有 Key 且最近测试失败 = 异常；
// 有 Key 但从未测试（或测试结果丢失）= 已配置。
//
// ⚡ 2026-09-28 无 Key 放行批：**测通优先于有没有 Key**（空 Key 也能是正常行——
// 本地端点本不需要 Key；顺序见 providerStatus）。
//
// ⚡ oauth 订阅（2026-09）：authMode='oauth' 的 provider 无 apiKey——登录态 =
// 运行期系统 grant（oauthLoggedIn 由调用方从账号清单得出）。已登录且测试通过
// = 正常；已登录未测 = 已配置；未登录 = 未配置。

import type { ConnectionProbe, ProviderSettings } from '../../../settings';
import { credentialRevision } from './host';

export type ProviderStatus = 'unconfigured' | 'configured' | 'ok' | 'fail';

export const STATUS_LABEL: Record<ProviderStatus, string> = {
  unconfigured: '未配置',
  configured: '已配置',
  ok: '正常',
  fail: '异常',
};

type ProbeConfig = Pick<
  ProviderSettings,
  'name' | 'kind' | 'baseUrl' | 'model' | 'authMode' | 'oauthProvider' | 'headers' | 'apiKey'
>;

/** Non-secret connection identity used to decide whether a probe still applies. */
export function providerConnectionFingerprint(p: ProbeConfig): string {
  const headers = Object.entries(p.headers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => name + ':' + value)
    .join('|');
  return JSON.stringify([
    p.kind,
    p.baseUrl.trim(),
    p.model.trim(),
    p.authMode ?? 'api-key',
    p.oauthProvider ?? '',
    p.apiKey.trim().length,
    // R4：Key 同长度替换也必须让旧探针失效。revision 只在本应用真实写入/删除
    // 凭据时推进；摘要不进入指纹，避免在 lastTest 里多暴露一份 Key 派生值。
    credentialRevision(p.name),
    headers,
  ]);
}

export function probeMatchesProvider(p: ProbeConfig, probe: ConnectionProbe | undefined): boolean {
  return probe?.fingerprint !== undefined && probe.fingerprint === providerConnectionFingerprint(p);
}

export function providerStatus(
  p: ProbeConfig & Pick<ProviderSettings, 'lastTest'>,
  oauthLoggedIn = false,
): ProviderStatus {
  const probe = probeMatchesProvider(p, p.lastTest) ? p.lastTest : undefined;
  // oauth 订阅：登录态由系统 grant 决定（apiKey 恒空）
  if (p.authMode === 'oauth') {
    if (!oauthLoggedIn) return 'unconfigured';
    if (probe?.status === 'ok') return 'ok';
    if (probe?.status === 'fail') return 'fail';
    return 'configured';
  }
  // ⚡ 2026-09-28 无 Key 放行批：**探针通过优先于「有没有 Key」**——空 Key 也能
  //   是正常行（本地端点本不需要 Key），测通了却显示「未配置」是自相矛盾的读数
  //   （用户报「本地模型是不是必须填 Key」的一半来源）。没测过的空 Key 行仍显示
  //   「未配置」：那如实说的是「这行还没有 Key」，不是「不能用」。
  if (probe?.status === 'ok') return 'ok';
  if (!p.apiKey?.trim()) return 'unconfigured';
  if (probe?.status === 'fail') return 'fail';
  return 'configured';
}

export function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function formatTestAt(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
