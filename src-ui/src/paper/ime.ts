// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/ime — 输入法安全事实面（V3a spike · 前置验证；2026-08-29 R5 D4 收档更新）。
//
// paper-shell 待定 #8 / 设计文档 §6「中文输入法兼容」的前置验证件。
// 已证命题：
//   ① 纸壳输入条（固定视口底部的原生 <input>）对中文 IME 安全——
//      结构事实：它位于 pan/zoom transform 的世界层（.pp-world）之外，
//      IME 候选窗锚点跟随输入框的屏幕位（不受祖先 transform 影响的经典
//      候选窗错位问题不存在——那是 transform 内编辑面的病）。
//   ② 提交守卫：确认候选词的 Enter（isComposing=true）不得发送；
//      compositionend 之后的 Enter（isComposing=false）正常发送。
//      Chromium 的时序：候选确认 → keydown(Enter, isComposing=true) →
//      compositionend；Safari 偶发反序（end 先于 keydown）——守卫只看
//      keydown 当刻的 isComposing 标志，两种时序都安全。
//
// 残余风险收档（2026-08-29，R5 D4）：V3b 曾预警「钉住块就地编辑」的候选窗
// 错位（编辑面在世界层 transform 内时的已知雷区）。核对实际落地面后确认
// 该前提从未成立：编辑宿主从未进过世界层——块的「改」动作
// （chat-core.editUserMessage）把正文抄进底部 composer（.pp-composer-slot
// 固定视口底，世界层之外）并聚焦；画布上不存在任何可编辑元素（流块/钉块/
// 纸条均只读渲染，SpineRack 改名输入框在画布外固定层）。当年预言的
// 「编辑宿主浮出 transform 层」正是实际采用的形态，风险结构性不成立。
// 若未来真把可编辑面放进世界层（当前无此计划），须先 spike caret 屏幕位换算。
// 本文件钉住输入条这一层的可回归事实。

/**
 * 输入条提交守卫（纯谓词——壳层 onKeyDown 消费）。
 * keydown 事件的 isComposing 标志是唯一判据（含 229 keyCode 语义——
 * 合成中按键现代浏览器统一置 isComposing，不必再看 keyCode）。
 */
export function composerSubmitOnKey(key: string, isComposing: boolean): boolean {
  return key === 'Enter' && !isComposing;
}
