# baseline change request — minimal 轨重录（office 域漏录，2026-09-13 起静默漂移）+ verify 门禁改双轨（2026-09-14）

- **日期**: 2026-09-14
- **请求 Agent**: 组合层审计修复执行 Agent（同日先落 F1-F6 断链修复批）
- **涉及快照**: `baseline/preset-minimal/phase-0/tool-schemas.full.json`（count 12 → 13）、`baseline/preset-minimal/phase-0/tool-schemas.plan.json`（count 14 → 15）——两文件的**唯一内容变化 = 新增 `office` 域工具 schema**（diff 形状：`count` 行替换 + 131 行插入，无其它行改动，可逐行对拍）
- **状态**: **已批准（2026-09-14 用户拍板「两件一起，开工」——本批 = P-1 authoring 环境 + P0.5 minimal 重录与双轨门禁，设计件 `docs/plans/composition-architecture/designs/S6-per-agent-composition.md` §4 批表）**

## 变更内容

**只补快照，不改模型可见面**：`2d54081f`（office 域改一等工具，2026-09-13）已把 `office` 加进模型面，
但**只重录了 standard 轨**——`baseline/preset-minimal/` 停留在 2026-09-09（`f1ca3dd8`），
于是 minimal 轨自 2026-09-13 起静默漂移（`CONVERGENCE_PRESET=minimal` 实测 phase-0 两条红：
full 期望 12/实际 13、plan 期望 14/实际 15）。本请求 = 把该轨重录到与当前装配面一致。

**附带修复（本批同时落地）**：`verify:convergence` 从「只跑 standard」改为**双轨**
（`gate.mjs check` + `CONVERGENCE_PRESET=minimal gate.mjs check`）；CI 的 `convergence.yml`
调的就是这个 npm script，因此自动获得第二轨——**不改任何 workflow 文件**。

## 为什么变

1. **根因**：预设轨的快照不是自动产物，靠人记着重录；`2d54081f` 漏了 minimal 侧。
2. **为什么没人发现**：`npm run verify:convergence` 与 CI（`.github/workflows/convergence.yml`）
   都不设 `CONVERGENCE_PRESET`，`gate.mjs` 缺省 = standard；minimal 轨需显式运行，
   而**没有任何自动路径会跑它**。文档里「convergence 双 preset 零漂移」这句话长期失真
   （本批已同步更正 `AGENTS.md` §10 与 `CLAUDE.md`）。
3. **这是第三次复发**：先例 `docs/archive/agent-core-convergence/baseline-change-request-tool-ergonomics-waist.md:40-48`
   原文记过一次（「minimal 套件不在默认门禁（需 CONVERGENCE_PRESET=minimal 显式运行），
   漏项潜伏两天未被发现」，同款先例 `5b5c20a9`）。双轨门禁是针对该复发模式的**机制性修复**：
   轨不在门禁里 = 轨会腐烂，靠自觉无解。

## 影响面

- **模型可见面**：零变化（`office` 在 2026-09-13 就已进面；本批不碰任何装配代码）。
- **用户可感知行为**：无。
- **门禁成本**：convergence job 时长约 ×2（两遍 vitest specs）；这是为「轨不再腐烂」付的价。
- **重录动作**：`CONVERGENCE_PRESET=minimal npm run record:convergence`（已执行，落 2 文件，
  单一动因、无夹带）。
- **验收**：`npm run verify:convergence`（双轨）exit 0。

---

# baseline change request — 工具缺陷三连修复：fs(read) 行号 opt-in + git_commit files 自动暂存 + git 域键语义描述（2026-09-07）

- **日期**: 2026-09-07
- **请求 Agent**: 工具缺陷修复执行 Agent（用户提交《工具缺陷 Bug 报告》三连：Bug 1 行号混入 payload / Bug 2 git commit 空错误 / Bug 3 diff 参数命名陷阱）
- **涉及快照**: `baseline/phase-0/tool-schemas.full.json`、`baseline/phase-0/tool-schemas.plan.json`、`baseline/preset-minimal/phase-0/` 对应物——同一动因的模型可见面字节漂移；`phase-1/tool-schemas.effective.json` 不在涉（六常驻工具面不含 fs/git）
- **状态**: **已批准**——用户 Bug 报告明文给出期望行为（「行号前缀……绝不混入 payload」「更优：commit 接受 files 参数时自动暂存这些文件」），即产品层明确决定改变模型可见行为（README 协议合法变更类型 ①）；本修复是该决定的直接落地。

## 变更内容

模型可见工具面三处：

1. **fs(read) 行号 opt-in（Bug 1 拍板）**：`read_file_content` 缺省返回文件原文
   （line_numbers=false——行号前缀是装饰，绝不默认混入 payload）；模型面新增可选键
   `lineNumbers: boolean`（true = cat -n 格式），`read` action 描述同步换代
   （"Returns text in cat -n format" → "Returns the raw file text … lineNumbers: true …"）。
   主入口与 code_execution 沙箱同走 read_file_content → 形状恒一致（报告者所测
   主入口差异实为观察误差，但行号税是真问题：全仓 12 处剥行号补丁随本批清除）。
2. **git_commit files 自动暂存（Bug 2 拍板）**：`git_commit` 模型面新增可选键
   `files`（逗号串，与 git_stage 同语法）；编排 = 给 files 先派发 stage（'.'/'all' →
   stage_all，否则逐文件），再 commit。`files` 键描述变为双源合并
   （"(action: stage); … (action: commit)"）；`git_commit` 描述换代。
3. **git 域描述键语义补全（Bug 3 DX）**：域描述追加
   "Key semantics: file = …; files = … commit accepts files too and auto-stages them…"。

## 为什么变

用户《工具缺陷 Bug 报告》三连的期望行为即产品拍板：

- **Bug 1**（沙箱内子串匹配被行号前缀系统性扑空）：「同一 fs 动作的两个入口返回
  逐字节一致的内容。行号前缀若是调试用途，应作为独立字段/选项提供，绝不混入 payload」。
  伴生修复：fs_cap `read` 在 line_numbers=false 时静默忽略 offset/limit（Rust 侧
  slice_lines 补齐）；内部 `kernelReadFile` 缺省同步翻转为原文（12 处剥行号死码清除，
  其中宽松正则 `^\s*\d+\t` 对原文行存在误剥风险——chat-session #11 先例）。
- **Bug 2**（git commit 未暂存时返回空错误）：实测根因 = `git commit -m` 无暂存时
  状态文本走 stdout、stderr 为空，run_git_sync 失败只回 stderr → `Err("")`。
  修复 = git 失败消息三级回退（stderr → stdout → exit code）；按用户偏好（「更优」）
  commit 接受 files 自动暂存，与其它写类工具参数语义对齐。
- **Bug 3**（diff 按 `path` 直觉传参报 missing 'file'）：zod `default "."` 从未在
  运行时生效（Rust 侧必填）。修复 = Rust `git_args` diff 双动作 `file` 缺省 "."
   （schema 文档 "omitted = all changes" 终于为真）；discard/blame 保持必填。

## 影响面

- **模型可见表面**：fs 域 `lineNumbers` 新键 + read 描述；git 域描述、`files` 键双源
  描述、`git_commit` 描述——tool-schemas.full / tool-schemas.plan 双 preset 漂移（本请求）。
- **行为面**：fs(read) payload 缺省原文（was cat -n）；git_commit(files) 先暂存后提交
  （was 静默忽略 files）；git diff 缺 file = 全仓 diff（was 报错）；git 失败消息可读
  （was 空错误）。
- **Rust 契约**：fs_cap 签名零改动（line_numbers 顶层参数既有）；git_cap 签名零改动
  （args 构建抽纯函数 git_args + git_failure_text，action 表不变）；rpc.rs 零改动。
- **消费面**：kernelReadFile 全部调用点（compaction/memory/board/goal/message-store/
  plan-tools/runtime/skills/default-loop）随缺省翻转得原文，剥行号补丁 12 处清除；
  tests/convergence specs 与 helpers 无 fs_cap 参数断言（rg 零命中）。
- **重录动作**：`npm run record:convergence`（standard）+ `CONVERGENCE_PRESET=minimal
  npm run record:convergence`（minimal），随后 `npm run verify:convergence` 必须 exit 0
  ——独立 record commit，不夹带 src 改动。

## 证据

- 实测复现（temp 仓库）：`git commit -m msg` 无暂存 → exit 1、stderr 空、状态文本
  在 stdout（Bug 2 根因实锤）；
- Rust 新测试：git_failure_text 三分支（utils.rs）+ git_args 行为锚（diff 缺省 "."
  / discard 必填 / required 参数响亮报错）+ slice_lines 直通与切片（confined_fs.rs）；
- TS 新测试：fs-seam ② 缺省 line_numbers:false + ②b lineNumbers opt-in 双向；
  coding-domain-plugins git_commit 编排三态（无 files / 'a,b' 逐文件 / '.' →
  stage_all）；cargo 440 全绿；vitest 全量见 record commit 前置验证。

---

# baseline change request — 图谱功能全量退役（兰台零引擎内置接线，2026-09-09）

- **日期**: 2026-09-09
- **请求 Agent**: 图谱退役执行 Agent（plan `.lantai/plans/plan-1788924433965-dmkj.md` v2，用户拍板全部决策点）
- **涉及快照**: `baseline/phase-0/tool-schemas.full.json`、`baseline/phase-0/tool-schemas.plan.json`、`baseline/phase-0/system-prompt.fixture.json`（standard + preset-minimal 各一份）
- **状态**: **已批准**——用户审查 plan v2 后逐点拍板（图谱全量退役 + search 向量边车随批退役 + constraints 能力口随批退役），产品层明确决定改变模型可见行为（README 协议合法变更类型 ①）；本请求是该决定的收敛对拍落地。

## 变更内容

兰台内置图谱功能全量退役（引擎回归纯 MCP 供外部消费）后，模型可见工具面与 system prompt 随之收缩：

1. **工具面缩容**：hologram 动态工具族（graph/ops/lsp 引擎侧 schema 在生成环境恒空集，不影响装配产物）整行退役——tool-schemas.full/plan 的 count 21→**18**（graph 域 27 动作、ops、dataflow 对、fs 域 constraints/write_constraints 两动作随批退役）；fs 域 description 与只读 action 表同步（constraints 两动作删）。
2. **system-prompt.fixture 换键**：三面夹具（withGraph/engineOff/noProject——graphData/引擎开关判面）随图谱退役收缩为**两面**（project/noProject——hasProject 独立判段），snapshot key 结构换代：`withGraph/engineOff` 键删除，新增 `project/projectLength/noProject/noProjectLength`（graph-snapshot 段与「图谱引擎已停用」行已删）。
3. **spec 结构断言同步**（非 baseline 文件，随实现批同 commit）：phase-3 config 消费面 24→22（删 graphData/graphContext）；phase-6 AgentConfig 冻结 30→28（同上）+ FORBIDDEN_COMPOSITION 删 5 个已删图谱专名；gate.mjs T0 计数 30→28。

## 为什么变

- 图谱「给人看的报告层」失真不可信 → 用户决定兰台内置图谱全量退役；引擎二进制保留，回归纯 MCP 供外部消费（外部 MCP 通道不在本快照内——装配面零引擎动态工具）。
- 兰台零引擎内置接线后 graphData/graphContext/引擎开关概念全灭，prompt 判面收缩为 hasProject 两面。

## 影响面

- **模型可见表面**：本请求列的三类快照漂移（工具面 count + fs 描述；fixture 键换代）。
- **行为面**：兰台 Agent 不再装配 hologram/graph/ops/lsp 动态工具、无 dataflow 对、fs 域无 constraints/write_constraints；system prompt 无 graph-snapshot 段与引擎停用行（两面装配）。
- **消费面**：composition 行表/prompt 段表/capability 表（graph-hooks→state-hooks）随实现批同步；convergence specs 与 helpers 已随实现批更新（phase-3/6 绿）。
- **重录动作**：`npm run record:convergence`（standard）+ `CONVERGENCE_PRESET=minimal npm run record:convergence`（minimal），随后 `npm run verify:convergence` 必须 exit 0——独立 record commit，不夹带 src 改动。

## 证据

- 实现批：非 convergence 全量 vitest 271 files / 2767 tests 绿 + build/tsc 绿 + biome 0/0 + check:tool-contract 绿（tool-contract 生成物同 commit）；
- 源整改后 convergence 结构门禁：phase-3 + phase-6 11/11 绿（28 字段全等）；phase-0 残留失败形态 = 纯 baseline 漂移（本请求对象），无源码级崩；
- 引擎侧不动（engine/ + 三 crate 零改动）；外部 MCP 通道本体不动。
