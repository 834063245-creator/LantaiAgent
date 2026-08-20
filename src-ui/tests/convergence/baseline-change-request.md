# baseline change request — exit_plan_mode options.outcome

- **日期**: 2026-08-20
- **请求 Agent**: 主 Agent（执行模式）
- **涉及快照**: `baseline/phase-1/tool-schemas.effective.json`（首个差异第 31 行）
- **状态**: 待人类审批

## 变更内容

`exit_plan_mode` 的 `options` 数组元素 schema 新增可选字段 `outcome: 'execute' | 'archive'`（默认 execute）。

语义：
- `execute`（默认）：批准即切换执行模式，与现状一致；
- `archive`：批准方案选择但仅留档——**保持规划模式**（写门禁继续拦截），等用户明确说开工再退出。

## 为什么变（动机）

多方案审批（options ≥ 2）时用户批准某个方案，常常只是"定了方向"，并不意味着"现在就动手"。
当前模型收到批准后立即被视为执行指令，工具面全部恢复——模型容易顺手开工，用户失去节奏控制。
`archive` 给审批结果增加"方向已定、暂不开工"的表达，批准与开工解耦。

## 影响面

模型可见表面变化（这正是本请求的核心）：
1. `exit_plan_mode.parameters` 多一个可选 enum 字段 `outcome`（zod → JSON Schema），影响第 31 行起的 JSON 序列化；
2. 工具 description 不变；
3. 其余 66 个领域工具 schema 不动（baseline 其他部分零差异）。

产品行为变化：
1. `archive` 方案被选中时规划模式不退出（PlanStateManager 不调 exit()）；
2. 工具结果消息引导模型等待用户开工指示；
3. PlanPart 卡片上 archive 方案显示"留档不执行"标签（ChatMessages.tsx + chat.css）。

测试：
- 新增 `tests/plan-outcome.test.ts`（7 用例：默认 execute / option archive / UI 覆盖双向 / revise+rejected / 非规划模式 / headless 自动批准）；
- `tests/plan-gate.test.ts` 等 5 个既有测试文件全绿（72 passed）；
- `tsc --noEmit` 零错误。

## 前缀缓存影响

`outcome` 是 options 数组内元素的可选字段，不改工具面顺序（capability 表序不变），只改单个工具的 schema JSON。
模型请求中的工具定义部分会有这一字段差异——对 DeepSeek 前缀缓存的实际影响限于 exit_plan_mode 一项的 definition 长度（约 +200 字节），不影响其他工具的缓存命中。

## 待人类决定

1. 接受该字段进入模型可见表面 → 批准后由独立 record 提交更新 `tool-schemas.effective.json`；
2. 拒绝 → 回滚 plan-tools.ts 的 schema 改动（outcome 解析逻辑可保留，仅靠 UI 显式 outcome 覆盖，不暴露给模型）；
3. 改设计 → 反馈方向。
