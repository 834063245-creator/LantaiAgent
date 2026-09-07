// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Live Provider — 无状态协议适配器（Phase C，2026-08-24 工作区归属根治；
// 方案甲 2026-08-27 增加会话级 model/thinking 覆盖）。
//
// 形态对标 DSH（llm-pi-ai adapter）：provider 对象只携带「提供方名」这一
// 身份，baseUrl / apiKey 每次使用点（stream / prewarm / fetchModels）按名
// 现解析（resolveProviderRuntime：settings 同步读 + 凭据内存缓存，见
// provider/credentials.ts）。效果：
//   - Agent/会话的构造与存在性彻底与 Key 无关——无 Key 冷启动照样装配；
//     缺 Key 的表现 = 请求期 MISSING_CREDENTIAL 响亮报错（不静默回退）
//   - 设置保存后即刻生效（无需换引用/重启）
//
// 方案甲（2026-08-27）：会话级模型/思考真生效。live provider 增加
// 「会话覆盖」——model / thinking 可在构造时指定，运行时 setThinking 更新
// thinking 覆盖（不再 no-op）。语义：
//   - 覆盖缺省（undefined）= 该维度按 provider 行的 settings 值现解析
//     （未改过的卷实时跟随全局默认——方案甲语义 3）；
//   - 覆盖存在 = 该维度用会话值（改过的卷不跟随全局——方案甲语义 4）；
//   - thinking 覆盖区分 undefined（回落行值）与 ''（显式自动 = 不发参数）。

import { type ProviderSettings, providerId } from '../settings';
import { resolveOauthToken, resolveProviderRuntime } from './credentials';
import { type CreateProviderOptions, createProvider } from './index';
import { buildOauthHeaders } from './oauth';
import type { StoredThinking } from './thinking';
import type { Chunk, ModelDescriptor, Provider, Request } from './types';

/** 会话级覆盖：undefined = 该维度跟随 provider 行的 settings 值。 */
export interface LiveProviderOverrides {
  model?: string;
  thinking?: StoredThinking;
}

export function createLiveProvider(
  name: string,
  options?: CreateProviderOptions,
  overrides?: LiveProviderOverrides,
): Provider {
  const pid = providerId(name);
  const resolve = () => resolveProviderRuntime(pid);
  // 覆盖槽（可变 holder——setThinking 运行时改写，stream 每请求现读）
  const overrides_: { model?: string; thinking?: StoredThinking } = { ...overrides };

  /** async 装配内层 provider：apiKey 路径（resolveApiKey）或 oauth 路径
   *  （resolveOauthToken → oauthHeaders）。OAuth 时 apiKey 置空占位——
   *  方言（responses）经 oauthHeaders 的 Authorization 注入。
   *  ⚡ oauth 模式未登录（resolveOauthToken 返回 null）→ 响亮报错——
   *  绝不静默发空 Bearer 请求落 401/403（错误不静默，提示直指登录）。 */
  const buildInner = async (rt: { provider: ProviderSettings; apiKey: string }) => {
    // OAuth 模式：解析 grant → 注入头（token 过期 Rust 侧自动刷新）
    let oauthHeaders: Record<string, string> | undefined;
    let apiKey = rt.apiKey;
    if (rt.provider.authMode === 'oauth' && rt.provider.oauthProvider) {
      const oauth = await resolveOauthToken(rt.provider);
      if (!oauth) {
        throw new Error(
          `OAUTH_NOT_LOGGED_IN: 提供方「${name}」的订阅账号未登录或会话已失效——设置 → Provider → 该行先完成 OAuth 登录`,
        );
      }
      oauthHeaders = buildOauthHeaders(oauth);
      apiKey = ''; // oauth 路径无 apiKey——Authorization 走 oauthHeaders
    }
    return createProvider(
      {
        ...rt.provider,
        apiKey,
        ...(overrides_.model !== undefined ? { model: overrides_.model } : {}),
        thinking: overrides_.thinking !== undefined ? overrides_.thinking : rt.provider.thinking,
      },
      { ...options, oauthHeaders },
    );
  };

  return {
    name() {
      return name;
    },
    setThinking(cfg: StoredThinking | undefined): void {
      // 方案甲：cfg = undefined 清除覆盖（回落 provider 行值）；''/档位 = 会话覆盖
      overrides_.thinking = cfg;
    },
    async *stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      const rt = await resolve();
      if (!rt) {
        throw new Error(`LIVE_PROVIDER: 提供方「${name}」已不在设置中——请在设置 → Provider 检查后重试`);
      }
      // OAuth provider 无 apiKey——凭据 = 系统 OAuth grant（resolveOauthToken）
      const needsOauth = rt.provider.authMode === 'oauth';
      if (!rt.apiKey && !needsOauth) {
        throw new Error(`MISSING_CREDENTIAL: 提供方「${name}」未配置 API Key——设置 → Provider 填写并保存后直接重试`);
      }
      const inner = await buildInner(rt);
      yield* inner.stream(signal, req);
    },
    prewarm(): void {
      void resolve()
        .then(async (rt) => {
          if (!rt) return;
          const needsOauth = rt.provider.authMode === 'oauth';
          if (!rt.apiKey && !needsOauth) return; // 无 Key 不预热（无谓的 401 噪音）
          const inner = await buildInner(rt);
          inner.prewarm?.();
        })
        .catch(() => {
          /* best-effort 预热 */
        });
    },
    async fetchModels(): Promise<ModelDescriptor[]> {
      const rt = await resolve();
      if (!rt) return [];
      const needsOauth = rt.provider.authMode === 'oauth';
      if (!rt.apiKey && !needsOauth) return [];
      const inner = await buildInner(rt);
      return inner.fetchModels?.() ?? [];
    },
  };
}
