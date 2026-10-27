// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal 模式 system-prompt 段（2026-10-23，DSH `tool-goal` 的 guidance 段移植）。
//
// 与 DSH 同一条纪律：目标工具的策略写在系统提示里、**不**塞进工具 schema 的长描述，
// prompt 段本身是字节契约（段序/内容变更必须走 convergence 基线）。

/** 目标工具策略段（不含前导分隔符——拼装由调用方负责）。 */
export const GOAL_GUIDANCE =
  '用 goal 工具管理本会话唯一的长期完成目标：' +
  'goal(create) 可以从任何语言的直人请求推断目标意图（用户没说"目标"也可以），但不要为单轮工作创建目标；' +
  'update 之前先 goal(get)，并原样复制 goal_id 与 revision。' +
  '会话恢复或 fork 之后，active 目标的自动续行会被停用：人类以任何措辞要求"继续/恢复"时，' +
  '用 goal(update, update_action="resume") 重新授权。' +
  '只有目标真正达成才 complete；只有同一个阻塞条件连续存在至少 3 个目标轮才 blocked，' +
  '并在 blocked_reason 写明该具体条件——困难、不确定、仍有活可干都不是 blocked。';
