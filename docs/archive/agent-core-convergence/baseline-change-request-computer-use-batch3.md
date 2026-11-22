# Baseline 变更申请 — phase-0/tool-schemas.{full,plan}.json（批 3：桌面批处理）

> 申请日期：2026-11-22 · 申请人：编码助手（computer use 四批计划 批 3 / P1-1）
> 状态：**已批准**（2026-11-22 用户会话内批准"baseline 申请通过"）——record 已执行。
> 关联计划：`.lantai/plans/plan-1795321025508-cc89.md`

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`
- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.plan.json`

## 2. 漂移内容（本批唯一来源）

| # | 变更 | 模型可见后果 |
|---|---|---|
| 1 | **新增动作** `desktop_uia_batch`（schema：`steps` / `on_error` / `max_steps` / `hwnd` / `pid` / `title`） | 模型知道可以「一次审批跑多步」，也被告知步白名单、敏感目标整批拒绝、默认 stop、上限 20、同窗口约束 |
| 2 | 动作描述新增一条（约 900 字符） | 描述字节变化 |
| 3 | `desktop` 域 `actions` 表新增 `uia_batch` 寻址（域描述本身未变） | 域门面多一个可调动作 |

工具面增量 = **1 个动作**（18 → 19? 见注）；不新增域、不新增 capability。

> 注：desktop 域此前 17 个细粒度动作（退役前 builtin.uia 名单）+ 批 3 新增 batch = 18 个
> 细粒度工具 + `desktop_uia_fill` 复合工具（既有）——能力口 `uia_cap` 的 action 全集
> 由 17 变 18（`commands/uia_cap.rs` 的 ACTIONS 表与测试同步）。

## 3. 为什么必须变

- 批 3 的目标是「长任务不再一次一问」。批处理必须是一个**真实可调动作**，否则模型无法使用；
  其约束（白名单/敏感拒绝/stop 默认/上限/同窗口）必须写进描述——这些是安全面的一部分，
  模型不知道就会反复试错。
- 审批语义：一次批准覆盖整批（用户看到前 5 步摘要）。这是本批刻意让渡的控制粒度，
  收紧面全部落在代码里（白名单、敏感拒绝、stop 默认、20 步上限、单窗口）。

## 4. 证据

- 代码面：`commands/uia_batch.rs`（新模块 567 行：白名单 `ALLOWED` / 只读集 `READONLY` /
  `MAX_STEPS=20` / 预检分类（敏感即拒）/ 批级 action 取最严 / 一次过闸 / 批准即接管 /
  物理步共享一次租约 / 串行执行 / `on_error` stop|continue / 每步 + 批头审计 /
  步结果 800 字符裁剪）；`commands/uia_cap.rs` 仅加一行 dispatch + helpers 提为 `pub(super)`；
  `browser.ts`（schema + 描述 + readOnly + 动作路由 + 域 actions）、`domains.ts`（actions 表）；
- 生成物：`npm run gen:tool-contract` 已重写 `docs/agents/model-tool-contract.md`；
- 测试：`cargo test --bins batch` 5/5（白名单禁入清单 / 只读集是子集 / 20 步上限 /
  坐标优先的审计描述 / 结果裁剪）· `cargo test --bins desktop` 9/9（含 18 动作表）·
  `vitest tests/desktop-tools.test.ts + desktop-uia-new-actions.test.ts` 29/29（新增
  「批处理工具在册且非只读」「域 action 表含 uia_batch」两例）。

## 5. 拟议变更

采纳 record 生成的新快照（full + plan 两份），其余快照零变化。

## 6. 落地步骤

1. ✅ Rust 批处理主体 + 单测
2. ✅ TS schema/描述/路由/域 actions + 测试
3. ✅ 契约文档重生成
4. ⬜ 用户批准本申请（与批 1、批 2 两份一并）→ `record` 刷新快照
5. ⬜ 复跑 `verify:convergence`（standard + minimal）全绿
