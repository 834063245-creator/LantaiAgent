# 工作区概念归属：从 engine 中心到 Agent 中心（立案，未决）

> 日期：2026-08-20 · 状态：**Open（R3 议题，非今日施工项）**
> 提出者：用户（2026-08-20，S2 落地期间原话：「工作区从软件诞生第一天围绕 engine 设计，现在需要围绕 agent 设计；会话绑定工作区是正确方法」）
> 关联：两产品形式化（composition-boundaries ADR §4.1）——本文是该分界在「工作区」概念上的收尾
> 归宿：paper-shell R3 访谈拍板；施工窗口 = 走查弹之后（不与组合层 S2 叠 diff）

## 问题

Workspace 入口层今天是 engine 中心的：open(path) 的第一公民是图谱分析/星图/检查面板，Agent 是树上顺带挂的果实。软件重心转向 Agent 产品（A）后，此概念归属需要倒置：Workspace 变为 Agent 的家，图谱降格为 Agent 的感官（可按会话装载的资源）。

## 现状证据（2026-08-20 实查）

- **数据层已是身份中心**：`.hologram/agents/{agentId}/`、`taskboard/{sessionId}.json`、`goals/{id}/`——Agent 持久化按身份组织，不按工作区。
- **无图谱路径已有雏形**：`createAgentOnlyWorkspace`（仅 Agent 模式占位工作区，永不激活）+ `createPlaceholderAgent`。
- **解耦前置已定**：R2 活引用（块挂文件源不挂工作区）+ 组合层 S1 行表（装配不依赖 Workspace 单例）——翻转的两块地基已铺。
- **engine 侧本来无绑**：图谱机器（G）以 stdio MCP / TCP 服务外部消费者，本就不持有 Workspace 概念。

## R3 待拍子题（预列，访谈时用）

1. 图谱降格为会话属性（Agent 的感官）后，跨目录会话的形态；
2. 会话 ↔ 工作区绑定粒度（一对一 / 一会话多目录）；
3. 无图谱启动升格一等入口（欢迎页 = 新会话而非选项目？）；
4. 星图/dock 面板等「工作区之子」的归宿（预期随 V5 退役自然消解）。

## 纪律

本文只立案不设计。R3 访谈时机 = 走查弹完成后（体感先于拍板）；在此之前不动 workspace.ts。
