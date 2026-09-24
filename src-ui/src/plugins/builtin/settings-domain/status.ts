// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页「提供方状态」推导 — 唯一事实源：
// 无 Key = 未配置；有 Key 且最近测试通过 = 正常；有 Key 且最近测试失败 = 异常；
// 有 Key 但从未测试（或测试结果丢失）= 已配置。
//
// ⚡ oauth 订阅（2026-09）：authMode='oauth' 的 provider 无 apiKey——登录态 =
// 运行期系统 grant（oauthLoggedIn 由调用方从账号清单得出）。已登录且测试通过
// = 正常；已登录未测 = 已配置；未登录 = 未配置。

import type { ProviderSettings } from '../../../settings';

export type ProviderStatus = 'unconfigured' | 'configured' | 'ok' | 'fail';

export const STATUS_LABEL: Record<ProviderStatus, string> = {
  unconfigured: '未配置',
  configured: '已配置',
  ok: '正常',
  fail: '异常',
};

export function providerStatus(
  p: Pick<ProviderSettings, 'apiKey' | 'lastTest' | 'authMode'>,
  oauthLoggedIn = false,
): ProviderStatus {
  // oauth 订阅：登录态由系统 grant 决定（apiKey 恒空）
  if (p.authMode === 'oauth') {
    if (!oauthLoggedIn) return 'unconfigured';
    if (p.lastTest?.status === 'ok') return 'ok';
    if (p.lastTest?.status === 'fail') return 'fail';
    return 'configured';
  }
  if (!p.apiKey?.trim()) return 'unconfigured';
  if (p.lastTest?.status === 'ok') return 'ok';
  if (p.lastTest?.status === 'fail') return 'fail';
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
