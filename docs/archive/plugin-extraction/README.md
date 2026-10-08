# 插件化欠账（plugin-extraction）— 已归档施工单与设计件

> **已归档（2026-10-08 · 文档面收尾）**——本目录收「插件化欠账」线（2026-09-04 立账 → 2026-09-26 清零）
> 的八份过程文档。**账② 物理归家已清零**：红区 **0 产物 / 0 文件 / 0 行**，纯壳集 21 → 0。
> **现状与在办真值**：[`plugin-extraction-inventory.md`](../../plans/plugin-extraction-inventory.md) §5（三色基线）/ §6（批次表）
> ＋ [`docs/plans/README.md`](../../plans/README.md)；规则承接 [`PLUGINS.md`](../../../PLUGINS.md) 与 [`docs/plugins/README.md`](../../plugins/README.md)。

## 本目录文件（9）

| 件 | 是什么 | 竣工 |
|---|---|---|
| [`factory-products-homing-plan.md`](factory-products-homing-plan.md) | 出厂产物归家总图纸（魂身合一：实现物理搬进插件包） | 2026-09-26（账② 清零） |
| [`batch-9-extraction-design.md`](batch-9-extraction-design.md) | 批 9 施工单（拆分件 + 常驻面 + 内核产品件 ≈11,000 行） | 2026-09-26 |
| [`batch-9h-agent-domain-seam-design.md`](batch-9h-agent-domain-seam-design.md) | 批 9h 施工单（agent 域五件归家：capability-segments / agent-loop / skill / memory / task） | 2026-09-26 |
| [`measure-engine-seam-design.md`](measure-engine-seam-design.md) | 批 9c-4 施工单（测量引擎接缝化） | 2026-09-26 |
| [`provider-data-face-homing-design.md`](provider-data-face-homing-design.md) | 批 9f 施工单（provider 数据面归家） | 2026-09-26 |
| [`capability-impl-seam-design.md`](capability-impl-seam-design.md) | 批 6 施工单（plan / goal / compaction / state-hooks 的「内核登记表 + 产物登记实现」接缝） | 2026-09-24~26 |
| [`multiagent-extraction-design.md`](multiagent-extraction-design.md) | 批 7 施工单（子代理运行时 + 通信族 + discovery） | 2026-09-24 |
| [`workspace-activation-channel-design.md`](workspace-activation-channel-design.md) | 批 10 设计件（`ctx.workspaces` / `ctx.shellRows` 两条宿主生命周期贡献面）+ 随包引擎产物化 | 2026-09-26 |
| [`renderer-face-extraction-design.md`](renderer-face-extraction-design.md) | 批 8 施工单（纸面块渲染器 + 重查看器白名单 + 类型环 ⇒ 新产物 `paper-renderers/`） | 2026-09-25 |

## 为什么归档

这八份的头部原写着「待施工 / Proposed / 未开工」，而批次早已全落、账本逐条销账——
**头部状态过期会骗人**：下次翻计划的人（含 Agent）会把它们重新算进「还剩多少没做」。
按 CONVENTIONS §4「竣工即归档」搬入此处，每份顶部留归档横幅 + 现状指针。

同线的**图版架**（`asset-rack-plan.md`）当时暂留 `docs/plans/`（代码已落、§6 九条真机验收在办）；
**2026-10-08 已随第二批归档**（判据一致：验收欠账不构成在办标记）——见 [`../render-paper-line/`](../render-paper-line/README.md)。
