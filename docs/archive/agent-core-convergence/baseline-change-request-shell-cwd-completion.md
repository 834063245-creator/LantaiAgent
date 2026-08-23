# Baseline 变更申请 — 两个已批准提交的基线重录补全（shell 粘性 cwd + code_execution minimal 侧）

> 申请日期：2026-08-23 · 申请人：编码助手（P4 B① 试金石批开工前基线审计）
> 状态：**已批准** —— 用户会话拍板（2026-08-23「准了，我知道这个事」）；重录已执行，
> standard + minimal 两轮 record 完成，check 双绿，diff 仅含 6 快照文件。

## 1. 变更对象（5 个快照文件）

| 快照 | 漂移来源 | 漂移内容 |
|---|---|---|
| `baseline/phase-0/tool-schemas.full.json` | 30b54f84（已批准） | shell 域描述新增粘性 cwd / 增量 bash_output 两句 |
| `baseline/phase-0/tool-schemas.plan.json` | 30b54f84（已批准） | 同上（plan 面镜像 full 面） |
| `baseline/preset-minimal/phase-0/tool-schemas.full.json` | 30b54f84（已批准） | 同上 |
| `baseline/preset-minimal/phase-0/tool-schemas.plan.json` | 30b54f84（已批准） | 同上 |
| `baseline/preset-minimal/phase-0/system-prompt.fixture.json` | 30b54f84（已批准） | 行为规则 14/15/16 三条新增（粘性 cwd / 不重跑切片 / 后台增量读） |
| `baseline/preset-minimal/phase-1/tool-schemas.effective.json` | 15930f65（已批准） | count 5 → 6（code_execution）——standard 侧已录、minimal 侧漏录 |

## 2. 为什么必须变

- 30b54f84 的 commit 信息明文「convergence 基线经用户批准重录」，但执行时只重录了
  `baseline/phase-0/system-prompt.fixture.json` 一个文件，漏了 tool-schemas.full/plan
  （standard + minimal）与 minimal 的 fixture——重录执行不完整，非新行为变更。
- 15930f65（code_execution）的 change request（baseline-change-request-code-execution.md）
  覆盖 standard 侧 effective；minimal 侧 effective 同步漏录，count 停在 5。

## 3. 证据

- `verify:convergence` 漂移报告：reports/check-2026-08-23T05-03-45-833Z.md（standard，
  2 failed）与 check-2026-08-23T05-04-52-272Z.md（minimal，4 failed）；
- 漂移内容逐条核对 commit 30b54f84 的 domains.ts / prompt-sections.ts diff——全部
  可在已批准代码变更中找到对应行，无快照独有内容；
- 工作区无 convergence 相关未提交改动（git status 确认）。

## 4. 拟议变更

- 采纳 record 快照（六文件重录，与已批准代码现状逐字节一致）。
- record 独立成 commit（与 B① 搬运批分离）。

## 5. 落地步骤

1. ✅ 本文件获用户批准；
2. ✅ `CONVERGENCE_RECORD=1` record（standard + minimal 两轮，gate.mjs record 子命令）；
3. ✅ record 后 `git diff` 核对：只含 6 快照文件（+29/-7），无代码变更；
4. ✅ check exit 0 双绿（reports/check-2026-08-23T05-11-57-777Z.md / check-2026-08-23T05-12-09-116Z.md）；
5. ✅ 独立 commit。
