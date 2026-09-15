# docs/adr — 架构决策记录（索引）

> 本页是 ADR 的**唯一入口**。规则优先级：`project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > 其余。
> ADR = **已拍板的决策与它的边界**，不是教程；与代码冲突时以代码为准并更新本目录（见 `CONVENTIONS.md` §4）。

| ADR | 决策 | 状态 |
|---|---|---|
| [`project-constitution.md`](project-constitution.md) | **项目宪法：四条架构约定**——类型边界（禁 String 当合约）/ 单一权威源 / 异步纪律 / 错误不静默 | Accepted（最高优先级） |
| [`composition-boundaries.md`](composition-boundaries.md) | 组合边界：为什么兰台不做 DSH 式全体插件化（强制层 vs 能力契约层二分） | Accepted（2026-08-20） |
| [`workspace-concept-ownership.md`](workspace-concept-ownership.md) | 工作区概念归属：从 engine 中心 → Agent 中心（会话归工作区） | Implemented（workspace-flip 批 1-5 竣工） |
| [`loop-purity.md`](loop-purity.md) | Loop 纯度原则：主循环内非材料皆噪音 | Accepted |
| [`mode-switching.md`](mode-switching.md) | 模式切换系统（Plan / Goal 等模式的定义与切换语义） | Accepted（修订版 v4） |
| [`0001-provider-id-three-in-one.md`](0001-provider-id-three-in-one.md) | Provider 身份三合一（ProviderId = 配置身份 = 系统凭据键 = 动态模型合并键） | Accepted |
| [`0002-provider-kind-is-protocol.md`](0002-provider-kind-is-protocol.md) | Provider 的 `kind` 是协议（Protocol），不是厂商（Vendor） | Accepted |
| [`0003-agent-browser-cdp-suite.md`](0003-agent-browser-cdp-suite.md) | Agent 浏览器控制套件：目标形态与核心决策 | Accepted（已落地，回归见 `docs/plans/browser-cdp-suite-review-round2.md`） |

## 相关现状文档

- Provider 体系定稿规格：[`../design/provider-system-spec.md`](../design/provider-system-spec.md)
- 组合层用户指南（preset / patch / 热重载）：[`../composition/README.md`](../composition/README.md)
- 插件契约总览：[`../plugins/README.md`](../plugins/README.md)
- 已知技术债与拆弹状态：[`../landmine-map.md`](../landmine-map.md)
