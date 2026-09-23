// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// system-prompt section 注册表（S1-4）—— persona/规则段落的组合数据源。
//
// 段落（section）= 系统提示词的逻辑块：id 寻址 + render(ctx) 产出含自身
// 前导分隔符的完整文本。拼装 = 按表序纯 concat（applicable=false 的段
// 跳过）——**分隔符的不一致（\n 与 \n\n 混用）是现行拼装的机械事实**，
// 零漂移优先于美化：任何"顺手规整分隔符"的改动都会击穿
// system-prompt.fixture 快照与前缀缓存。
//
// 两个装配面（2026-09-09 图谱退役后——原三面解耦随图谱面移除）：
//   - 零目录面（无项目）：identity-brief → memory-brief → env-brief
//   - 有目录面：identity → env → model-identity → provider-config → memory → claude-md
// 2026-08-28 用户拍板：behavior-rules / graph-discipline / visual-discipline /
// collaboration-mode / multi-agent 五段删除——策略与工具说明不内建，改走
// A 类设置页与工具自带 schema 注入；system prompt 收缩为身份 + 动态数据。
// （原 hasGraph 判面与 graph-snapshot 段、「图谱引擎已停用」行随图谱
//  全量退役删除，2026-09-09；hasProject 判面 = projectPath 非空。）
// 同一段在两个面的位置不同——env/memory 各拆 brief/完整两个 id
// （render 共享 helper，行为逐字一致）。
//
// P4 B④ 收官（2026-08-23，拍板 #3 纯插件面）：全部 13 段经 ctx.prompts
// 第一方插件通道贡献（plugins/prompt-segments-plugin.ts，装配腰
// composition/first-party-prompts.ts——B① first-party-tools 同款）；
// 出厂段表 builtinPromptSections() 退役（段表空壳删除，拼装器本身不动
// ——只删写死的进货清单）。段定义仍留本文件（prompt 段单一真源），
// firstPartyPromptSections() 供插件装载——贡献序 = 迁移前出厂表序，
// 拼装字节零漂移按构造成立（双 preset 快照实测；迁移历程：memory/
// claude-md 试点 → graph-snapshot 续批 → 收官批一次性迁完剩余 10 段，
// 中间批次按表尾逆序头插保序）。
//
// 解析域语义（S4-4 甲，2026-08-23 勘定——B④ 收官四条重审随之修订）：
//   1. 出厂装配面 = 组合解析产物：factoryComposition() 的 prompt 域快照
//      当前通道贡献（roster.ts）——无通道环境（不经 main.ts 引导 /
//      通道腰）= 空贡献 → 缺省拼装 = 空提示词（B④ 收官的注册面依赖
//      语义不变——convergence 夹具经腰复现生产装配面）。
//   2. 全寻址恢复：13 第一方段与插件贡献段都在 roster prompt 域寻址面
//      ——patch/preset 的 disable/text 覆盖/insert 锚定寻址第一方段 id
//      均合法（B④ 收官的两条临时语义消灭：寻址拒绝退役；insert id 与
//      第一方段同名恢复撞名拒绝）。
//   3. 拼装位序统一：insert 经锚定与贡献段统一排序（缺省锚 = 快照表尾
//      ——贡献之后；B④ 收官「插入段恒在贡献之前」的临时位序消灭）。
//   4. prompt 通道无实例缓存（每次拼装重调 render，贡献直收
//      PromptSectionContext 装配期真值）——动态插值段（graphSnapshot/
//      memorySection/claudeMdSection）每装配现算，无 ①c 跨装配串扰面。
//
// 过渡形态：S1 期间 section 在 TS 常量表；S2 起随 preset 体系数据文件化。

import { activePromptContributions } from './prompt-service';

/** section 渲染上下文 — buildSystemPrompt 的全部入参。 */
export interface PromptSectionContext {
  projectPath: string;
  /** 绑定了项目目录：true = 有目录面，false = 零目录面。 */
  hasProject?: boolean;
  memorySection?: string;
  claudeMdSection?: string;
  providerName?: string;
  /** provider 配置文件绝对路径（2026-09-24 配方改文件批）——空 = 不注入配置段。 */
  providerConfigPath?: string;
  shellEnvSection?: string;
}

/** system-prompt section：id 寻址 + 条件参与 + 文本渲染。 */
export interface PromptSection {
  id: string;
  /** 缺省恒参与。返回 false 时本段跳过（不出现在输出里）。 */
  applicable?: (ctx: PromptSectionContext) => boolean;
  /** 产出含自身前导分隔符的完整文本。 */
  render: (ctx: PromptSectionContext) => string;
}

/** 目录面谓词：显式 hasProject 优先；缺省按 projectPath 非空推导。 */
const hasProject = (ctx: PromptSectionContext): boolean =>
  ctx.hasProject !== undefined ? ctx.hasProject : ctx.projectPath !== '';
const noProject = (ctx: PromptSectionContext): boolean => !hasProject(ctx);

/** 模型身份双行（两面共用；从 buildSystemPrompt 机械迁出）。 */
function modelIdentityLines(providerName?: string): { negation: string; identity: string } {
  const identity =
    providerName === 'anthropic'
      ? '你的后端 API 是 Anthropic (Claude)。任何关于模型品牌的问题，回答"Claude（由兰台调度）"。'
      : `你的后端 API 是 ${providerName || 'DeepSeek'}。任何关于模型品牌的问题，回答"${providerName || 'DeepSeek'}（由兰台调度）"。`;
  const negation =
    providerName === 'anthropic'
      ? '你可以承认自己是 Claude，但需说明你运行在兰台调度框架中。'
      : '你不是 Claude、不是 Anthropic 模型，不要声称自己是 Claude 或 Anthropic 的产品。';
  return { negation, identity };
}

/** 记忆库段（两面的格式一致；参与条件按原 if 分支保留差异：
 *  简短面判 trim() 非空，完整面判真值——机械重述，不统一）。 */
function memoryText(memorySection: string): string {
  return `\n\n## 记忆库\n${memorySection}`;
}

/** 运行环境段（两面格式一致：内容 trim 后拼入）。 */
function envText(shellEnvSection: string): string {
  return `\n\n## 运行环境\n${shellEnvSection.trim()}`;
}

/** 完整面/关引擎面身份段（2026-08-28：行为规则段删除后身份句独立成段——
 *  A 类极简人格，不再被任何策略段绑架）。 */
const IDENTITY: PromptSection = {
  id: 'identity',
  applicable: hasProject,
  render: () => `你是兰台的编码 Agent。`,
};

/** 零目录面 identity 段。 */
const IDENTITY_BRIEF: PromptSection = {
  id: 'identity-brief',
  applicable: noProject,
  render: (ctx) => {
    const { negation, identity } = modelIdentityLines(ctx.providerName);
    return `你是兰台的 AI 编码助手。当前没有加载项目。
## 模型身份
- ${negation}
- ${identity}`;
  },
};

const MEMORY_BRIEF: PromptSection = {
  id: 'memory-brief',
  applicable: (ctx) => noProject(ctx) && !!ctx.memorySection?.trim(),
  render: (ctx) => memoryText(ctx.memorySection ?? ''),
};

const ENV_BRIEF: PromptSection = {
  id: 'env-brief',
  applicable: (ctx) => noProject(ctx) && !!ctx.shellEnvSection?.trim(),
  render: (ctx) => envText(ctx.shellEnvSection ?? ''),
};

// behavior-rules 段已删除（2026-08-28）：见文件头三面注释。

// graph-discipline 段已删除（2026-08-28）：图纪律改由图引擎/工具自带注入。

// visual-discipline 段已删除（2026-08-28）：无用，直接删。

// collaboration-mode 段已删除（2026-08-28）：plan 模式由 plan-prompts 的运行时 reminder 承担。

const ENV: PromptSection = {
  id: 'env',
  applicable: (ctx) => hasProject(ctx) && !!ctx.shellEnvSection?.trim(),
  render: (ctx) => envText(ctx.shellEnvSection ?? ''),
};

const MODEL_IDENTITY: PromptSection = {
  id: 'model-identity',
  applicable: hasProject,
  render: (ctx) => {
    const { negation, identity } = modelIdentityLines(ctx.providerName);
    return `
## 模型身份
- ${negation}
- ${identity}
- 项目: \`${ctx.projectPath}\``;
  },
};

// multi-agent 段已删除（2026-08-28）：多 Agent 工具说明改由 agent 工具自带。

// graph-snapshot 段已删除（2026-09-09）：随图谱功能全量退役。

const MEMORY: PromptSection = {
  id: 'memory',
  applicable: (ctx) => hasProject(ctx) && !!ctx.memorySection,
  render: (ctx) => memoryText(ctx.memorySection ?? ''),
};

const CLAUDE_MD: PromptSection = {
  id: 'claude-md',
  applicable: (ctx) => hasProject(ctx) && !!ctx.claudeMdSection,
  render: (ctx) => `

## 项目规范
${ctx.claudeMdSection}`,
};

/** provider 配置段（2026-09-24 配方改文件批）：让 agent 知道「配 provider」这件事
 *  落在哪份文件上——否则它只能猜，或者让用户去点设置页（那正是本批要根治的麻烦）。
 *
 *  内容全是稳定字面量 + 装载期算好的绝对路径（不随会话变化）⇒ 前缀缓存零破坏。
 *  规则只讲「可改什么」与「怎么验」——不替用户推断 bug 根因（产品输出纪律）。 */
const PROVIDER_CONFIG: PromptSection = {
  id: 'provider-config',
  // 只在**完整面**参与（有项目目录）：零目录面是极简骨架，provider 配置文件
  // 属于「完整面才需要知道的家底」（与 env/model-identity 同款判面）。
  applicable: (ctx) => hasProject(ctx) && !!ctx.providerConfigPath,
  render: (ctx) => {
    const userPath = ctx.providerConfigPath ?? '';
    return `

## provider 配置
本机所有 provider 的连接配置在一份 YAML 文件里，人和 agent 都可以直接改它：
- 用户级：${userPath}
- 项目级（可选，仅本项目生效）：本工作区 .lantai/providers.yml

一行 provider = 一个顶层键，键名就是 provider 身份（字母/数字/下划线/连字符）；可改字段：
kind（协议：anthropic / openai / responses）、baseUrl、model（新会话默认）、models（可用模型）、
thinking（默认思考档位）、headers（网关怪癖）、modelOverrides / modelMeta、authMode / oauthProvider。
同名的项目级节整节覆盖用户级。

改完约 1 秒自动生效（无需重启、无需用户点保存）。密钥**不要**写进这个文件——
apiKey 权威在本机系统凭据库（用户可在 设置 → 提供方 的 Key 栏填写）；lastTest / catalog
是本机读数，也不属于这份文件。写错一节只影响那一行（其余 provider 照常），原因会显示在
设置 → 提供方页。`;
  },
};

/** 第一方 prompt 段清单（序 = 拼装序）——经 ctx.prompts
 *  第一方插件通道贡献（plugins/prompt-segments-plugin.ts 装载本清单，
 *  装配腰 composition/first-party-prompts.ts）。
 *  B④ 收官（2026-08-23）：出厂段表 builtinPromptSections() 退役，本清单
 *  即出厂装配面的全部段落来源（简短/完整两面经 applicable 互斥分流，
 *  序不变）。**段数以本函数返回值为唯一真源**（禁手抄计数）：
 *  原 13 段 → `56fb9285` 极简骨架收缩去五段补 IDENTITY → 9 段 →
 *  `51047f99` 图谱退役去 graph-snapshot → 8 段 → 2026-09-24 配方改文件批
 *  补 provider-config → 9 段。
 *  S4-4 甲：清单段经通道进 roster 解析域（factoryComposition prompt 域
 *  快照）——patch/preset 可寻址段 id（disable/text/锚定）。 */
export function firstPartyPromptSections(): PromptSection[] {
  return [IDENTITY_BRIEF, MEMORY_BRIEF, ENV_BRIEF, IDENTITY, ENV, MODEL_IDENTITY, PROVIDER_CONFIG, MEMORY, CLAUDE_MD];
}

/** 按序拼装系统提示词（applicable=false 的段跳过，其余纯 concat）。
 *  S2-1 起 sections 可选注入（roster 解析产物——composition-store 穿线）。
 *  S4-4 甲：sections = 解析域全量清单（通道贡献段快照已收编进解析产物
 *  ——factoryComposition 的 prompt 域）——**提供即精确清单**，不再末端
 *  追加通道贡献；缺省 = 出厂基座（当前通道贡献——无通道环境 = 空表 =
 *  空提示词，B④ 收官的注册面依赖）。A-1 时代「贡献恒追加在解析产物
 *  末尾」的合流语义退役（两条临时位序随之消灭——见文件头）。生效时机
 *  = 下次 Agent 装配（在途会话段面不变，前缀缓存纪律）。 */
export function assembleSystemPrompt(ctx: PromptSectionContext, sections?: PromptSection[]): string {
  const list = sections ?? activePromptContributions();
  let out = '';
  for (const section of list) {
    if (section.applicable && !section.applicable(ctx)) continue;
    out += section.render(ctx);
  }
  return out;
}
