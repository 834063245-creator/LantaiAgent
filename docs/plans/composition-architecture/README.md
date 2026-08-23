# 组合架构（composition-architecture）——特权线左移计划

> **本目录阅读顺序**：① 本 README（宪法 + 现状）→ ② [`HISTORY.md`](HISTORY.md)（S0-S2/S4 施工史与批次记录）→ ③ `designs/`（设计件全文）。边界依据 [`docs/adr/composition-boundaries.md`](../../adr/composition-boundaries.md)。
> 立项：2026-08-20 · 状态：**S0-S4 全竣工（S3 于 2026-08-22 收官——全段竣工）**

## 一句话

把「给固化宿主开插件口子」反转为「移动特权线」：内核线收敛到最小，线外一切——**包括第一方代码**——走同一条声明式组合管道（roster 行 + patch 叠加 + preset realm）。

## 宪法（内核线定义）

**内核线内（特权代码，永不插件化）：**
1. cordis kernel（vendored）+ 根引导
2. Loader + 组合引擎本体（roster 解析 + patch 叠加 + 行生命周期）
3. slot / 注册表本身（panels/commands/tools/providers/renderers 五 service 的注册机制）
4. React root 挂载点 + 壳容器（App 骨架 / DockPanel 容器）
5. RPC 平台面（rpc.rs 冻结契约 + agentInvoke 动态分发 + biome 受权出口）
6. **Agent↔engine 耦合带**：图数据管线、graph hooks、执行腰——产品核心，永久特权
7. 星图 scene（`src/scene/**`）——GPU 资源 + dispose 纪律，永久豁免

**线外一切皆行**：面板 / 命令 / 工具 / provider / system-prompt section / 第一方功能域。
**试金石**：独占进程级单例资源或有顺序契约 → 宿主；功能面 → 行。

## 现状（全段竣工）

**S3 — 第一方行化**已收官（2026-08-22）：settings 面板域迁成第一方插件（`plugins/settings-plugin.ts` 面板 + 命令双贡献；paper 域同步补齐 `paper/toggle` 命令；`PANEL_DEFS` 常量面清空；快捷键链路经 `app/actions.ts` 别名翻译层桥接，useGlobalKeys 字面量不变）。施工史与裁决记录见 [`HISTORY.md`](HISTORY.md) S3 段。

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
