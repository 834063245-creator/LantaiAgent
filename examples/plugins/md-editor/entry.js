// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// md-editor — 软件级插件「第 1 步回归基线」入口。
//
// 入口形状是硬契约（loader 阶段 2，moduleStage）：`pickPluginObject` 优先取
// `default` 导出，`isPluginShape` 要求 `{ name, apply }`，且 **name 必须与
// manifest.name 逐字一致**——否则装载失败记录「插件对象 name (undefined) 与
// manifest.name 不一致」。所以这里必须是 default 导出对象，不能只裸导一个 apply。
//
// 第 1 步只证「窗 + 桥 + 生命周期」这一条线：
//   · 窗（件 A）：manifest.app 声明窗入口，装载只登记定义，开窗才实例化 iframe；
//   · 数据地盘（件 B）：manifest.dataDir 分配 <dataRoot>/md-editor/，窗经桥 fs 读写；
//   · 生命周期：关窗即回收，卸载数据目录整体回收（宿主侧机制，插件零清理代码）。
//
// 刻意不做的事（留给后续步骤，别在这里长出来）：
//   · 不开工具口、不起受治进程——那是 MCP 路，跟这一步要证的缝无关；
//   · 不碰宿主文档（卷里/工作区里的 .md）——需要受治文档通道（第 2 步）。

export default {
  name: 'md-editor',
  apply() {
    // 装载期零副作用：窗口定义 / 数据地盘全由装载器包装层按 manifest 挂接。
  },
};
