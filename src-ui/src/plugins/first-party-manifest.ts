// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方插件元数据清单（平台化收尾，2026-08-29；P1 扩充 2026-08-30；
// 增补四通道化收编 2026-08-31；2026-09-06 名册单一真源换轨）
// ——第一方插件的身份真源：14 个平台 service（内核，无目录非产物）手写于
// 本文件；31 个 feature（出厂产物）条目从 builtin-roster.json 派生
// （description 等清单事实唯一在名册，此处不双写）。
//
// 背景：平台化 P4-P6 之后，第一方插件经 plugins/loader.ts 的 BUILTIN_PLUGINS
// 表统一装载、经 ctx.* 贡献通道统一装配，但一直缺「清单身份」——没有
// version/description/分类，也进不了插件列表（plugin-store 只记录外部插件）。
// 本文件补齐这一层：name → { version, description, kind }，与 DSH 的
// profile bundles 清单同构（DSH 第一方插件在设置页可见、可管理，这里对齐）。
//
// 铁律：
//   - 覆盖全部第一方插件（45 = 14 service + 31 feature；多/缺条目 = 装配
//     断层，守护测试 tests/first-party-manifest.test.ts 钉死；loader 运行时
//     缺条目 = 跳过装载 + error 记录，错误不静默）。
//   - kind 分两类（S5 降级为展示分组标签——不再决定装载语义）：
//       service  = 内核插件（14 件注册表/运行时）——不提供禁用开关；
//       feature  = 出厂产物（31 件）——可禁用（plugin-prefs，下次启动生效），
//                  装载面 = 产物通道（dev 模式下走源码路径）；清单事实真源
//                  = builtin-roster.json（2026-09-06 起）。
//
// 使用方：plugins/loader.ts（装载时折算记录）、state/plugin-store.ts
// （PluginRecord.meta 类型）、app/panels/settings/PluginsPage.tsx（分组渲染）。

import { BUILTIN_ROSTER, builtinScopeName } from './builtin-roster';

export type FirstPartyPluginKind = 'service' | 'feature';

export interface FirstPartyPluginMeta {
  /** 必须与 BUILTIN_PLUGINS 条目 plugin.name 一致（守护测试钉死）。 */
  name: string;
  /** 随应用发布（src-ui/package.json version 镜像）。 */
  version: string;
  description: string;
  /** service = 平台服务（不可禁用）；feature = 功能插件（可禁用）。 */
  kind: FirstPartyPluginKind;
}

/** 第一方插件统一版本 = 应用版本（随应用一起发布，无独立版本线）。 */
export const FIRST_PARTY_VERSION = '0.1.0';

function meta(name: string, kind: FirstPartyPluginKind, description: string): FirstPartyPluginMeta {
  return { name, version: FIRST_PARTY_VERSION, kind, description };
}

/** 平台 service 元数据（14 个内核——无目录、非产物，唯一手写处；
 *  feature 条目见下，由名册派生，禁止在此手写 description 造成双源）。 */
const SERVICE_META: Record<string, FirstPartyPluginMeta> = {
  'hologram/composition-services': meta(
    'hologram/composition-services',
    'service',
    '组合层四 service 本体（panels/commands/tools/llm 注册表）',
  ),
  'hologram/subagents-service': meta('hologram/subagents-service', 'service', '子代理服务注册表（seam/subagents）'),
  'hologram/fs-service': meta('hologram/fs-service', 'service', '文件域服务注册表（seam/fs）'),
  'hologram/shell-service': meta('hologram/shell-service', 'service', '命令域服务注册表（seam/shell）'),
  'hologram/session-persistence-service': meta(
    'hologram/session-persistence-service',
    'service',
    '会话持久化服务注册表（seam/sessionPersistence）',
  ),
  'hologram/graph-service': meta('hologram/graph-service', 'service', '图谱域服务注册表（seam/graph）'),
  'hologram/composition-space': meta('hologram/composition-space', 'service', '空间服务（工作区/会话空间）'),
  'hologram/composition-overlays': meta('hologram/composition-overlays', 'service', '覆盖层服务'),
  'hologram/renderer-service': meta('hologram/renderer-service', 'service', '块渲染器注册表（第五贡献通道，后注册胜）'),
  'hologram/prompts-service': meta('hologram/prompts-service', 'service', 'system-prompt 段贡献注册表（第六通道）'),
  'hologram/hook-services': meta('hologram/hook-services', 'service', '工具管道钩子注册表（第七通道）'),
  'hologram/capability-services': meta('hologram/capability-services', 'service', '会话级能力贡献注册表（第八通道）'),
  'hologram/code-runtime': meta('hologram/code-runtime', 'service', 'code_execution 执行腰沙箱'),
  'hologram/dynamic-runner': meta(
    'hologram/dynamic-runner',
    'service',
    '运行时插件定义/执行（cordis 域，approval + 半沙箱）',
  ),
};

/** 第一方插件清单（key = 插件名；Record 注解允许字符串索引——loader/
 *  守护测试以运行时 name 寻址）。feature 条目按名册 buildOrder 派生
 *  （description 唯一真源 = builtin-roster.json——加/改 feature 文案
 *  只许改名册；本文件对 feature 零手写）。 */
export const FIRST_PARTY_MANIFEST: Record<string, FirstPartyPluginMeta> = {
  ...SERVICE_META,
  ...Object.fromEntries(
    BUILTIN_ROSTER.map((e) => [builtinScopeName(e.dir), meta(builtinScopeName(e.dir), 'feature', e.description)]),
  ),
};

/** 按插件名取第一方元数据（无 = null——外部插件/清单缺失）。 */
export function firstPartyMetaFor(name: string): FirstPartyPluginMeta | null {
  return FIRST_PARTY_MANIFEST[name] ?? null;
}
