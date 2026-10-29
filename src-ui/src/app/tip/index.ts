// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 悬停提示（tooltip）—— 全库单点能力。
//
// 用法（**不是**包装组件，是属性）：
//   普通：  <button data-tip="发送本轮输入">
//   两行：  <button data-tip="插入回合" data-tip-hint="Agent 运行中，下轮生效">
//
// 文案纪律：主行 = 动作（4~8 字，读得懂在干什么）；次行 = 条件/后果。
// 别把一整句塞进主行——`停这一条后台命令（级联子代理）` 那类句式读起来像系统报错。
//
// 无障碍：提示**不得是唯一信息源**——纯图标按钮仍须自备 `aria-label`。

export { TipHost } from './tip-host';
