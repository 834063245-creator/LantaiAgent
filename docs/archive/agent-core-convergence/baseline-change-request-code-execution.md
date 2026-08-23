# Baseline 变更申请 — phase-1/tool-schemas.effective.json（P2 执行原语 code_execution）

> 申请日期：2026-08-23 · 申请人：编码助手（agent-plugin-architecture-plan P2）
> 状态：**已批准** —— 用户在会话中拍板 P2 开工与第 0 步产品决策（方案 A：新增 code 块 kind），
> 本计划明文要求「capability 表序显式选定 + 上线前后对拍 effective 快照」（D7/R3），
> baseline 变更是该交付物的直接组成。record 已执行。

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-1/tool-schemas.effective.json`
- 变更内容：runtime 侧工具面 count 5 → **6**（新增 `code_execution`——code/description 两参数，
  defineTool + zod v4 产出，passthrough 形状与 ask_user/wait 同族）。

## 2. 为什么必须变

- P2 执行原语（C4 判据）：`code_execution` 是计划交付物本体——模型一次工具调用 =
  一个 JS 程序体，程序内以 `await tools.<name>(args)` 嵌套调用 registry 可见工具。
- 工具面增量 = 1（计划 D2：不摊平工具面、schema 面最小增量）；常驻名不进
  DOMAIN_SPECS（与 ask_user/wait 同类的会话级原语，经 blueprint capability 注册）。

## 3. 证据

- record 后 `git diff` 只含上述快照文件（+23/-1 行，单工具新增）；
- 新增测试：`tests/code-execution.test.ts`（16 用例：C5 嵌套审计 / C8 预算超限·程序异常·
  语法错误·超时·中止 / 敌意校验 / 读并行写串行 / 工具本体）+
  `tests/paper-code-block.test.ts`（6 用例：translate 特判 / measure 封顶 / 渲染器行）；
- `tests/blueprint.test.ts` 表序断言同步（code-execution-tool 插在 compaction-tools 与
  converge-tools 之间——D7 显式选位）；
- verify:convergence record 后 check exit 0。

## 4. 拟议变更（record 已生成）

- 采纳 record 快照（code_execution schema 与实代码逐字节一致）。

## 5. 落地步骤

1. ✅ 协议层 + worker bootstrap + 宿主桥（`src/agent/code-run/` 三件）；
2. ✅ code_execution 工具 + blueprint capability + Agent.dispatchNestedTool；
3. ✅ session-log 新增 tool/code-dispatch-start / tool/code-dispatch（无投影审计对）；
4. ✅ 纸壳程文块（BlockKind 'code' + translate 特判 + 内置渲染器行 + measure + CSS）；
5. ✅ 本文件 + record 独立执行；
6. ⬜ 门禁全量（build ✅ / vitest / biome 改动文件）。
