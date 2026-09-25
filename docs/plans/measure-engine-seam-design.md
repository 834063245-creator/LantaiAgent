# 批 9c-4 施工单 —— 测量引擎接缝化（`paper/type-tokens.ts` 806 行归家的唯一可行路径）

> 状态：**Proposed（2026-09-26 立，依据 = 账本 §6.5 的 9c-4 判定 + 本轮实测消费者表）**。
> 真值账本 = [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md)（红区最后两件之一）。
>
> 缘起：账本 §2.5 原判「`type-tokens.ts` 806 行随 paper-shell 包」，**机械切分判定不成立**
> （9c-4，证据见下）。本单给出真正解锁路径：**把测量引擎整体做成产物登记的实现**（批 6/7/8 同款
> 接缝），内核只留契约与读面。

## 1. 为什么机械切分不成立（9c-4 判定，已实测）

| 证据 | 数字 |
|---|---|
| 墨迹走查路径（`inkSourcesFor` → `markdownInkSources` → `measureMdBlocks`）引用的镜像常量 | 25 个里的 **23 个**（字体/行高/围栏/程文/节头全套）——引擎与墨迹走查是**同一台机器** |
| `type-tokens` 十张表在 `measure.ts` 里的出现次数 | 合计 **200+**（`ASSET_DERIVED` 单表 **117 次**） |
| `paper/ink.ts`（内核）依赖 `type-tokens`，而 `ink.ts` 被**三个产物**共享 | paper-shell · paper-minimap · compose-dock（经宿主桥） |

⇒ 把 token 表单独搬走 = 内核 `measure.ts` 与 `ink.ts` 都失去真源；把 `measure.ts` 单独搬走 = 内核
`ink.ts` / `minimap-core.ts` / `state/messages-store.ts` 失去测量面。**要么整体接缝化，要么不动。**

## 2. 本轮实测消费者表（决定「契约面留什么 / 实现进哪」的那一行）

| 件 | 行数 | 内核消费者（file: 取用符号） | 产物消费者 |
|---|---|---|---|
| `paper/measure.ts` | 2,016 | `paper/ink.ts`（`type InkSource` / `inkSourcesFor` / `measureSignature`）· `state/messages-store.ts`（`clearObservedHeightsForSession`） | paper-shell `dock-tether.ts`（`folioHeadWidthFor`）· 经宿主桥的 9 个测量读面（`measureBlockHeightCached` / `measureFolioHeadHeight` / `clearPaperMeasureCache` / `createBlockMeasureCache` / `needsObservedHeight` / `observedKeyOf` / `reportObservedBlockHeight` / `MARGINALIA_TOP` / …） |
| `paper/type-tokens.ts` | 807 | `paper/measure.ts`（十张表 + `PAPER_TYPE` 等）· 经宿主桥 `injectPaperTokens` | paper-shell `host.ts` |
| `paper/ink.ts` | 375 | `paper/minimap-core.ts`（`InkCache` / `inkForBlock`）· `paper/overlay-context.ts`（`InkCache`） | paper-shell `InkLayer.tsx`（`regionLabelTopWorld`）· paper-minimap / compose-dock 经桥（`inkColorOf` / `inkBarColorOf` / `LOD_TEXT_MIN_PX` / `INK_*`） |

**判据**：`ink.ts` 是**三产物共享的契约层**（§2.5 已裁），不能随任一包走 ⇒ 它必须留在内核，而它
需要的测量面（`inkSourcesFor` / `measureSignature`）**只能经接缝取用**——这就是本单的设计起点。

## 3. 设计（照抄批 6/7/8 的四件套，不发明新机制）

### 3.1 内核留什么

1. **契约面** `paper/measure-contract.ts`（新）：
   - 形状：`InkSource` · `MeasureSignature` · 测量输入形状（块/流区/卷首三类入口的最小面）；
   - **实现面** `MeasureImplementation`：`inkSourcesFor` · `measureSignature` · `measureBlocks` ·
     `measureMdBlocks` · `measureFolioHeadHeight` / `folioHeadWidthFor` · 观察高度回写四件
     （`needsObservedHeight` / `observedKeyOf` / `reportObservedBlockHeight` / `clearObservedHeightsForSession`）。
2. **登记表** `paper/measure-seam.ts`（新）：`register/active/require/clear` 四件 + **门面**
   （`inkSourcesFor()` / `measureSignature()` / `measureBlockHeightCached()` …），缺实现 =
   具名 fail-loud（`PAPER_MEASURE_UNAVAILABLE`）。
   - **观察高度账留内核**：`needsObservedHeight` / `observedKeyOf` / `reportObservedBlockHeight` /
     `clearObservedHeightsForSession` 是**跨模块记账面**（渲染期回写、会话切换清理、卷级复位），
     与记忆域的「事实保存授权」同理——状态留内核、引擎经门面读写。
3. **三个内核读点改门面**：`paper/ink.ts`（`inkSourcesFor` / `measureSignature`）·
   `paper/minimap-core.ts`（经 `ink.ts` 间接）· `state/messages-store.ts`（清态）。

### 3.2 产物侧（`paper-shell` 包）

- `git mv src/paper/measure.ts` → `plugins/builtin/paper-shell/measure.ts`；
  `git mv src/paper/type-tokens.ts` → `plugins/builtin/paper-shell/type-tokens.ts`（**整件随包，不再切**）。
- `paper-shell/index.ts` 的 `apply` 登记 `measureImplementation`（与 `dock-tether` / `InkLayer` 同包）。
- **名册标 `required: true`**：引擎缺席 = 纸面高度全崩（同 paper-renderers / sessions-home /
  ask-cards / agent-loop-service 之理），故「禁用」语义不适用。
- `host.ts` / `host.aliased.ts` 桥面按实测清单补齐（渲染面读的 9 个测量读面 + `injectPaperTokens`
  保留、`type-tokens` 直连改包内）。

### 3.3 契约面流程

`measure.ts` / `type-tokens.ts` **不在** `contract-version.ts` 的清单里（实测），但本批新增的内核
契约 + 登记表若被 `contract-version.ts` 采纳需走四步流程（版本 +1 + 文档行 + 指纹重生成）；默认
**不入册**（它们不是第三方可换的 seam，只是内核内部接缝），在 ledger 记明理由。

## 4. 子批切分与门禁

| 子批 | 内容 | 出口判据 |
|---|---|---|
| **9c-4a** | 契约面 + 登记表 + 门面；三个内核读点改门面；`paper/measure.ts` 仍在内核（先登记「内核默认实现」） | vitest 全绿 + convergence 双轨**零漂移** + biome 0/0；红区数字**不动**（还没搬） |
| **9c-4b** | `measure.ts` + `type-tokens.ts` 整件随包；`paper-shell` 标 `required`；宿主面键集按实测补齐并重生成基线 | `plugin-home:report` 红区 2 → **1 产物**（`type-tokens` 806 + `measure` 2,016 销账）；产物自包含校验过 |
| **9c-4c** | 测试面改指包内（`tests/paper-*.test.ts` 读 measure/type-tokens 的面）+ DOC/账本同 commit + 真机验收 | 重建 exe + CDP：纸面测高面活性（流区高度、卷首高度、墨迹走查）+ 启动零装载失败 |

每批门禁照旧：`npm run build` · `npx vitest run` · `npx biome ci .` · `npm run verify:convergence` ·
`npm run build:builtin-plugins` · `npm run gen:host-surface`（改宿主面时）+ 再跑产物构建 ·
`npm run doc-sync` + `npm run doc-check`；收尾重建 exe + CDP 探针 + 账本 §5/§6 重测登记。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 测高在渲染关键路径（每块每帧），接缝调用可能引入开销 | 门面只做**一次模块级解引用**（`_impl` 查表），无逐调用分配；9c-4c 真机用既有 perf 台（`tests/perf-paper-pan.test.tsx`）对比帧数与重画数 |
| convergence 双轨对拍含卷首/流区几何 | 搬运**逐字**不改语义（同 9h 系列），双轨零漂移是硬门禁；任何漂移 = 回退重做 |
| `paper-shell` 标 `required` 后不可禁用（用户感知） | 与 8b 先例一致（paper-renderers）；ledger §2.5 记明「引擎缺席 = 纸面高度全崩」的判据 |
| 大批测试直接读 `agent/paper/measure.ts` / `type-tokens.ts` | 9c-4c 统一改指包内路径（测试可 import 产物源码；内核→产物导入守卫只约束内核源码） |

## 6. 不做什么

- **不做 token 表的部分切分**（23/25 常量被墨迹路径共用，已实测；切了就是两份真源）。
- **不把 `ink.ts` / `minimap-core.ts` 搬进产物**（三产物共享的契约层，§2.5 已裁）。
- **不为「引擎缺失」造内核兜底实现**：`requireMeasureImplementation()` 缺实现 = 具名 fail-loud。
- **不动**与本批无关的在途文件（`.github/workflows/**` · `engine/**` · 他窗改动）。
