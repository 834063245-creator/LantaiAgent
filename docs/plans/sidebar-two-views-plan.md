# 案卷侧栏双视角（案卷 ⇄ 枝）——父卷/子卷展示重构

> 立项：2026-09-20（用户提「侧边栏对父卷/子卷的展示做的不够好」→ 走查 + 四案并排原型 →
> **用户拍板「丙 · 双视角」**）。
> 诊断、七条病灶（带代码行号 + 真机 CDP 读数）、四案几何对拍与照片：**`prototype/sidebar-tree-ab.NOTES.md`**
> （本件不复述证据，只写施工面）。原型页 `prototype/sidebar-tree-ab.html`，走查脚本
> `prototype/sidebar-tree-shot.mjs`。

## 0. 一句话

**把「时间序」与「血缘」拆成两个视角，各自纯粹**：案卷视图 = 纯时间序扁平列表（不缩进、不被建树
打断）+ 每行一枚 `↳N` 血缘记号；枝视图 = 森林（只列有枝的族、可折枝、引线折角承担血缘）。默认落
案卷视图（日常找卷的动线不变）。

## 1. 现状的病根（一句话版，证据见 NOTES）

分节先于建树 ⇒ 父与子分居两节时子行缩进归零（**你正在枝上干活时树恰好不成立**）；时间桶二次横切
树 ⇒ 父子可落两桶（父行还可能默认收起）；缩进是唯一的树语言且与每行那枚「枝」牌语义重复；
血缘的「另一端」（父卷名 / 分叉点 / 跳过去）在侧栏一无所呈；检索先过滤后建树 ⇒ 搜子卷名时父卷
消失；树序与时间序在同一列表里互相将就。

## 2. 形态（施工契约）

### 2.1 视角与切换
- 分段控件 `案卷 | 枝` 落在检索条与「＋ 另起一卷」之间（与既有 `.ss-views` 同语汇：宋体小字 +
  选中朱砂底线）。
- 状态持久化：`localStorage['lantai.sidebar.view']`（同 `WIDTH_KEY`/`FOLDS_KEY` 家族，
  坏值 → 默认 `case`）。
- **默认 = 案卷**（零漂移：老用户的日常动线不动）。
- 视角只影响**列表区**；书眉 / 检索 / 新建 / 批量条 / 宽度柄全部共用。

### 2.2 案卷视图（`view === 'case'`）
- 行集 = 合流序（`mergeSessionRows` 原样：摊开优先 + `savedAt` 倒序），分节 `摊开中 / 已合卷`
  + 时间桶**照旧**；**不缩进、不建树**（`depth` 恒 0）。
- 血缘 = 名后一枚「**枝**」牌（与书脊/卷首同一枚标，牌上带父卷号 `枝 15`；P5 真机反馈恢复，
  见 §7.1）。父卷不在场 ⇒ 牌转实朱砂边 + meta 注记 `父卷已删`（沿用 `orphan` 语义）。
- hover / 聚焦 / 点击那枚牌 ⇒ **血缘卡**：父卷名（在场时取自同一份行集，零 I/O）+ 父卷号 +
  「摊开父卷」+「知道了」（「跳到分叉节点」不做，见 §2.4 偏差①）。**热区 = 牌与卡同子树
  + 200ms 关延迟**（横穿 meta 行那一截的宽限；P5 真机反馈修，见 §7.1）。
- 检索：**保留命中行的祖先上下文行**（弱墨 + 「上下文」标），父子关系在检索态也不丢。

### 2.3 枝视图（`view === 'tree'`）
- 一级分组：**有一枝的卷**（族 = 根卷 + 整棵子树，按族内最新 `savedAt` 排序）+ 末组
  **独立卷（无枝）**（默认收起，组头显示计数）。
- 族内：`treeRows` 出 `depth` + 逐层「是否末子」（折角素材）；父行右端常态一枚
  `▾ N 枝` 汇总（点它折枝）、hover/聚焦让位给「改/合/删」（**一槽两租客**，槽宽不变）；
  折起的族出一行注记（`… 折起的 N 枝`）。
- 引线：轴走**行内左标记列**（勾选格 + 状态点同槽叠放，`.ss-mark` 16px），每级 16px；
  `├/└` 折角 + 竖线出血接得上；父行从其状态点垂一线到行底（`.ss-desc`），子行折角接住。
- 建树范围：**跨摊开/已合卷**（族不拆是「枝」这个词的前提）——枝视图内不再分节，
  摊开与否由状态点 + 墨阶表达。
- hover 任一行 ⇒ **整族**（同族全部行）纸深一档 + 引线转朱砂（删父卷连坐谁，一眼看出）。

### 2.4 连带（同批，同一病灶带）
| # | 项 | 判据 |
|---|---|---|
| 1 | 节点级折叠 | 父行可折（`▾ N 枝` 即折枝钮）；折叠态持久化进 `lantai.sidebar.folds`（键 `fam:<id>` / `solo`） |
| 2 | 键盘 | `←` = 折起本行 / 回到父行；`→` = 展开本行 / 进第一个子行（枝视图；案卷视图空操作**不吞键**） |
| 3 | 无障碍 | **本批只做**：折枝钮 `aria-expanded`、行 `aria-expanded`/`aria-current`、引线与勾选格 `aria-hidden`、血缘记号 `aria-label`。**`role=tree/treeitem` 缓办**——枝视图的族分组头与折枝注记是并列件，硬套 `role=tree` 结构不成立（要重排 DOM），另立小批 |
| 4 | 当前卷进场 | 切换当前卷后把该行滚进视野（`scrollIntoView({block:'nearest'})`；已在视野内则不动） |
| 5 | 检索祖先上下文 | 见 §2.2 末条（**同节内**补祖先，跨节不硬拉——节语义不被检索破坏） |
| 6 | 悬空血缘视觉 | 记号/行 `.orphan` 转朱砂 + 注记「父卷已删」（两视角同一处出，不重复写） |

**落地与原型的四处偏差**（原型是纸面，落地要认账）：
① 血缘卡**不做**「跳到分叉节点」——飞节点要纸面 region 几何（侧栏没有那份几何），画布引线才是它的承接面；
② 枝视图**不加**「合成示范 · 一父三枝」样板（那是原型的验收件，不是产品面）；
③ 案卷视图的血缘记号是**按钮**（可点开卡、可聚焦），不是原型里的纯文本 span；
④ `role=tree` 缓办（见上表 #3）。

## 3. 批次（每批独立可交付、每批门禁绿）

| 批 | 面 | 内容 | 验收判据 |
|---|---|---|---|
| **P1 纯函数** | `session-sidebar-model.ts` | `ancestorContexts`（检索保祖先）/ `familyForest`（族分组 + 族序）/ `treeRows` 补 `lastAt`（逐层末子旗标）+ `childCount`；`SidebarRow` 补 `parentLabel?`/`contextOnly?` | 纯函数单测（族序 / 独卷组 / 环守卫不吞行 / 祖先上下文 / 末子旗标） |
| **P2 案卷视图** | `SessionSidebar.tsx` + css | 分段控件 + 视角状态 + `↳N` 记号 + 血缘卡 + 检索祖先上下文 | 渲染测试：切视角 / 记号只在案卷视图出 / hover 卡内容与置灰项 / 检索出上下文行 |
| **P3 枝视图** | `SessionSidebar.tsx` + css | 森林渲染 + 引线（`.ss-guide`/`.ss-mark`/`.ss-desc`）+ `▾ N 枝` 一槽两租客 + 族高亮 + 节点级折叠 | 渲染测试：族不拆（跨摊开/已合卷）/ 折枝 / 独卷组 / 引线层数与 depth 对拍 / 折叠持久化 |
| **P4 连带** | 同上 | 键盘 `←/→`、`role=tree` 语义、当前卷进场 | 渲染测试：`←/→` 行为 / aria 属性 / 切换卷后 scrollIntoView 被调用 |

## 4. 规格变更声明（**必读**）

`tests/session-sidebar-tree.test.tsx` 现钉着两条**正是病灶本身**的行为：
① `'父不在本节 ⇒ 当根行（缩进归 0）'`；② `expect(rows[1].style.paddingLeft).toBe('24px')`。
本件**故意推翻**它们（案卷视图不缩进；枝视图族不拆 ⇒ 父子不分离），按仓库纪律：
**这不是回归，是显式规格变更**——同批改写测试，并在 commit message 写明「行为变了什么」。

## 5. 刻意不做

- **不做拖拽改父**（重挂血缘）：与连坐删除的后序不变式对账是另一件事，无用户需求。
- **不引入第三方树组件**：两行式注疏行 + 现有状态语汇，引线只有一套 CSS。
- **不在枝视图里保留时间分节/分桶**：时间信息降为行注记（`Nº · 块 · 相对时间`）与族序。
- **不改卷数据面**：本件纯 UI/模型层，不新增事件 kind、不动 `.ndjson`、不动 RPC。

## 6. 测试与门禁

- 新增/改写：`tests/session-sidebar-tree.test.tsx`（视角与树面）、`tests/session-sidebar-views.test.tsx`（新，双视角 + 血缘卡 + 检索上下文 + 键盘/aria）。
- 基线（动刀前已跑）：`npx vitest run tests/session-sidebar-*.test.tsx` → 见 §7 记录。
- 门禁：`npm run build` + `npx vitest run` + `npx biome ci .`（0/0）；未动 `agent/**` / `composition/**` ⇒ 不跑 convergence（若动则补跑双轨）。
- 真机走查：沿用 `prototype/sidebar-tree-shot.mjs` 的几何对拍（CDP 出数 + Chrome CLI 照片），落地后对拍「名区宽 / 截断数 / 引线层数」三项不劣于原型读数。

## 7. 施工记录

- 2026-09-20 基线（动刀前）：`cd src-ui && npx vitest run tests/session-sidebar-tree.test.tsx
  tests/session-sidebar-ux.test.tsx tests/session-sidebar-load.test.tsx
  tests/session-sidebar-projectpath.test.tsx --maxWorkers=2` → **4 文件 / 26 用例全绿，exit 0**（7.16s）。
- 2026-09-20 落地（P1-P4 同批，一次交付）：
  | 面 | 件 |
  |---|---|
  | 纯模型 | `session-sidebar-model.ts`：`SidebarRow` 补 `kids`/`lastAt`/`contextOnly`；`treeRows` 出 `lastAt`/`kids`（**环守卫照旧，绝不吞行**）；新增 `familyForest`（族 = 根 + 整棵子树，族序按族内最新 `savedAt`，独卷另组，**环里的行末尾补出**）、`withAncestorContext`（检索保祖先链，幂等）、`markOrphans`（案卷视图不建树也要那枚「父卷已删」，与 `treeRows` 共用一条判据） |
  | 组件 | `SessionSidebar.tsx`：视角状态 + 分段控件 + `VIEW_KEY` 持久化；案卷视图（扁平 + `↳N` 记号按钮 + 血缘卡 + 祖先上下文行）；枝视图（森林 + 引线折角 + `▾ N 枝` 一槽两租客 + 族高亮 + 折枝 + 独卷组）；`←/→` 键盘；当前卷自动进场 |
  | 样式 | `session-sidebar.css`：`.ss-views` / `.ss-lineage-mark` / `.ss-lineage-card` / `.ss-context-tag` / 引线族（`.ss-guide`/`.ss-mark`/`.ss-desc`）/ `.ss-kids` / `.ss-tail` / `.ss-fam` ——**整块落在文件末尾**（biome `noDescendingSpecificity` 要求特异性升序；放中部会带 5 条 warning，门禁是 0/0） |
  | 测试 | 新 `tests/session-sidebar-views-model.test.ts`（7 例：族/独卷/环不吞行/折角旗标/祖先链）；新 `tests/session-sidebar-views.test.tsx`（6 例：视角切换与持久化/坏值容错/血缘卡/悬空/检索上下文/`←→` 键盘）；改写 `tests/session-sidebar-tree.test.tsx` 两条渲染用例（**规格变更**，见 §4） |
- 2026-09-20 门禁：`npx biome ci .` **847 文件 0/0**；`npm run build`（tsc --noEmit + vite）✓；
  `npx vitest run` 全量——见本批 commit。

### 7.1 真机反馈修（P5，2026-09-20 当日）

真机验收报两条，都成立：

| # | 反馈 | 病灶 | 修法 |
|---|---|---|---|
| 1 | 「案卷这一页，所有分支卷还是应该有个明显的标识」 | 我把行内那枚「枝」牌换成了等宽弱墨 `↳15`——它**只有信息、没有存在感**，而且**断了「书脊 / 卷首眉行 / 侧栏」三处同一枚标的既有语言**（一屏一语言被我自己破了） | 恢复「枝」牌（与书脊 `.sr-branch-tag`、卷首眉行同一枚标）**并把父卷号并进牌内**（`枝 15`：牌说「是枝」，号说「自谁分出」）；`↳N` 退役（同一件事不留两枚标） |
| 2 | 「hover 出现的卡片，我鼠标只要一动就消失掉，热区断链？」 | **是 bug**：热区只在记号自己身上，卡却挂在行上（兄弟关系）⇒ 指针一离开记号立刻 `mouseleave` → 卡关；牌在名行、卡在行外，中间还横着 meta 行那一截非热区 | ① 牌与卡同属 `.ss-lineage` 子树（进**卡**不触发 `mouseleave`——enter/leave 认子树不认几何）；② 加 **200ms 关延迟**（横穿 meta 行那一截的宽限）；③ 卡 `top: calc(100% - 4px)` 上移贴住行底，缩短跨度。回归：`views.test.tsx` 两条（含 fake timers 的宽限用例 + 「移到卡上不消失」） |

顺带（同批）：`.ss-row` 的 `title` 补「枝（父卷 Nº N）」；悬空血缘的牌转实朱砂边；
`.ss-lineage-mark` 全套样式删除（不留残迹）。

**门禁**：`npx biome ci .` 849 文件 0/0；`npm run build` ✓（产物 `dist-plugins/builtin/hologram/canvas-nav/entry.js` 15:25 重建）；
定点 3 文件 30 用例 ✓；全量 `npx vitest run` **363 文件 / 3742 用例全绿，exit 0**（156.2s）。
