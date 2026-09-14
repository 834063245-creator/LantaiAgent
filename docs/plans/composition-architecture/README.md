# 组合架构（composition-architecture）——特权线左移计划

> **本目录阅读顺序**：① 本 README（宪法 + 现状）→ ② [`HISTORY.md`](HISTORY.md)（S0-S2/S4 施工史与批次记录）→ ③ `designs/`（设计件全文）。边界依据 [`docs/adr/composition-boundaries.md`](../../adr/composition-boundaries.md)。
> 立项：2026-08-20 · 状态：**S0-S4 全竣工（S3 于 2026-08-22 收官——全段竣工）** · **平台边界修订（2026-08-25，`agent-platformization-plan.md` Phase 0：内核线改强制层/能力契约层二分）** · **S6 草案待批（2026-09-14，per-agent 组合：[`designs/S6-per-agent-composition.md`](designs/S6-per-agent-composition.md)）**

## 一句话

把「给固化宿主开插件口子」反转为「移动特权线」：内核线收敛到最小，线外一切——**包括第一方代码**——走同一条声明式组合管道（roster 行 + patch 叠加 + preset realm）。

## 宪法（平台边界：强制层 vs 能力契约层）

> 2026-08-25 按 `agent-platformization-plan.md` Phase 0 修订（推翻旧内核线第 6 条
> "Agent↔engine 耦合带永久特权"）。权威定义：`docs/adr/project-constitution.md` 第五条「平台边界」。

**强制层内（特权代码，永不插件化）：**
1. cordis kernel（vendored）+ 根引导
2. Loader + 组合引擎本体（roster 解析 + patch 叠加 + 行生命周期）
3. slot / 注册表机制（全部 ctx 服务的注册机制——panels/commands/tools/renderers/prompts/hooks/capabilities/overlays/space/lsp/codeRuntime 等）
4. React root 挂载点 + 壳容器（App 骨架 / DockPanel 容器）
5. RPC 平台面（rpc.rs 冻结契约 + 权限咽喉 + agentInvoke 动态分发 + biome 受权出口）
6. 强制设施：沙箱内核（os_sandbox / sandbox 强制原语）· 审计 · Workspace 原语（fiber·epoch·scoped store）
7. 星图 scene（`src/scene/**`）——GPU 资源 + dispose 纪律，永久豁免

**能力契约层（线外，可 plugin / provider 化）：**
- 一切功能面与能力实现：面板 / 命令 / 工具 / prompt section / capability / 管道钩子 / 渲染器 / 画布形态 / 第一方功能域。
- **能力实现不是特权**：fs / shell / subprocess / session 持久化 / graph 分析 / LLM / 子代理 / agent loop 均为 seam——Rust / engine 只是默认 provider 后端，可被配置替换或叠加。
- 新能力加面规则：优先开放面（前端 seam / 外部 MCP / 动态插件）；**强制层外不得新增 Rust 命令**（守卫测试 `src-tauri/tests/platform_boundary_test.rs` 钉住）。

**试金石**：独占进程级单例资源 / 有顺序契约 / 是强制层（权限·沙箱·审计·IPC）→ 强制层；功能面 / 可换实现 / 可叠加 → 行或 provider。

## 现状（全段竣工）

**S3 — 第一方行化**已收官（2026-08-22）：settings 面板域迁成第一方插件（`plugins/settings-plugin.ts` 面板 + 命令双贡献；paper 域同步补齐 `paper/toggle` 命令；`PANEL_DEFS` 常量面清空；快捷键链路经 `app/actions.ts` 别名翻译层桥接，useGlobalKeys 字面量不变）。施工史与裁决记录见 [`HISTORY.md`](HISTORY.md) S3 段。

**S6 — per-agent 组合**（2026-09-14 草案待批）：把组合从「全局状态的一次函数求值」推到「每 Agent 一份值」——卷级选择 + 选择集（默认关行/回开）+ 装配期 provider 值注入 + 插件按需激活（引用计数）。路径选择 = **视图 + 引用计数**（不抄 DSH 的 scope realm；realm 仅作资源型插件的逃生门）。设计件：[`designs/S6-per-agent-composition.md`](designs/S6-per-agent-composition.md)；立项输入 = 2026-09-14 组合层审计（F1-F6 断链已修）+ 用户三项拍板（差异到插件集合层 / UI 与程序双入口 / 全粒度并存）。

协作纪律延续：**重构推到哪个域，行化跟到哪个域**——不抢跑未动的域。新增功能的审查试金石：是行还是特权代码堆积？

## 活的运维入口

- **用户文档**：`docs/composition/README.md`（patch 语法/preset/热重载/涟漪表——改 roster 引擎或 patch 语义前必读）
- **插件契约**：`docs/plugins/README.md`（manifest/三通道 API/宿主桥/安装/信任模型）
- **baseline 变更审批**：`docs/archive/agent-core-convergence/baseline-change-request.md`（归档目录里的活流程文件）

## 验证命令（每阶段门禁）

```bash
cd src-ui && npm run build && npx vitest run && npx biome check <改动文件>
cd src-ui && npm run verify:convergence   # 触 agent 工具面强制
cd src-tauri && cargo check && cargo test # 触 Rust 时
```
