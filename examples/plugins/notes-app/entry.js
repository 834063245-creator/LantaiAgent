// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// notes-app — 软件级插件范本（app shell 四件套 · S5，对位基本插件范本
// examples/plugins/hello/）。一个 entry 文件 + 一个零依赖 Node server + 一张
// 自包含窗页，覆盖四件套闭环：
//
//   - 窗口（件 A）：manifest.app 声明窗入口（./app/index.html）——装载只登记
//     定义，开窗才实例化 iframe 视口；窗内拿不到宿主桥（iframe 真隔离），
//     经 postMessage 白名单桥用宿主能力（fs 数据目录读写 + notify）。
//   - 数据地盘（件 B）：manifest.dataDir: true——装载即分配，server 进程经
//     spawn env LANTAI_PLUGIN_DATA_DIR 读自己的地盘，窗经桥 fs 读 port.json
//     找到 server 的 HTTP 面。
//   - 受治进程（件 C）：server.cjs = 零依赖 Node 进程，两副面孔——对宿主说
//     MCP（stdio：数据四工具随 tools/list 动态进注册表），对自己的窗说极简
//     HTTP API（宿主不掺和）；lifecycle: lazy（首次装配/调用/开窗拉起，空闲
//     回收，再拉再起）。
//   - 后台唤醒（件 D）：notes_export 异步——提交即回卡片，完成经
//     lantai/deferred 完成通知由桥翻译成后台唤醒 + minimal 定位键
//     {status, taskId, sessionId}，内容凭 taskId 再调本工具取。
//
// 两张门各司其职（决策 8）：
//   - MCP 路（实现住在进程里）：notes_list / notes_create / notes_delete /
//     notes_export——声明在 mcpServers，随 tools/list 进注册表；
//   - 工具口（实现必须在宿主侧）：notes_open——声明在 manifest.tools，
//     执行函数 = 本文件 toolHandlers 命名导出（窗口设施只有宿主 webview
//     摸得到，Node 进程碰不到——演示「Agent 命令窗口开合走插件工具」）。
//
// 本文件只有工具口执行体；app/mcpServers 的挂接全由装载器包装层承担
// （loader wrapper apply：数据目录 ensure 先行 → 本 apply → 工具声明挂接 →
// MCP 注册 → app 窗口定义登记），零清理代码（fiber dispose 链式回收）。

// ── 工具口执行体（manifest.tools 声明 notes_open 的 handler）──
// 窗口开合的工具语义归插件：宿主只提供窗口设施（宿主桥 windows 键——
// 开/关/聚焦/查询的宿主能力面，不是工具面）；Agent 调本工具 → 设施开窗。
export const toolHandlers = {
  notes_open: async () => {
    const host = globalThis.__lantai_plugin_host__;
    const open = host?.windows?.open;
    if (typeof open !== 'function') {
      return '[notes_open] 宿主桥不可用——便签窗口设施需在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）';
    }
    const windowId = open('notes-app');
    if (windowId == null) {
      return '[notes_open] 便签窗口定义不在册——插件可能已被停用或卸载，请重新装载后重试';
    }
    return `便签窗口已打开（${windowId}）——窗内可增删便签；数据工具（notes_list 等）随 MCP 路可用。`;
  },
};

export default {
  name: 'notes-app',
  apply() {
    // 装载期零副作用：app/mcpServers/dataDir 全由装载器包装层挂接。
    // （with-window 档的「随窗开合」在治理器层——本插件用 lazy 档，
    // 开窗会触发拉起并阻塞空闲回收，窗关后空闲超时回收。）
  },
};
