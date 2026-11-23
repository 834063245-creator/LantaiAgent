// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 文卷（hologram/md-editor）——第一方软件型插件的源码域薄入口。
//
// 窗口本体是静态 HTML/JS/CSS（`examples/plugins/md-editor/app/`，构建脚本复制到
// `dist-plugins/builtin/hologram/md-editor/app/`）；本入口只提供：
//   - 插件对象（name/apply——装载器硬契约，零装载期副作用）；
//   - md_open 工具（窗口设施归宿主，插件只调 windows.open 并带文档载荷）。
//
// 产物 manifest 的 app / dataDir / tools 由 builtin-roster.json 的 `software` 段生成，
// 不手写（与其它出厂产物同一真源纪律）。

export const toolHandlers = {
  wenjuan_open: async ({ path }: { path: string }) => {
    const host = (
      globalThis as {
        __lantai_plugin_host__?: { windows?: { open?: (name: string, opts?: unknown) => string | null } };
      }
    ).__lantai_plugin_host__;
    const open = host?.windows?.open;
    if (typeof open !== 'function') {
      return '[wenjuan_open] 宿主桥不可用——文卷窗口设施需在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）';
    }
    const windowId = open('hologram/md-editor', { document: { path } });
    if (windowId == null) {
      return '[wenjuan_open] 文卷窗口定义不在册——插件可能已被停用，请重新启用后重试';
    }
    return `文卷已打开（${windowId}）：窗内默认为阅读模式，点「编辑」才进入改稿；保存会先出改稿单，用户确认后才写回。`;
  },
};

export default {
  name: 'hologram/md-editor',
  apply() {
    // 装载期零副作用：窗口定义 / 数据地盘 / 工具声明全由装载器包装层按 manifest 挂接。
  },
};
