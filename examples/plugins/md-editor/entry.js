// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 文卷 0.5.0 — 软件级插件入口。
//
// 入口形状是硬契约（loader 阶段 2）：`pickPluginObject` 优先取 `default` 导出，
// `isPluginShape` 要求 `{ name, apply }`，且 name 必须与 manifest.name 逐字一致。
//
// 工具语义归插件、窗口设施归宿主（与 notes-app 的 notes_open 同款分工）：
//   Agent 调 md_open(path) → 本文件调宿主桥 `windows.open(插件名, { document })`
//   → 宿主开窗并签发文档令牌 → 帧在就绪后把令牌推给窗 → 窗凭令牌 doc.read。
//   **路径不经过窗**：窗只拿到令牌与「读哪一页」的标识。
//
// 0.5.0 起按扩展名分派 Markdown / 代码 / 文本；本入口不加职责。

export const toolHandlers = {
  md_open: async ({ path }) => {
    const host = globalThis.__lantai_plugin_host__;
    const open = host && host.windows ? host.windows.open : undefined;
    if (typeof open !== 'function') {
      return '[md_open] 宿主桥不可用——文卷窗口设施需在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）';
    }
    const windowId = open('md-editor', { document: { path } });
    if (windowId == null) {
      return '[md_open] 文卷窗口定义不在册——插件可能已被停用或卸载，请重新装载后重试';
    }
    return `文卷已打开（${windowId}）：窗内默认为阅读模式，点「编辑」才进入改稿；保存会先出改稿单，用户确认后才写回。`;
  },
};

export default {
  name: 'md-editor',
  apply() {
    // 装载期零副作用：窗口定义 / 数据地盘 / 工具声明全由装载器包装层按 manifest 挂接。
  },
};
