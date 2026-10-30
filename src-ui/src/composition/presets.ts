// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// preset 数据模型（S4-0）—— 命名的 ResolvedComposition 工厂（设计件
// docs/plans/composition-architecture/designs/S4-preset-realm-distribution.md §2.1）。
//
// Preset = 命名的行组合：同一份 S2 patch schema（roster.patch.yml）+ 显示
// 元数据（preset.yml，纯展示）。与用户层 patch 的差别只在层序：
//   factory → 用户层 patch（~/.lantai/composition/roster.patch.yml）
//          → preset patch（composition/presets/<id>/roster.patch.yml）
// preset 是最上层——用户层表达「这台机器的基线」，preset 表达「这个会话的
// 裁剪」，裁剪叠加在基线之上（同 id 后写胜前写，S2 语义零改动）。
//
// 信任模型二分（DSH 同构）：
//   - system preset：代码常量（本文件内置表），不落盘——「factory 层不出
//     yml」同一裁定；内置 id 是部署事实，用户不可影子化（同 id 内置胜）；
//   - user preset：~/.lantai/composition/presets/<id>/ 目录，经 discovery
//     （preset-discovery.ts）发现后进 preset-store。
//
// shell 域说明：preset 对会话有意义的是 tools/prompt/capabilities 三域
// （§2.1 生效面）。壳行禁用是应用级决策（壳引导一次性的）——user preset
// 文件里写 shell 域条目照样会被 resolveRoster 解析（S2 引擎零新语义，
// 域合法性由 schema 层保证）。V5 拆除（2026-08-22）：paper preset 行
// 退役——纸壳是唯一主界面，主视图落点不再经 preset 分叉（启动落点
// 恒为案卷首页，2026-08-22 用户拍板）。
//
// 解析纯函数（本文件）不 fetch 不读盘——远端发现是 preset-discovery 的
// 职责（与 roster.ts 不 parse yaml 同一分工纪律）。

import { type CompositionPatch, factoryComposition, type ResolvedComposition, resolveRoster } from './roster';

/** preset id 规则（DSH PRESET_ID 同款）：`/^[a-z0-9][a-z0-9-]*$/`。
 *  id 是 URL 路径段（/composition/presets/<id>/…），这是围栏规则不是
 *  风格规则——`..` / 分隔符 / 绝对名会把组合挪出授权根。 */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 校验 preset id 形状（discovery 侧对索引条目逐个把关）。 */
export function isValidPresetId(id: string): boolean {
  return PRESET_ID_RE.test(id);
}

/** preset 显示元数据（preset.yml）——纯展示，装载失败降级为无元数据
 *  不拒载（§2.1 目录形态）。 */
export interface PresetMetadata {
  name: string;
  description?: string;
  order?: number;
}

/** 发现层的一个 preset 条目（内置行或用户目录行，统一形状）。
 *  roster 为 broken 时该 preset 占 id 但拒绝装载（DSH discovery 同款：
 *  发现成功 ≠ 组合可用，坏 preset 不炸发现）。 */
export interface PresetEntry {
  id: string;
  /** 内置（system）标记——与 user 同 id 时内置胜（earlier root wins）。 */
  builtin: boolean;
  metadata?: PresetMetadata;
  /** 已成功 parse 的 patch（zod 校验后）；broken = null。 */
  patch: CompositionPatch | null;
  /** roster.patch.yml 装载失败原因（patch = null 时可见）。 */
  error?: string;
}

/** 创作者模式的写作指南（creator preset 的 prompt insert 正文）。
 *  为什么放 preset 层而不是技能目录：它只该在 creator 组合里出现——用 patch 的
 *  insert 能力表达「本模式专属的一段说明」，零新增机制；行 id 不在这里抄清单
 *  （composition(list, rows:true) 现读，避免与行表漂移）。 */
export const CREATOR_GUIDE = [
  '## 创作者模式（composition authoring）',
  '',
  '本模式额外给了你 composition 工具（list / read / validate / write），用来读写「组合」（preset）——它决定一个会话里模型能看到哪些工具、哪些提示段、哪些能力与壳行。除本模式外，其它组合里模型没有这个工具：改组合是用户显式选择的模式，不是随手可做的事。',
  '',
  '组合是**叠加层**，层序 = 出厂组合 → 用户层 patch → preset（后写胜前写）。可写域：',
  '  tools:        [ { id: <行 id>, disabled: true|false } ]   # disabled:false 可回开「默认关」的行（清单里标 ★）',
  '  prompt:       [ { id: <段 id>, disabled: true } | { id: <段 id>, text: <整段替换> }',
  '                  | { insert: [ { id: <新段 id>, text: <内容>, before|after: <锚点 id> } ] } ]',
  '  capabilities: [ { id: <能力 id>, disabled: true } ]',
  '  shell:        [ { id: <壳行 id>, disabled: true } ]       # 重启生效',
  '  seam/<域>:    [ { id: <provider 或事件 id>, disabled: true } ]   # 域 = llm|subagents|fs|shell|sessionPersistence|loopEvents',
  '  requires:     [ <插件名> ]      # 本组合依赖的插件；缺任一则该组合不可选',
  '  exclusive:    [ <资源实例名> ]  # 本组合独占的资源（如 port:9310）',
  '',
  '行 id 只能从 composition(list, rows:true) 的输出里抄——写错会被拒绝（报「未知行 id」并指出域）。本工具**不能新增插件或工具**，只能裁剪/回开已登记的行；也不能改插件参数。',
  '',
  '工作流（固定顺序，别跳步）：',
  '1. composition(list, rows:true) 看现有组合与可寻址行；filter 可只列某族。',
  '2. 写 patch YAML，composition(validate, yaml) 校验；错误会指出具体行/字段，改完再验。',
  '3. composition(write, id, yaml, name, description) 落盘（写入 ~/.lantai/composition/presets/<id>/，写后自动重扫）。已存在同名预设默认拒写：确需覆盖才带 overwrite:true。内置 id（standard/minimal/creator）不可占用。',
  '4. 告诉用户：在**空白卷**上选择该组合（卷首「组合」芯片或 设置 › Agent › 组合）后生效；跑过一轮的卷不会中途换面（组合决定模型看到的工具与提示面，是字节契约）。',
  '5. 管理自己造的组合：composition(delete, id) 删除 / composition(rename, id, newId) 改名 / composition(copy, id, newId) 复制（可从内置复制一份再改）。内置拒删拒改名；当前全局默认拒删拒改名（先在设置里切走）。',
  '',
  '反例（会被拒绝）：新增一个工具、改某个工具的参数、写不存在的行 id、把 standard 改坏。做得对的最小例子：禁掉 shell 域 + 禁掉 fs 的写/编辑工具，得到一个「只读研究」组合。',
].join('\n');

/** 内置 system preset 表（§2.1）——代码常量，不落盘。
 *  表序 = 设置面板呈现序（stable；user preset 按 id 排序附后）。 */
const BUILTIN_PRESETS: Array<{
  id: string;
  metadata: PresetMetadata;
  patch: CompositionPatch;
}> = [
  {
    id: 'standard',
    metadata: { name: 'standard', description: '出厂组合（零 patch）' },
    patch: {},
  },
  {
    id: 'minimal',
    metadata: {
      name: 'minimal',
      description: '精简面：禁 browser/desktop、web、状态 hooks 等重装备',
    },
    // ①b（2026-08-23）：web/browser-desktop 迁插件通道——寻址行改枚举
    // plugin 行 id（原 builtin/<族> 行 id 随行表退役）。整族禁用：web 双
    // 工具行 = web_search + web_fetch 两个单贡献行；browser-desktop 整组
    // 贡献行 = 一行禁整族（族内新增工具自动覆盖，名面不被清单锁死）。寻址 plugin 行的解析须在
    // 贡献在册的环境（生产 = loadBuiltinPlugins 启动期装载先于 bootShell
    // 组合链；测试 = withFirstPartyToolChannel 通道腰）。
    // B⑤（2026-08-24）：hooks capability 迁 ctx.capabilities 通道（第一方
    // capability 插件注册）——寻址该 key 的解析同样须在 capability 通道
    // 在册环境（测试 = withFirstPartyCapabilityChannel 通道腰）。
    // 2026-09-09 图谱退役：graph-hooks 收缩为 state-hooks（状态 + 构建结果
    // hooks），minimal 的禁用行随键改名。
    patch: {
      tools: [
        { id: 'plugin/hologram/browser-desktop-domain/tools', disabled: true },
        { id: 'plugin/hologram/web-domain/web_search', disabled: true },
        { id: 'plugin/hologram/web-domain/web_fetch', disabled: true },
      ],
      capabilities: [{ id: 'state-hooks', disabled: true }],
    },
  },
  {
    id: 'creator',
    metadata: {
      name: 'creator',
      description: '创作者模式：Agent 可用 composition 工具读写组合（默认关的工具行只在本模式回开）',
    },
    // 2026-10 最小闭环（对照 DSH creator mode）：把「造组合」的能力做成一个
    // **可选组合**，而不是常驻工具——最小权限：standard/minimal 里模型既看不到
    // 也调不到 composition 工具（该行 defaultOff），只有本组合用 disabled:false
    // 回开。
    //
    // 为什么还要插一段 prompt：工具只说明「怎么调」，这段说明「怎么写、写不了
    // 什么、写完怎么让用户用上」。行 id 清单不抄在这里（composition(list,
    // rows:true) 现读，避免与行表漂移）。
    patch: {
      tools: [{ id: 'plugin/hologram/composition-domain/composition', disabled: false }],
      prompt: [{ insert: [{ id: 'composition-authoring', text: CREATOR_GUIDE }] }],
    },
  },
  {
    id: 'readonly',
    metadata: {
      name: 'readonly',
      description: '只读研究：关掉 shell / 文件写入 / git 写 / office 写 / 代码执行，只留读、搜、网与 git 历史',
    },
    // 来源（2026-10-30）：creator 模式实测里 Agent 自己造出来的组合，用户跑通后收为出厂——
    // 不进 creator 也能直接用。行 id 全部取自 composition(list, rows:true) 的现读清单。
    patch: {
      tools: [
        // shell 全域：执行即任意副作用
        { id: 'plugin/hologram/shell-domain/run_shell', disabled: true },
        { id: 'plugin/hologram/shell-domain/bash_output', disabled: true },
        { id: 'plugin/hologram/shell-domain/bash_kill', disabled: true },
        { id: 'plugin/hologram/shell-domain/bash_wait', disabled: true },
        // 文件写入面：保留 read_file_content / list_directory / glob
        { id: 'plugin/hologram/fs-domain/write_file', disabled: true },
        { id: 'plugin/hologram/fs-domain/edit_file', disabled: true },
        { id: 'plugin/hologram/fs-domain/delete_file', disabled: true },
        { id: 'plugin/hologram/fs-domain/create_directory', disabled: true },
        { id: 'plugin/hologram/fs-domain/move_file', disabled: true },
        { id: 'plugin/hologram/fs-domain/rename_file', disabled: true },
        // git 写入面：保留 git_status / git_diff / git_log
        { id: 'plugin/hologram/git-domain/git_stage', disabled: true },
        { id: 'plugin/hologram/git-domain/git_commit', disabled: true },
        { id: 'plugin/hologram/git-domain/git_push', disabled: true },
        { id: 'plugin/hologram/git-domain/git_pull', disabled: true },
        { id: 'plugin/hologram/git-domain/git_init', disabled: true },
        { id: 'plugin/hologram/git-domain/git_checkout', disabled: true },
        { id: 'plugin/hologram/git-domain/git_create_branch', disabled: true },
        { id: 'plugin/hologram/git-domain/git_discard', disabled: true },
        { id: 'plugin/hologram/git-domain/git_stash_push', disabled: true },
        { id: 'plugin/hologram/git-domain/git_stash_pop', disabled: true },
        // 其它能改盘 / 能动态执行的口子
        { id: 'plugin/hologram/office-domain/office', disabled: true },
        { id: 'plugin/hologram/cordis-domain/cordis_define', disabled: true },
        { id: 'plugin/hologram/cordis-domain/cordis_run', disabled: true },
        { id: 'plugin/hologram/cordis-domain/cordis_stop', disabled: true },
        { id: 'plugin/hologram/cordis-domain/cordis_undefine', disabled: true },
        { id: 'plugin/hologram/agent-isolation-domain/agent_isolation_merge', disabled: true },
      ],
      // 程序执行原语（程序体内可嵌套调工具）——不是读也不是搜索
      capabilities: [{ id: 'code-execution-tool', disabled: true }],
      prompt: [
        {
          insert: [
            {
              id: 'readonly-research/scope',
              // 刻意不写锚点（2026-10-30）：锚点只存在于 prompt 通道（test 环境 / 用户
              // 禁用 prompt-segments 时会缺）——缺锚点会让整个 preset 不可解析。追加表尾
              // 稳且够用（creator 的指南段同理）。
              text: [
                '本卷是**只读研究模式**：可以读文件、搜内容、查依赖、读 git 历史、上网查资料，但不得改变工作区——',
                '没有 shell，没有文件写入/移动/删除，没有 git 写操作，没有代码执行。',
                '需要改动时，在回答里写清「改哪个文件、改成什么、为什么」，由用户在普通卷执行。',
                '结论必须可回溯到你实际读到的文件与行号。',
              ].join('\n'),
            },
          ],
        },
      ],
    },
  },
];

/** 内置 preset 清单（只读快照；每行返回同一 patch 对象——resolveRoster
 *  纯函数不 mutate patch，浅共享安全）。 */
export function builtinPresets(): PresetEntry[] {
  return BUILTIN_PRESETS.map((p) => ({
    id: p.id,
    builtin: true,
    metadata: p.metadata,
    patch: p.patch,
  }));
}

/** 按 id 取内置 preset；无则 undefined。 */
export function builtinPresetById(id: string): PresetEntry | undefined {
  const found = BUILTIN_PRESETS.find((p) => p.id === id);
  if (!found) return undefined;
  return { id: found.id, builtin: true, metadata: found.metadata, patch: found.patch };
}

/**
 * preset 组合解析主入口（纯函数，§2.1 层序）。
 *
 * resolvePresetComposition(presetId, userPatch) ≡
 *   resolveRoster(factory, [userPatch ?? {}, presetPatch])
 * 其中 presetPatch 按序查：内置表 → userPreset（discovery 产物）。
 * 未知 id / broken preset / 空 userPreset 表 → 出厂组合（factory，
 * 非错误——preset 选择落在缺省 standard 上是常态路径）。
 *
 * 注意与 loadCompositionPatch 的错误语义分工：用户层 patch 坏 → store
 * error + factory 兜底（S2 all-or-nothing 可见面）；preset 坏 → 静默
 * factory（discovery 已把 error 记进 PresetEntry.error 可见，装配侧
 * 不重复弹错——「占 id 但拒绝装载」）。
 */
export function resolvePresetComposition(
  presetId: string,
  opts: { userPatch?: CompositionPatch | null; userPresets?: PresetEntry[] } = {},
): ResolvedComposition {
  const preset = builtinPresetById(presetId) ?? opts.userPresets?.find((p) => p.id === presetId && !p.builtin);
  const presetPatch = preset?.patch;
  if (!presetPatch) {
    // 未知 id / broken preset → 忽略 preset 层，只叠用户层（可能为空 = 恒等）
    return resolveRoster(factoryComposition(), [opts.userPatch ?? {}]);
  }
  return resolveRoster(factoryComposition(), [opts.userPatch ?? {}, presetPatch]);
}
