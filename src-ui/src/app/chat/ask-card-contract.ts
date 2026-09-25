// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/chat/ask-card-contract — ask / 权限卡**契约面**（批 9e-3，2026-09-26）。
//
// 病灶：ask 卡架的**实现**（`PromptShelf.tsx` 776 + css 412）是产品形态，此前住在应用外壳里，
// 而**消费方**是内核 `chat-core`（`showAsk` / `showPermission` / `dismiss` / `dismissByOwner` /
// `answerActiveText` 五个动词 + 读 `active` 展示态）⇒ 实现随包后，这一组形状必须留内核当契约。
//
// 所有权：本文件是**形状真源**（类型 + 动词签名），零运行时值；实现住
// `plugins/builtin/ask-cards/`（产物），入口经 `ctx.rootViews` 的 `'overlay'` 槽挂载，
// 装载后把句柄注册回 `chat-core.registerPromptShelf()`。
//
// 为什么句柄不住产物域：内核 `chat-core` 是按卷生命周期调用它的那一侧（挂起 Promise 的
// resolve 归属权限队列），产物只是渲染面——契约住内核 = 内核不 import 产物源码（仓库铁律）。

/** 批量多问的单条题目 */
export interface AskQuestionItem {
  question: string;
  header?: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
}

export interface AskPrompt {
  type: 'ask';
  id: string;
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** 批量多问：一次推全部 questions，UI 分页收集后一次性提交全部答案 */
export interface AskBatchPrompt {
  type: 'ask-batch';
  id: string;
  /** 批次标签（卡片 tag 显示；缺省"提问"） */
  header?: string;
  questions: AskQuestionItem[];
}

export interface PermissionPrompt {
  type: 'permission';
  id: string;
  toolName: string;
  reason: string;
  subject: string;
  /** 高危操作标签，如 "ForceRecursiveRoot"。有值时显示红色警告卡片 */
  danger?: string;
}

/** 卡片归属面（2026-09-10 ask 用户侧完备化）：
 *  - ownerSid：归属卷号（null = 面板级/无归属）——停止语义按卷杀卡
 *    （dismissByOwner），切卷/停他卷不再一刀切清全架；
 *  - badge：归属卷名徽标（多卷并发时「替哪卷作答」），独立 chip 渲染
 *    （此前与 header 拼串后按 12 字截断——徽标把真 header 吃掉）。 */
export interface PromptOwner {
  ownerSid?: number | null;
  badge?: string | null;
}

export type PromptData = (AskPrompt | AskBatchPrompt | PermissionPrompt) & PromptOwner;

/** 卡架命令式句柄（core 注册接口——实现随包、形状留内核）。 */
export interface PromptShelfHandle {
  readonly active: PromptData | null;
  /** 显示询问提示。返回 Promise，解析为选中的标签或 null（取消时）。 */
  showAsk(prompt: AskPrompt & PromptOwner): Promise<string[] | null>;
  /** 显示批量多问（分页收集）。返回 Promise，解析为对齐 questions 的答案数组或 null（取消时）。 */
  showAskBatch(prompt: AskBatchPrompt & PromptOwner): Promise<(string[] | null)[] | null>;
  /** 显示权限提示。返回 Promise，解析为 allow/remember。 */
  showPermission(prompt: PermissionPrompt & PromptOwner): Promise<{ allow: boolean; remember: boolean }>;
  /** 关闭当前提示（取消挂起的 Promise）。 */
  dismiss(): void;
  /** 按归属卷关闭（2026-09-10 完备化）：停 A 卷只杀 A 卷的卡——
   *  切卷/停他卷不再一刀切清全架（别的卷在等答案的提问卡曾被误杀，
   *  Agent 收「用户取消」而用户没答过）。ownerSid 匹配 ownerSid ?? null。 */
  dismissByOwner(ownerSid: number | null): void;
  /** 主输入作答（2026-09-10 完备化）：架头是提问卡时以 text 作答——
   *  单问卡整卡提交（自定义回答）；批量卡填当前页并翻页。
   *  返回 false = 架头不是提问卡（权限卡/空架），调用方走常规发送路径。 */
  answerActiveText(text: string): boolean;
}
