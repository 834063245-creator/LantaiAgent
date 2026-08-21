// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/ime — 输入条 IME 安全谓词（V3a spike · 前置验证）。
//
// paper-shell 待定 #8 / 设计文档 §6「中文输入法兼容」的前置验证件。
// 假设（要证的命题）：
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
// 残余风险（记录在案，非本 spike 范围）：V3b 动手权（钉住块就地编辑）的
// 编辑面在世界层 transform 内——候选窗错位与缩放下的 caret 定位是已知
// 雷区，届时须 spike「编辑宿主浮出 transform 层」或 caret 屏幕位换算。
// 本文件只钉输入条这一层的可回归事实。

/**
 * 输入条提交守卫（纯谓词——壳层 onKeyDown 消费）。
 * keydown 事件的 isComposing 标志是唯一判据（含 229 keyCode 语义——
 * 合成中按键现代浏览器统一置 isComposing，不必再看 keyCode）。
 */
export function composerSubmitOnKey(key: string, isComposing: boolean): boolean {
  return key === 'Enter' && !isComposing;
}
