# workspace-flip — 工作区概念翻转（engine 中心 → Agent 中心）

> 立项：2026-08-22（从 paper-shell 待定 #9 剥离立独立工程）· 状态：**设计件待批准**
> 方向依据：`docs/adr/workspace-concept-ownership.md`（Accepted——软件用户面 = 纯粹的 Agent 软件，图谱内化为后端支柱，Workspace 翻转为 Agent 的家）
> 阅读顺序：① 本 README → ② `designs/D9-*.md`（施工设计件）→ ③ `interviews/W1-*.md`（粒度拍板记录）

## 这是什么工程

把「打开软件 → 选项目 → 等分析 → 看星图」翻转为「打开软件 → 会话列表 → 立刻对话 → 图谱后台预热」。纯结构工程，零视觉判断（视觉归 paper-shell V2/V4）。

与相邻工程的边界：

| 相邻工程 | 关系 |
|---|---|
| paper-shell（纸） | 本工程批 5 交付纸壳 preset——纸的装配通道；视觉/交互归纸 |
| composition-architecture S3 | 本工程批 5 完成即解锁 S3（「白纸执行层外化」完成）；但 S3 逐域迁移等纸真的需要 |
| paper-shell V5 判断半 | 共居期/观测台退役判据（R3 访谈）**不在本工程**——等「纸能住人」 |

## 拍板记录（interviews/）

| 轮 | 日期 | 决定 |
|---|---|---|
| W1（原 paper-shell R4） | 2026-08-22 | D-W1-1 纯会话优先 / D-W1-2 一会话一目录 / D-W1-3 图谱后台预热+优雅降级 / D-W1-4 与 V5 机制半同窗施工 |

（原访谈文件内 D-R4-x 编号保留原样——历史记录不改写，引用时按 D-R4-x 查。）

## 施工设计件

| 文档 | 状态 |
|---|---|
| `designs/D9-workspace-flip-v5-mechanism.md` | Draft 待批准——六批序列（W1 会话首页 React 化 → W2 零目录会话一等化 → W3 打开流两段化 → V5a bootShell 组合接线 → V5b 纸壳 preset + 主视图落点 → 文档回写） |

## 门禁

每批 commit 前全绿：build + vitest + biome（改动文件零新增）；触 agent 装配面加 verify:convergence；workspace.ts 是 INVARIANTS #12 高危区——每批前 preflight。
