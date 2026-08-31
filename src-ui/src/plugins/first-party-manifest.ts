// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方插件元数据清单（平台化收尾，2026-08-29；P1 扩充 2026-08-30）
// ——45 个第一方插件的身份单一真源。
//
// 背景：平台化 P4-P6 之后，第一方插件经 plugins/loader.ts 的 BUILTIN_PLUGINS
// 表统一装载、经 ctx.* 贡献通道统一装配，但一直缺「清单身份」——没有
// version/description/分类，也进不了插件列表（plugin-store 只记录外部插件）。
// 本文件补齐这一层：name → { version, description, kind }，与 DSH 的
// profile bundles 清单同构（DSH 第一方插件在设置页可见、可管理，这里对齐）。
//
// 铁律：
//   - 本表必须覆盖 BUILTIN_PLUGINS 全部条目（多/缺条目 = 装配断层，
//     守护测试 tests/first-party-manifest.test.ts 钉死；loader 运行时
//     缺条目 = 跳过装载 + error 记录，错误不静默）。
//   - kind 分两类：
//       service  = 平台服务本体（组合层 service / seam provider / 运行体）——
//                  常驻，UI 不提供禁用开关（禁了应用就散架）；
//       feature  = 功能插件（域工具族 / 面板 / 段贡献）——用户可禁用
//                  （下次启动生效，见 plugin-prefs + loader 跳过语义）。
//
// 使用方：plugins/loader.ts（装载时折算记录）、state/plugin-store.ts
// （PluginRecord.meta 类型）、app/panels/settings/PluginsPage.tsx（分组渲染）。

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

/** 第一方插件清单（key = 插件名；Record 注解允许字符串索引——loader/
 *  守护测试以运行时 name 寻址）。 */
export const FIRST_PARTY_MANIFEST: Record<string, FirstPartyPluginMeta> = {
  // ── 平台服务（service，21）──
  'hologram/composition-services': meta(
    'hologram/composition-services',
    'service',
    '组合层四 service 本体（panels/commands/tools/llm 注册表）',
  ),
  'hologram/subagents-service': meta('hologram/subagents-service', 'service', '子代理服务注册表（seam/subagents）'),
  'hologram/subagent-in-process': meta('hologram/subagent-in-process', 'service', '进程内子代理默认实现'),
  'hologram/fs-service': meta('hologram/fs-service', 'service', '文件域服务注册表（seam/fs）'),
  'hologram/fs-builtin': meta('hologram/fs-builtin', 'service', 'Rust 文件后端（11 动作）'),
  'hologram/shell-service': meta('hologram/shell-service', 'service', '命令域服务注册表（seam/shell）'),
  'hologram/shell-builtin': meta('hologram/shell-builtin', 'service', 'Rust 命令后端（shell 域四动作）'),
  'hologram/session-persistence-service': meta(
    'hologram/session-persistence-service',
    'service',
    '会话持久化服务注册表（seam/sessionPersistence）',
  ),
  'hologram/sessions-builtin': meta('hologram/sessions-builtin', 'service', '会话存储后端（agent-store）'),
  'hologram/graph-service': meta('hologram/graph-service', 'service', '图谱域服务注册表（seam/graph）'),
  'hologram/graph-builtin': meta('hologram/graph-builtin', 'service', 'Rust 图谱后端（hologram 域）'),
  'hologram/composition-space': meta('hologram/composition-space', 'service', '空间服务（工作区/会话空间）'),
  'hologram/composition-overlays': meta('hologram/composition-overlays', 'service', '覆盖层服务'),
  'hologram/renderer-service': meta('hologram/renderer-service', 'service', '块渲染器注册表（第五贡献通道，后注册胜）'),
  'hologram/prompts-service': meta('hologram/prompts-service', 'service', 'system-prompt 段贡献注册表（第六通道）'),
  'hologram/hook-services': meta('hologram/hook-services', 'service', '工具管道钩子注册表（第七通道）'),
  'hologram/capability-services': meta('hologram/capability-services', 'service', '会话级能力贡献注册表（第八通道）'),
  'hologram/llm-adapters': meta('hologram/llm-adapters', 'service', 'LLM 协议方言适配（seam/llm 默认实现）'),
  'hologram/code-runtime': meta('hologram/code-runtime', 'service', 'code_execution 执行腰沙箱'),
  'hologram/dynamic-runner': meta(
    'hologram/dynamic-runner',
    'service',
    '运行时插件定义/执行（cordis 域，approval + 半沙箱）',
  ),
  'hologram/agent-loop-service': meta(
    'hologram/agent-loop-service',
    'service',
    'Agent 主循环（seam/agentLoop 默认实现）',
  ),

  // ── 功能插件（feature，22）──
  'hologram/settings-domain': meta('hologram/settings-domain', 'feature', '设置面板 + 命令双通道'),
  'hologram/paper-shell': meta('hologram/paper-shell', 'feature', '纸壳面板（写作视图 + toggle 命令）'),
  'hologram/space-demo': meta('hologram/space-demo', 'feature', '演示用空间面板'),
  'hologram/canvas-nav': meta('hologram/canvas-nav', 'feature', '画布导航命令'),
  'hologram/compose-dock': meta('hologram/compose-dock', 'feature', '组合停靠面板'),
  'hologram/web-domain': meta('hologram/web-domain', 'feature', 'web 域工具（web_fetch）'),
  'hologram/browser-desktop-domain': meta(
    'hologram/browser-desktop-domain',
    'feature',
    '浏览器/桌面自动化域工具（browser_*/desktop_*）',
  ),
  'hologram/engine-domain': meta('hologram/engine-domain', 'feature', '图谱引擎域工具（graph/ops/lsp 域动作）'),
  'hologram/git-domain': meta('hologram/git-domain', 'feature', 'git 域工具（status/diff/log/stage/commit…）'),
  'hologram/search-domain': meta('hologram/search-domain', 'feature', '搜索域工具（search_content）'),
  'hologram/fs-domain': meta('hologram/fs-domain', 'feature', '文件域工具（读改写/目录/约束）'),
  'hologram/shell-domain': meta('hologram/shell-domain', 'feature', '命令域工具（run_shell/bash_*）'),
  'hologram/agent-isolation-domain': meta(
    'hologram/agent-isolation-domain',
    'feature',
    '隔离工作树域工具（create/diff/merge/discard/status）',
  ),
  'hologram/wait-domain': meta('hologram/wait-domain', 'feature', 'wait 工具（人工等待/确认）'),
  'hologram/ask-domain': meta('hologram/ask-domain', 'feature', 'ask_user 工具（向用户提问）'),
  'hologram/memory-domain': meta('hologram/memory-domain', 'feature', '记忆域工具（memory_*）'),
  'hologram/skill-domain': meta('hologram/skill-domain', 'feature', '技能域工具（Skill）'),
  'hologram/task-domain': meta('hologram/task-domain', 'feature', '任务域工具（task_*）'),
  'hologram/agent-domain': meta('hologram/agent-domain', 'feature', '子代理域工具（spawn/kill/status/通信）'),
  'hologram/cordis-domain': meta('hologram/cordis-domain', 'feature', '运行时插件域工具（define/run/stop/inspect）'),
  'hologram/asset-domain': meta(
    'hologram/asset-domain',
    'feature',
    '资产块域工具（show_asset/update_asset/list_block_kinds——Agent 生成可引用/更新的资产块）',
  ),
  'hologram/prompt-segments': meta(
    'hologram/prompt-segments',
    'feature',
    '出厂 system-prompt 段（13 段；禁用 = Agent 无出厂提示词）',
  ),
  'hologram/capability-segments': meta(
    'hologram/capability-segments',
    'feature',
    '出厂会话级能力（15 项；禁用 = 出厂能力消失）',
  ),
  'hologram/renderers': meta(
    'hologram/renderers',
    'feature',
    '资产表现原语渲染器（grid/chart/metric/media/graph/tree/html/form；P1 插件通道化——禁用 = 资产块走 JSON 兜底）',
  ),
};

/** 按插件名取第一方元数据（无 = null——外部插件/清单缺失）。 */
export function firstPartyMetaFor(name: string): FirstPartyPluginMeta | null {
  return FIRST_PARTY_MANIFEST[name] ?? null;
}
