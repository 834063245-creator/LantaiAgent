// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 最小插件入口（模板 · 2026-11-23 契约工具包）。
//
// 入口形状是**硬契约**（loader 阶段 2）：默认导出 { name, apply }，且 name 必须
// 与 manifest.name、目录名**逐字一致**（装载器按目录名寻址）。
//
// 分工：工具语义归插件、窗口设施归宿主。apply 里只做注册动作——本模板零注册
// （窗口定义与工具声明都由装载器按 manifest 挂接）。插件模块必须自包含：
// 没有包管理器、没有 import map，裸 import（'react' / 'zod'）解析不了。

export const toolHandlers = {
  my_plugin_open: async () => {
    const host = globalThis.__lantai_plugin_host__;
    const open = host && host.windows ? host.windows.open : undefined;
    if (typeof open !== "function") {
      return "[my_plugin_open] 宿主桥不可用——插件需在兰台宿主内装载（window.__lantai_plugin_host__ 缺失）";
    }
    const windowId = open("my-plugin");
    if (windowId == null) {
      return "[my_plugin_open] 窗口定义不在册——插件可能已停用/卸载，重新装载后重试";
    }
    return "窗口已打开（" + windowId + "）";
  },
};

export default {
  name: 'my-plugin',
  apply() {
    // 装载期零副作用：窗口定义 / 工具声明由装载器按 manifest 挂接。
  },
};
