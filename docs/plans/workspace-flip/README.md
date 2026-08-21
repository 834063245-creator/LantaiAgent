# workspace-flip — 工作区概念翻转（engine 中心 → Agent 中心）

> 立项：2026-08-22（从 paper-shell 待定 #9 剥离立独立工程）· 状态：**Done — 批 1-5 竣工（2026-08-22，五 commit：`bbfcbe85` 会话首页 / `cbf2d657` 零目录会话 / `c6606ea3` 打开流两段化 / `b78b4ffc` bootShell 接线 / `02836b79` 纸壳 preset）**
> 方向依据：`docs/adr/workspace-concept-ownership.md`（Accepted——软件用户面 = 纯粹的 Agent 软件，图谱内化为后端支柱，Workspace 翻转为 Agent 的家）
> 阅读顺序：① 本 README → ② `designs/D9-*.md`（施工设计件）→ ③ `interviews/W1-*.md`（粒度拍板记录）

## 这是什么工程

把「打开软件 → 选项目 → 等分析 → 看星图」翻转为「打开软件 → 会话列表 → 立刻对话 → 图谱后台预热」。纯结构工程，零视觉判断（视觉归 paper-shell V2/V4）。

与相邻工程的边界：

| 相邻工程 | 关系 |
|---|---|
| paper-shell（纸） | 本工程批 5 交付纸壳 preset——纸的装配通道；视觉/交互归纸 |
| composition-architecture S3 | 本工程批 5 完成即解锁 S3（「白纸执行层外化」完成）；但 S3 逐域迁移等纸真的需要 |
| paper-shell V5 判断半 | ~~共居期/观测台退役判据（R3 访谈）**不在本工程**——等「纸能住人」~~ **已作废（2026-08-22 深夜）：V5 提前拍板摘除旧观测台前端，拆除不等判据**（原话见 paper-shell/taste-ledger 同日条目） |

## 拍板记录（interviews/）

| 轮 | 日期 | 决定 |
|---|---|---|
| W1（原 paper-shell R4） | 2026-08-22 | D-W1-1 纯会话优先 / D-W1-2 一会话一目录 / D-W1-3 图谱后台预热+优雅降级 / D-W1-4 与 V5 机制半同窗施工 |

（原访谈文件内 D-R4-x 编号保留原样——历史记录不改写，引用时按 D-R4-x 查。）

## 施工设计件

| 文档 | 状态 |
|---|---|
| `designs/D9-workspace-flip-v5-mechanism.md` | **已批准并竣工**（2026-08-22 用户批准 + agent 复审两处修正后施工）——六批序列全落地 |

## 竣工记录（2026-08-22）

| 批 | commit | 交付 |
|---|---|---|
| 1 会话首页 React 化 | `bbfcbe85` | SessionsHome（最近会话 + 双入口）；view home\|graph 迁移；静态 welcome DOM 退役；user_sessions_list/get_user_sessions_dir RPC（毒化容忍五重护栏） |
| 2 零目录会话一等化 | `cbf2d657` | sessionsDir('') 路由用户级目录（冻结文件 +33 行单 seam）；ensureUserSessionsDir 装配点接线；通用会话可持久化/续开 |
| 3 打开流两段化 | `c6606ea3` | Workspace.open 急段秒回（analyze 拿 meta 即返回）+ 缓段后台拉页（_active 守卫）；_graphWarming 状态 + 诚实文案；T0 结构钉 4 例 |
| 4 bootShell 组合接线 | `b78b4ffc` | 行表真源 = composition-store.resolved.shell（时序悖论修正：接线在 bootShell 内部读 store）；preset/patch 禁壳行涟漪首次生效 |
| 5 纸壳 preset + 落点 | `02836b79` | 内置 preset 表加 paper（保守空 patch）；selected=paper → boot 直落纸面板；**S3 解锁条件满足** |

遗留（如实）：批 3 行为边界——预热期内创建的会话缺 graph 工具（会话工厂在创建时点读 graphData，预热完成后新会话自动获得）；纸壳 preset 未裁壳行（原等 V5 判断半产品决策——**2026-08-22 深夜 V5 提前拍板，拆除开工后随拆随裁**）；~~R3 共居判据（paper-shell 保留）~~ 已作废（拆除不等判据）。

## 门禁

每批 commit 前全绿：build + vitest + biome（改动文件零新增）；触 agent 装配面加 verify:convergence；workspace.ts 是 INVARIANTS #12 高危区——每批前 preflight。
