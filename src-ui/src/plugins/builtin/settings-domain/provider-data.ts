// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// settings-domain · Provider 编辑面数据（批 9f-1，2026-09-26）。
//
// 来源：内核 `settings.ts` 里**只有本产物取用**的七个符号（施工单
// docs/plans/provider-data-face-homing-design.md §2.1 A 桶，符号级矩阵实测）——
// 逐字搬移、零改写。搬它的两个理由：
//   ① 「provider 编辑面」是产品内容（设置页的探针/默认端点判定/增删提供方/凭据写面），
//      随包后改这些逻辑免重建 exe；
//   ② 原先 `ProviderDetail.tsx` / `ProviderPage.tsx` **直接 import 内核 `../../../settings`**
//      取值 ⇒ 产物域 esbuild 把整个 `settings.ts`（含模块级状态：保存订阅表 / provider 投影）
//      内联成**副本**——§0.6 同族病灶，本批一并消除（改指本文件与 `./host`）。
//
// 留内核的邻居（判据见施工单）：`loadSettings` / `saveSettings` / `onSettingsSaved` /
// `canvasWheelMode` / `effectiveModels`（多产物共用）· `defaultBaseUrl` / `modelMaxTokens` /
// `PROVIDER_PROTOCOL_DEFAULTS`（内核自用或端点真源单点）⇒ 经 `./host` 取用。

import type { Protocol } from '../../../provider/types';
import type { AppSettings, ProviderId } from '../../../settings';
import {
  defaultBaseUrl,
  getCatalogVendors,
  getDefaultModel,
  PROVIDER_PROTOCOL_DEFAULTS,
  VENDOR_TEMPLATES,
} from './host';

export type { ConnectionProbe, ProbeOutcome } from '../../../settings';

/** 是否仍是「出厂默认」Base URL（协议默认、模板默认或目录厂商默认）——
 *  设置面板模型切换时的 baseUrl 自动填充判定（用户自定义过就不覆盖）。 */
export function isFactoryBaseUrl(url: string): boolean {
  const defaults = new Set<string>(Object.values(PROVIDER_PROTOCOL_DEFAULTS));
  for (const tpl of VENDOR_TEMPLATES) {
    if (tpl.baseUrl) defaults.add(tpl.baseUrl);
  }
  for (const name of getCatalogVendors()) {
    const u = getDefaultModel(name)?.baseUrl;
    if (u) defaults.add(u);
  }
  return defaults.has(url);
}

/** 将 API Key 持久化到系统加密存储（DPAPI on Windows），防止 localStorage 被清丢 Key。
 *  ⚡ 2026-08-04：apiKey 唯一权威在此 — 保存设置时同步写入凭据。
 *  ⚡ 2026-08-07 修正：空 key **不再执行 delete**——state 与凭据可能因异步回填
 *  暂时不同步（restoreSecrets 未完成时遍历会把未回填的 provider 误删）。
 *  删除凭据只走两个明确场景：removeProvider（removeSecret）与用户主动清空
 *  输入框（手动落盘后保存空 key 不会删凭据——清空需走 removeProvider）。 */
export async function persistSecrets(s: AppSettings): Promise<string[]> {
  const failed: string[] = [];
  const withKey = s.providers.filter((p) => {
    const k = (p.apiKey || '').trim();
    return k && k !== 'null';
  });
  try {
    const { typedRpc } = await import('../../../rpc-contract');
    for (const p of withKey) {
      // withKey 过滤保证 apiKey 非空；双重守卫防漏
      const rawKey = p.apiKey;
      if (!rawKey) continue;
      const key = rawKey.trim();
      // 「null」字面量护栏：毒化残留的 apiKey:"null" 绝非真 key，绝不写入凭据库
      try {
        await typedRpc('credential_store', { provider: p.name, key });
      } catch (e) {
        // 雷区地图 P0-7：写失败必须上抛给 UI——「失败报已保存」会让用户重启丢 key
        console.warn(`[settings] credential_store(${p.name}) 失败:`, e);
        failed.push(p.name);
      }
    }
    // Phase C（2026-08-24）：写穿失效凭据内存缓存——live provider 每请求按名
    // 现解析（provider/credentials.ts），不失效则保存后仍读到旧值。动态 import
    // 防环（credentials → settings 静态依赖，此处反向只可运行时引）。
    const { invalidateCredentialCache } = await import('../../../provider/credentials');
    for (const p of withKey) invalidateCredentialCache(p.name);
  } catch (e) {
    console.warn('[settings] bridge 不可用，凭据未落盘:', e);
    failed.push(...withKey.map((p) => p.name));
  }
  return failed;
}

/** 删除指定 provider 的 API Key from 系统加密存储（DPAPI）。
 *  调用时机：保存「删除 Provider」或「清除已保存 Key」的暂存操作时。 */
export async function removeSecret(providerName: ProviderId): Promise<void> {
  try {
    const { typedRpc } = await import('../../../rpc-contract');
    await typedRpc('credential_delete', { provider: providerName });
    // Phase C：写穿失效凭据缓存（同 persistSecrets——见上注释）
    const { invalidateCredentialCache } = await import('../../../provider/credentials');
    invalidateCredentialCache(providerName);
  } catch {
    /* 无加密存储或 Key 未找到 — 非关键 */
  }
}

export function addProvider(s: AppSettings, name: ProviderId, kind: Protocol): AppSettings {
  if (s.providers.find((p) => p.name === name)) {
    throw new Error(`提供方 "${name}" 已存在`);
  }
  const baseUrl = defaultBaseUrl(name, kind);
  return {
    ...s,
    activeProvider: name,
    providers: [
      ...s.providers,
      {
        kind,
        name,
        apiKey: '',
        // 模板/目录命中 = 出厂默认端点；未知协议无模板 = 空串（两步式添加的
        // onAdd 随后会带真实 baseUrl 覆盖；直接 addProvider 时需手填）。
        baseUrl: baseUrl ?? '',
        model: '',
      },
    ],
  };
}

export function removeProvider(s: AppSettings, name: string): AppSettings {
  const idx = s.providers.findIndex((p) => p.name === name);
  if (idx < 0) throw new Error(`提供方 "${name}" 不存在`);
  if (s.providers.length <= 1) throw new Error('至少保留一个提供方');
  const next = s.providers.filter((p) => p.name !== name);
  const active = s.activeProvider === name ? next[0].name : s.activeProvider;
  return { ...s, activeProvider: active, providers: next };
}
