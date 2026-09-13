// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// office 载体插件入口——本插件的全部能力经 manifest.mcpServers 声明式挂接
// （S4-4 乙机器桥 + S2 受治进程），entry 本体零贡献：这个文件的存在只为满足
// loader 的「entry 存在且导出 { name, apply }」契约。能力实体是
// bin/officecli.exe（外部 MCP server 进程，OfficeCLI 自带 `officecli mcp`）。
//
// 为什么不写成「进程内宿主插件」：进程内宿主通道永久关闭（composition 计划
// 内核线裁定）——跨进程能力走 MCP / 前端 seam / 外部 ESM 插件三条路。
//
// 也不在这里做二进制存在性检查：webview 无盘权（插件只能经宿主桥读写自己的
// dataDir），检查不了插件目录里的 bin/。缺件时机器桥的 spawn 会失败并留可见
// 记录（lazy 空集 + warn），装法见 bin/README.md。
//
// 两张门各司其职（决策 8）：
//   · MCP 路：officecli 本体（bin/officecli.exe mcp）——实现住在进程里，随
//     tools/list 进注册表（工具名 mcp__office__officecli）；
//   · 工具口：office_preview_open——窗口设施只有宿主 webview 摸得到，故
//     「开活预览窗」这个动作必须住在本文件（对位 notes-app 的 notes_open）。

export const name = 'office';

export const toolHandlers = {
  // 打开活预览窗：窗内容 = manifest.app.url（环回远端页，officecli watch 服务）。
  // 本插件不负责起 watch（那是 shell 域的活：Agent 跑 `officecli watch <文件>`
  // 后台任务），只管开窗——职责边界与 notes-app 的 HTTP 面同款：宿主不掺和
  // 插件自家前后端的对话。
  office_preview_open: async () => {
    const host = globalThis.__lantai_plugin_host__;
    const open = host?.windows?.open;
    if (typeof open !== 'function') {
      return '[office_preview_open] 宿主桥不可用——窗口设施需在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）';
    }
    const windowId = open('office');
    if (windowId == null) {
      return '[office_preview_open] 窗口定义不在册——插件可能已被停用或卸载，请重新装载后重试';
    }
    return (
      `Office 活预览窗已打开（${windowId}）——窗内是本机 http://127.0.0.1:26315 的实时渲染页。` +
      '若显示连接失败：先让 Agent 用 shell 跑 `officecli watch <文件>`（默认端口 26315），' +
      '或改用截图刷新路（update_asset 原地刷新，见 officecli 技能 §7.5）。'
    );
  },
};

export async function apply() {
  // 声明式 mcpServers / app / tools 的注册动作归 loader 的包装层——entry 无事可做。
}
