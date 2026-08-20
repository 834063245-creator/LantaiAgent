// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合 patch 装载器（S2-2）—— 用户层 roster.patch.yml 的读取管道。
//
// 通道：src-tauri/src/plugin_assets.rs 的 /composition/* 路由（挂在
// llm_proxy 的 127.0.0.1:14570 hyper 监听，端口经 llm_proxy_port RPC 运行时
// 解析——与 plugins/loader.ts 同一套通道纪律，不在 TS 侧硬编码端口）。
//
// 管道：fetch 文本 → YAML.parse → parseCompositionPatch（zod）→
// resolveRoster（纯函数）→ composition-store。任一步失败 → 整体拒绝
// （all-or-nothing）→ store setError + 回退出厂组合（resolved = factory，
// 装配面照常工作），错误进 console.error（可见不炸——用户级数据文件是
// 毒化源，INVARIANTS #11.2 纪律）。
//
// 非错误路径：无通道（浏览器 mock / 代理未起，getProxyPort 返回空）与
// 404（用户没写 patch 文件）都静默保持 factory 态——「没有 patch」不是
// 错误。其余非 ok（403/500/...）是通道异常 → setError 可见。
//
// 生效时机（S2 设计件 §2.4）：启动期一次；main.ts 持有 promise，
// init() 冷启动（switchWorkspace → setupAgent）前 await——保证第一个
// Agent 就拿到最终组合。改 patch 重启生效；热重载延期至 S4。

import { parse as parseYaml } from 'yaml';
import { factoryComposition, parseCompositionPatch, resolveRoster } from '../composition/roster';
import { getProxyPort } from '../provider/transport';
import { useCompositionStore } from '../state/composition-store';

/** loader 消费的最小 fetch 形状（测试可注入，不依赖 Response 全局）。 */
export type FetchTextLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** 测试注入面。 */
export interface LoadCompositionPatchOptions {
  /** 通道 origin（缺省经 llm_proxy_port RPC 解析）。 */
  origin?: string;
  /** fetch 实现（缺省全局 fetch）。 */
  fetchImpl?: FetchTextLike;
}

/** 组合 patch 通道 origin 构造（与 pluginAssetsOrigin 同一套端口解析）。 */
export function compositionOrigin(port: number): string {
  return 'http://127.0.0.1:' + port + '/composition';
}

/** 惰性解析通道 origin；'' = 无通道（无后端/代理未起 → factory，非错误）。 */
async function resolveOrigin(): Promise<string> {
  const port = await getProxyPort();
  if (!port) return '';
  return compositionOrigin(port);
}

/** 用户层 patch 文件名（通道固定文件——S2 单文件约定，overlay 层是 S4）。 */
const PATCH_FILENAME = 'roster.patch.yml';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 组合 patch 装载主入口（main.ts 引导期调用；永不 reject）。 */
export async function loadCompositionPatch(opts: LoadCompositionPatchOptions = {}): Promise<void> {
  const store = useCompositionStore.getState();
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const origin = opts.origin ?? (await resolveOrigin());
    if (!origin) return; // 无通道（浏览器 mock / 代理未起）——factory，非错误
    const res = await fetchImpl(origin + '/' + PATCH_FILENAME);
    if (res.status === 404) return; // 无用户层 patch——factory，非错误
    if (!res.ok) {
      // 通道异常（403/500/…）：可见 + factory 兜底
      const msg = '组合 patch 通道异常: HTTP ' + res.status;
      console.error('[composition] ' + msg);
      store.setError(msg, PATCH_FILENAME);
      return;
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (e) {
      const msg = 'YAML 语法错误: ' + errText(e);
      console.error('[composition] ' + msg);
      store.setError(msg, PATCH_FILENAME);
      return;
    }
    const validated = parseCompositionPatch(parsed);
    if (!validated.ok) {
      console.error('[composition] patch 校验失败:', validated.error);
      store.setError('patch 校验失败: ' + validated.error, PATCH_FILENAME);
      return;
    }
    // resolveRoster throw（未知 id / insert 撞 id / 锚点不存在）→ 整体拒绝
    const resolved = resolveRoster(factoryComposition(), [validated.patch]);
    store.setResolved(resolved, PATCH_FILENAME);
  } catch (e) {
    // 通道级失败（fetch 网络错 / resolveRoster throw）：可见 + factory 兜底
    console.error('[composition] 用户层 patch 装载失败:', e);
    useCompositionStore.getState().setError(errText(e), PATCH_FILENAME);
  }
}
