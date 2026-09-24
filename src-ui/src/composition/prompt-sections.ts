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

// 批 9g-1 归家（2026-09-26）：第一方段**文案真源**（L74–226 的 9 段定义 + `firstPartyPromptSections()`）
// 已整段移入产物包 `plugins/builtin/prompt-segments/sections.ts`（内容随包 = 改文案热更；
// 拼装机制与类型留内核 = 契约面）。本文件此后只做：形状 + 拼装。

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
