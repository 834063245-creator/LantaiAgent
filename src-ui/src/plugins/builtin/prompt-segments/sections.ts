// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// prompt-segments/sections — **第一方 prompt 段文案真源**（批 9g-1 归家，2026-09-26；
// 原 `composition/prompt-sections.ts` 的 L74–226 整段移入产物包）。
//
// 为什么内容随包：段的**文案**是产品内容（改文案 = 换产物热更），而**拼装机制**
// （`assembleSystemPrompt` + PromptSection 形状 + ctx.prompts 通道）是内核面 —— 两者此前同居
// 一个文件（账本 §2.6「进货清单挪到柜台，货仍在店里」的那笔）。
//
// 契约面留内核 `composition/prompt-sections.ts`（类型 + 拼装函数），本文件 import 类型。
//
// ⚠ **序 = 拼装序 = 字节契约**：`firstPartyPromptSections()` 的数组序即出厂提示词拼装序，
// 前缀缓存与 effective 快照依赖它 —— 迁移时逐位照搬，不得重排。
//
// 段数（禁手抄，以本函数返回值为唯一真源）：原 13 段 → `56fb9285` 极简骨架收缩去五段补
// IDENTITY → 9 段 → `51047f99` 图谱退役去 graph-snapshot → 8 段 → 2026-09-24 配方改文件批
// 补 provider-config → 9 段。

import type { PromptSection, PromptSectionContext } from '../../../composition/prompt-sections';

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
 *  第一方插件通道贡献（本包 `index.ts` 的 apply 装载本清单，
 *  装配腰 composition/first-party-prompts.ts）。
 *  B④ 收官（2026-08-23）：出厂段表 builtinPromptSections() 退役，本清单
 *  即出厂装配面的全部段落来源（简短/完整两面经 applicable 互斥分流，
 *  序不变）。**段数以本函数返回值为唯一真源**（禁手抄计数）。
 *  S4-4 甲：清单段经通道进 roster 解析域（factoryComposition prompt 域
 *  快照）——patch/preset 可寻址段 id（disable/text/锚定）。 */
export function firstPartyPromptSections(): PromptSection[] {
  return [IDENTITY_BRIEF, MEMORY_BRIEF, ENV_BRIEF, IDENTITY, ENV, MODEL_IDENTITY, PROVIDER_CONFIG, MEMORY, CLAUDE_MD];
}
