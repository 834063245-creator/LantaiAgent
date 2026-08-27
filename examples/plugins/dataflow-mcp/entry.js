// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// dataflow-mcp 示例插件入口（平台化 P4 · D1）——本插件的全部能力经
// manifest.mcpServers 声明式挂接（S4-4 乙机器桥），entry 本体零贡献：
// 这个文件的存在只为满足 loader 的「entry 存在且导出 { name, apply }」
// 契约。能力实体在 server.cjs（外部 MCP server 进程）。
//
// 想写「进程内宿主插件」？本例就是反面答案：跨进程能力走 MCP / 前端
// seam / 外部 ESM 插件三条路，进程内宿主通道永久关闭（composition 计划
// 内核线裁定）。

export const name = 'dataflow-mcp';

export async function apply() {
  // 声明式 mcpServers 的注册动作归 loader 的机器桥包装层——entry 无事可做。
}
