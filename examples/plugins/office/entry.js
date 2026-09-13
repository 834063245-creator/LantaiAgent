// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// office 活预览窗插件入口（C 路改判后，2026-09-13）——**不再挂 MCP server**：
// OfficeCLI 的读写能力已由兰台内置 office 域工具（office(action,…)，经 shell seam →
// process_cap 受沙箱 spawn）承担；本插件只剩一件事：开一扇显示 `officecli watch`
// 实时渲染页的浮窗（manifest.app.url = 环回远端视图，契约 v28）。
//
// entry 本体零贡献（无 apply 副作用）：这个文件的存在只为满足 loader 的
// 「entry 存在且导出 { name, apply }」契约；能力实体是宿主窗口设施 ——
// 窗口只有宿主 webview 摸得到，故「开窗」这个动作必须住在本文件的 toolHandlers。
//
// 二进制不进插件目录：officecli 走标准安装位（~/.lantai/tools/officecli/officecli.exe，
// 由 examples/office-cli/install-officecli.ps1 装），office 域工具在 shell 里定位它。
// entry 也不做存在性检查——webview 无盘权，查不了；缺件时 office 域工具会给出安装指引。

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
      '或改用截图刷新路（office(screenshot) + show_asset 原地刷新）。'
    );
  },
};

export async function apply() {
  // 声明式 app / tools 的注册动作归 loader 的包装层——entry 无事可做。
}
