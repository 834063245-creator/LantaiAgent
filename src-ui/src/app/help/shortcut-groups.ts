// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 快捷键总览的数据面——**单一真源**（2026-11-28「案」抽屉退役批：从
// compose-dock/dock-copy.ts 搬到 app 层）。
//
// 为什么搬：这张表原先只在创作坞的「案」抽屉里就地展开。抽屉退役后它的新家是
// **全局搜索**（Ctrl+K 搜「快捷键」→ 弹这张表），而搜索与承载面（`app/HelpSheet.tsx`）
// 都在 app 层；app 不许 import 插件目录（层次纪律：插件依赖 app，反之不成立）。
//
// 分组语言沿用 2026-10-22 P2 的册页段题（方墨锚点 + 字距题字）；内容随这次搬迁做了
// 两处**事实更正**（不是改写风格）：
//   ① 「/ 或 翰」→ 「/」：翰钮 2026-11-09 已撤出书眉，且 2026-11-28 面板升级为全局搜索
//      （现在叫 Ctrl+K）；
//   ② 新增「全局」组：Ctrl+K / Ctrl+P / Ctrl+, / Esc 这几条是**全应用**的键，原先在坞里
//      没有一处系统列出（用户只能靠道听途说）。

export interface ShortcutGroup {
  title: string;
  rows: ReadonlyArray<readonly [key: string, desc: string]>;
}

export const SHORTCUT_GROUPS: ReadonlyArray<ShortcutGroup> = [
  {
    title: '全局',
    rows: [
      ['Ctrl+K', '全局搜索（卷 / 命令 / 设置 / 文件）'],
      ['Ctrl+P', '纸视图（开 / 回案卷首页）'],
      ['Ctrl+,', '设置'],
      ['Esc', '逐层关闭'],
    ],
  },
  {
    title: '输入',
    rows: [
      ['Enter', '发送'],
      ['Shift+Enter', '换行'],
      ['↑ / ↓', '输入历史'],
      ['/', '斜杠命令（就地）'],
    ],
  },
  {
    title: '附卷',
    rows: [
      ['引 · 夹', '附文件入卷'],
      ['拖文件到坞', '界栏松手入卷'],
    ],
  },
  {
    title: '画布',
    rows: [
      ['Alt+↑↓', '块间移动'],
      ['Alt+←→', '卷间移动'],
      ['Home', '画布回原点'],
    ],
  },
  {
    title: '纸面',
    rows: [
      ['拖文类签', '移出钉住'],
      ['拖流区边缘', '移动流区'],
      ['拖流区四角', '调整宽度'],
      ['拖选区', '抽纸条'],
    ],
  },
];
