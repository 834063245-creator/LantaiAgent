# Baseline 变更申请 — phase-0/tool-schemas.full.json + phase-1/tool-schemas.effective.json（Agent 工具面 × 引擎能力同步）

> 申请日期：2026-08-19 · 申请人：编码助手（工具面迭代：semantic_search 一等化 / dataflow 折叠 / write_constraints / 参数枚举化）
> 状态：**已批准** —— 用户在对话中批准整个工作包（"那就开工吧，你去建一个新的worktree……等全部做完之后再合并"），
> 本文件按 2026-08-19 模板补全审批记录，record 以独立提交执行。

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`
- `src-ui/tests/convergence/baseline/phase-1/tool-schemas.effective.json`
- 变更内容：
  - `graph` 域 `action` 枚举 24 → **27 项**（新增 `semantic` / `dataflow_save` / `dataflow_query`），域 description 重写（semantic 语义检索入口 + dataflow 写动作标注）；
  - `fs` 域 `action` 枚举 10 → **11 项**（新增 `write_constraints`），域 description 更新；
  - phase-1 effective 快照同步以上工具面变化。
- **模型可见表面：确有计划性变更**（用户批准的工具面迭代核心交付物），非伪漂移。

## 2. 为什么必须变

- 引擎向量检索子系统（MiniLM ONNX + usearch HNSW）此前只以 `search_symbols` 的「边车附加」暴露（≤5 条 node_id+分数），
  本次升级为一等工具 `semantic_search`（完整节点信息 + 相似度 + top-k 可控），并接进 `graph(semantic)`；
- `dataflow_save` / `dataflow_query` 原以裸名注册漏在领域收敛外（违反自家「工具一律用领域名」规矩），折叠进 `graph` 域；
- `write_constraints` 补齐 `check_boundaries` 发现违规后的规则固化闭环（引擎只读不写的断口）；
- 引擎 schema 参数枚举化（mode/filter/sort_by/kind_filter/detail_level）——mod.rs 侧 inputSchema.enum，
  领域扁平 schema 合并后模型可见描述同步变化。

## 3. 证据

- record 后 `git diff` 只含上述快照文件；
- 新增 `tests/engine-tool-surface.test.ts`（6 用例）钉住「引擎默认清单 ↔ DOMAIN_SPECS ↔ mock 清单」三层对齐；
- 工具面测试组 95/95 通过（engine-tool-surface / domains-convergence / tool-param-contract / tool-semantics / plan-gate / define-tool）；
- 引擎 cargo test 全绿（新增 3 用例：空 query 降级 / 无索引降级 / 命中+节点解析）。

## 4. 拟议变更（record 已生成）

- 采纳 record 快照（graph 27 动作 + fs 11 动作 + semantic_search schema 与实代码逐字节一致）。

## 5. 落地步骤

1. ✅ 引擎侧交付（semantic_search 工具 + 参数枚举 + 单测）；
2. ✅ TS 侧交付（DOMAIN_SPECS / write_constraints / mock 对齐 / 防漂移测试）；
3. ✅ 本文件重写；
4. ✅ 用户批准（开工指令即批准）；
5. ✅ record:convergence 独立提交执行；
6. ✅ biome check 改动文件（exit 0；9 warnings 为存量非本次引入）。

## 6. 遗留观察（不在本次范围）

- `search` 域（单动作 content）与 memory 语义检索的进一步融合留待后续；
- 领域扁平 schema 同名参数类型合并（domainParametersSchema 取首类型）目前无冲突实例，未加检测。
