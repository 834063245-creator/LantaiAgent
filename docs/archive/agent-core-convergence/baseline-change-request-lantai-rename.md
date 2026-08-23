# Baseline 变更申请 — phase-0/plan-gate.decisions.json + phase-0/hook-pipeline.trace.json（`.hologram` → `.lantai` 目录改名）

> 申请日期：2026-08-23 · 申请人：编码助手
> 状态：**待批准** —— 等用户审批通过后，方可考虑是否需要走 record 流程对拍验证。
> 本次为**纯文本同步**（改 baseline 中的字面量，与源码侧已完成的派生路径一致），未跑 record。

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/plan-gate.decisions.json`（5 处）
- `src-ui/tests/convergence/baseline/phase-0/hook-pipeline.trace.json`（1 处）
- `src-ui/tests/convergence/baseline/preset-minimal/phase-0/plan-gate.decisions.json`（5 处）
- `src-ui/tests/convergence/baseline/preset-minimal/phase-0/hook-pipeline.trace.json`（1 处）

变更内容：baseline 中所有 `/proj/.hologram/plans/plan-<id>.md` 字面量改为 `/proj/.lantai/plans/plan-<id>.md`。

**模型可见表面：无变更**——只是拒绝文案中的示例路径字面量同步；plan-gate 的拦截逻辑、schema、action 集合均未变。

## 2. 为什么必须变

2026-08-23 用户拍板 `.hologram` → `.lantai` 目录改名（仅目录改，二进制/工具名/npm 包不动）。
源码侧 `src-ui/src/agent/plan/plan-state.ts::_derivePlanPath` 派生路径已由 `.hologram` 改为 `.lantai`：

```ts
// 改前：return `${base}/.hologram/plans/${id}.md`;
// 改后：return `${base}/.lantai/plans/${id}.md`;
```

plan-gate 拒绝文案是**运行时**通过 `planState.state.planFilePath` 拼出来的，源码改后实际输出已经是 `.lantai` 路径。baseline JSON 是上次 record 时的旧输出快照，需要同步。

## 3. 证据

- 源码侧改动：`src-ui/src/agent/plan/plan-state.ts` L103 `_derivePlanPath`（已在批量改名中替换）。
- 文本替换：baseline 4 个文件共 12 处 `.hologram` → `.lantai`，全部位于 `/proj/.hologram/plans/plan-<id>.md` 字面量。
- **未跑 record 对拍验证**：本机 vitest 跑 convergence specs 报 `No such built-in module: node:`（jsdom 环境不识别 `node:fs`，**baseline 就有的环境问题**，与本次改动无关）。等该问题修复后再走 record 对拍。

## 4. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| baseline 与源码不同步导致 verify:convergence 误报漂移 | 中 | 本次为**对齐**而非分歧——baseline 改成与源码派生路径一致 |
| 未跑 record 直接改 baseline 文本 | 低 | 字面量同步，无结构变化；后续 record 对拍会自然验证 |

## 5. 回滚

`git revert` 本次 baseline 改动即恢复 `.hologram` 字面量。但若同步回滚 `plan-state.ts` 改动，模型可见的 planFilePath 也会回到 `.hologram`——需要配套回滚。
