# paper-panel-split — PaperPanel 巨型组件机械拆解

> 立项：2026-09-06。用户拍板原文：「必须要拆，等到拆不动的时候再拆就晚了，到那个时候整个画布就完蛋了」。
> 性质：**纯行为保持重构**（机械批）——零行为变更、零测试断言变更，只动代码物理位置与装配方式。
> 状态：**竣工（2026-09-06 单 commit 落地，门禁全绿；真机验收一项待用户跑，见 §6）**。

## 0. 病灶（2026-09-06 审计实测）

- `PaperPanel.tsx` 3253 行 / 148KB，全仓最大单文件；75 个 commit 在 08-30 → 09-06 七天内砸入。
- `PaperPanel()` 组件函数体 **2692 行**（561→3253），内含 **38 useCallback + 15 useMemo + 41 useEffect + 15 useRef ≈ 109 个 hook**；JSX 仅尾部 ~430 行，其余 ~2250 行全是钩子逻辑。
- 长因（结构性，非某人之过）：每窗口一批的增量 diff 纪律 + 全部画布状态（视图/拖拽/钉住/纸条/小地图/折叠/缓存/收敛计时器）互相引用向一处汇聚 + 插件化迁移只搬走 MinimapView 零头。每批都选了「往函数尾追加一个 useCallback」的阻力最小路径。
- 修过的时序竞态坟场（拆解中必须逐字节保真，见 §3 风险表）：视角竞态（首挂错位/尺寸抢夺）、#185 嵌套上限（平移 rAF 合并）、锚点守恒单 owner、飞行调度互斥、R1 真位置守卫、R2 冷启动聚焦兜底。

## 1. 设计（一条主线，无备选）

**形态**：paper-shell 目录内按域拆出自定义 hook 文件（kebab-case.ts，`use-*.ts`），PaperPanel.tsx 保留为装配根（共享 ref 载体 + 拖拽渲染态 + context 组装 + JSX + BlockView/DeskShelf 子组件）。

**三律**：
1. **显式穿参**——hook 间一切依赖经参数线程传递，禁共享可变模块态（同 R7 归因纪律）；跨域晚绑定只用组件级 `useRef` 载体（`regionsRef`/`viewRef`/`focusRafRef`/`focusFlightRef`——仓内既有范式，`activateRegionRef` 同族）。
2. **挂载序保真**——effect 执行序 = hook 调用序，三对硬约束：①placement effect 先于 viewport 的重挂清除 effect（R2 兜底要看到落位后的 spread）；②sessionsMirror 的 setActiveRegion 镜像先于重挂清除 effect（兜底目标选活跃卷）；③canvas 尺寸 RO effect 先于世界点守恒 effect（首测自洽链）。域内 effect 相对序原样搬运。
3. **产物链零感知**——paper-shell 是 esbuild 构建产物域：新文件被 entry import 即自动入包，项目内依赖继续走 './host' 桥（faceDeps 键集从构建产物动态提取，拆解不增减宿主键面）；manifest/roster/factory-products/first-party-manifest 全零改动。

**域切分与文件**（15 个 hook 文件 + 装配根）：

| 文件 | 域 | 搬入内容（现行号段） |
|---|---|---|
| `use-paper-sessions.ts` | 会话/画布镜像 | sess 订阅、regionMsgs 快照+修剪、setActiveRegion 镜像、canvasState 读面、paperTick 落盘订阅（562-666） |
| `use-region-placement.ts` | 新卷落位 | 最近空位落位 effect（708-735）——独立文件因挂载序必须先于 viewport |
| `use-paper-viewport.ts` | 视口 | view/canvasSize 订阅、token 注入、LOD、重栅格化、R2 持久化、尺寸 RO、世界点守恒、重挂清除、wheel 缩放、Home、平移 rAF 合并（739-1049 + 1698-1813） |
| `use-paper-focus.ts` | 视角飞行 | flyToPoint/flyToRegion/glideViewTo、pendingFocus、补飞、飞行互斥（1476-1590）——晚于 regions（补飞 effect 依赖 regions 值） |
| `use-fold-state.ts` | 折叠 | foldOv 覆盖表 + 四回调（668-695） |
| `use-block-measure.ts` | 实测回写桥 | measureTick/fonts、blockRootRef callback ref、converge 去抖、observed 订阅（903-966） |
| `use-running-sessions.ts` | 运行态 | subscribeExecAll 运行集（2728-2766） |
| `use-region-move.ts` | 流区移位 | 边缘拖动 + 四角缩放 + move/up 全局监听（977-1049 + 2135-2191） |
| `use-paper-regions.ts` | 布局核心 | regions memo（1118-1402）、pinsMap/sidecarOutOf/adaptBlocks、minimapGeo、openBlockIds/orphanPins/orphanInkBlocks/deadOrphanPinIds、visibleRegionIds、sameKey/STUB_EMPTIES/RegionCoreCacheEntry/translate·measure·ink 缓存（1051-1475 + 2706-2719） |
| `use-block-ops.ts` | 消息操作 | BlockOp 类型、messageCopyText、msgOpsFor、opsByBlock（184-204 + 1592-1697） |
| `use-paper-drag.ts` | 拖块/钉住 | 拖拽手势 effect、commitPinned、onUnpin/眉批恢复/眉批撕出、pinHint（1814-1969 + 1998-2021 + 2603 前置态 + 2649-2692） |
| `use-pin-strip-resize.ts` | 宽度手调 | resize ref/preview/move-up（2603-2648） |
| `use-paper-strips.ts` | 纸条/选区 | lift 遮罩、A 拖拽路径、selectionchange 浮钮、划词朱线、纸条拖动/两击销毁、spawnStrip、fabPos/selInkArt（2264-2602 + 2810-2820） |
| `use-region-activation.ts` | 激活 | activateRegion（显式激活唯一出口；2026-09-10 拍板：settle 三道闸/adopt/manualGuard/自动选中 tick 随浏览跟随退役拆除） |
| `use-jump-keys.ts` | 键盘走卷 | Alt+方向键（2022-2094） |
| `use-minimap-bounds.ts` | 小地图包围盒 | minimapContent 复合键缓存（2192-2262） |

组件根保留：5 个拖拽渲染态（draggingId/dragPos/dragSource/bandSessionId/settleId——regions memo 与拖拽/纸条两域共读共写，装配根持有最诚实）、共享 ref 载体、dockContext/regionContext 组装、composer 高度/overlay tick、dragBandCenter/selInkArt 之外的胶水、全部 JSX、BlockView/ToolStatusChip/DeskShelf/KIND_*（asset-render 守护测试读 PaperPanel.tsx?raw 的文类签面）。

## 2. 测试面盘点（2026-09-06 实查）

| 测试 | 消费形态 | 拆解处置 |
|---|---|---|
| `perf-paper-pan.test.tsx` | **挂真实 PaperPanel 全链**（最强调官） | 零改动，必须全绿 |
| `paper-visual-decisions.test.ts` | 源码扫描 `PANEL_TSX`（21 处断言） | **扫描面唯一例外**：单文件读改 paper-shell 目录拼接（断言逐字不变，与 paper-interaction-handoff 的 readAllTs 既有范式对齐）——`instant: true/false`、PIN_HINT_KEY、groupWorkUnits/rhythmAssign/sealedMessageIdsOf/writingBlockIdOf、mergeSelectionLines/selInkPaths 等字面量随域迁入 hook 文件后由目录扫描覆盖 |
| `paper-interaction-handoff.test.ts` | 目录递归扫（readAllTs）+ 与 ComposerDock 的 OR 探针 | 零改动（hook 文件落同目录天然入扫） |
| `asset-render.test.ts` | `PaperPanel.tsx?raw` 读 KIND_ZH/KIND_EN | 零改动（BlockView+文类签留装配根） |
| `plugin-boundary.test.tsx` | PaperPanel.tsx 扫 PluginBoundary 标签 | 零改动（JSX 不动） |
| `paper-token-audit.test.ts` | PaperPanel.css 扫 token | 零改动（CSS 不动） |
| `paper-focus-coldstart.test.ts` / `paper-stream-rhythm.test.ts` | 纯函数镜像，不 import 组件 | 零改动 |

测试 diff 形状验收（2026-09-04 立规）：全部测试文件零改动，唯 paper-visual-decisions.test.ts 扫描面一行对齐（申报在 commit message）。

## 3. 风险表（时序坟场逐条保真清单）

| 雷 | 保真手段 |
|---|---|
| 首挂视角错位（守恒自洽链） | RO 尺寸 effect 与守恒 effect 同入 use-paper-viewport 且域内序不变 |
| 尺寸抢夺（世界点守恒） | 同上，守恒逻辑逐字节搬 |
| 平移 rAF 合并（#185） | flush/up/清 panningRef 语义原样 |
| 飞行互斥（focusFlight begin/end + raf cancel） | focusRafRef/focusFlightRef 组件级 ref 载体，viewport（wheel/mousedown 抢占）与 focus（飞行）双 hook 共享同一实例 |
| R1 真位置守卫（spread 无位不飞） | flyToRegion 原样 |
| 补飞 effect 依赖 regions 值 | use-paper-focus 晚于 use-paper-regions 调用 |
| R2 冷启动聚焦兜底 | use-region-placement 先于 use-paper-viewport；sessionsMirror 先于 viewport（activeRegion 镜像先落） |
| effect 依赖数组 | 全部逐字保留（穿参后引用语义不变） |
| 渲染期 ref 写（viewRef/regionsRef/activateRegionRef） | 原位置语义等价搬运 |

## 4. 批次（每批 = 抽取 + 接线 + 全量门禁绿 + 独立 commit）

- **C0**：本计划文档 + plans/README 索引行。
- **C1 叶域**：sessions/fold/measure/running/placement 五文件（无输入或单输入，风险最低）。
- **C2 视口域**：viewport + focus（含共享 ref 载体改造）。
- **C3 布局域**：region-move + regions + block-ops（最重一刀，regions memo 284 行整体搬）。
- **C4 交互域**：drag + resize + strips + activation + jump-keys + minimap-bounds + 测试扫描面对齐 + 本文落账。

> **实际施工（2026-09-06）**：缝位分析一次完成后，十六文件拆解 + 装配根换心 + 扫描面对齐
> 以**单 commit 一次落地**（比四段分批更利于「测试 diff 形状」验收——全量面一次性对拍）。
> tsc 首跑仅两处尾巴接线漏（ANCHOR import / inkCache prop），零逻辑返工。

门禁（每 commit）：`npx vitest run` 全量 + `npm run build`（tsc+esbuild 产物+faceDeps）+ `biome ci` 0/0（改动文件零新增，--write 前走预览副本纪律）。全量门禁顺序跑（并行互扰出假红，实测在案）。paper-shell 不在 agent/composition 域，convergence 不适用。

并行窗口纪律：工作区现有另一窗口在途 ~40 文件（provider/agent 域，含 convergence specs 修复与 catalog 重生成中），不碰不提；每批 staging 前重新 `git status --short` 核对改动面；全量失败集必须 ⊆ 在途窗口已记录债（event-catalog-doc / seam-contract-version 等）。

## 5. 终止条件

- PaperPanel.tsx ≤ ~1100 行（装配根 + JSX），组件函数体 ≤ ~650 行；
- 15 个 hook 文件全部就位且各有单一域职责；
- 全量 vitest / build / biome 0/0 三绿，测试 diff = 仅扫描面一行（§2）；
- 真机验收一项：画布平移/缩放/拖块钉住/抽纸条/小地图拖拽五手势无回归（用户跑；自动选中一项随 2026-09-10 拍板退役，移出清单）。

## 6. 施工落账

- **2026-09-06 竣工（单 commit）**：PaperPanel.tsx 3253 → **1019 行**（组件函数体 2692 → ~470 行装配 + 430 行 JSX）；16 个域 hook 文件就位（use-paper-sessions/-region-placement/-paper-viewport/-paper-focus/-fold-state/-block-measure/-running-sessions/-region-move/-paper-regions/-block-ops/-paper-drag/-pin-strip-resize/-paper-strips/-region-activation/-jump-keys/-minimap-bounds）。
- 验收实据：**JSX 尾（`return (` 起 431 行）与 HEAD 逐字节对拍——430 行一致，唯一差异 = 申报的 InkLayer `inkCacheRef.current`→`inkCache.current` 接线改**；tsc 首跑仅此两处尾巴漏接线，零逻辑返工。
- 行为考官：`tests/perf-paper-pan.test.tsx`（挂真实组件穿全层）拆解后全绿。
- 测试 diff 形状：全部测试零改动，唯 `paper-visual-decisions.test.ts` 扫描面一行对齐（PANEL_TSX 单文件读 → paper-shell 目录拼接，断言逐字不变；与 paper-interaction-handoff 的 readAllTs 既有范式对齐）——扫描面内的 `not.toContain` 负向断言随目录拼接语义反而更强。
- 装配根保留面：5 个拖拽渲染态（draggingId/dragPos/dragSource/bandSessionId/settleId）+ regionsRef 共享载体 + seenBlocksRef + context 组装 + composer 高度/overlay tick + BlockView/ToolStatusChip/DeskShelf/KIND_* 文类签（asset-render 守护测试读 PaperPanel.tsx?raw 面）。
- 产物链零改动实据：esbuild 产物构建绿（entry import 自动跟随打包）；faceDeps 键集动态提取不变；manifest/roster/factory-products/first-party-manifest 全程未动。
- 真机验收一项（用户跑）：画布六手势无回归——平移/缩放/拖块钉住/抽纸条/小地图拖拽 + 键盘跳卷显式激活（自动选中一项随 2026-09-10 拍板退役）。
- 终止条件中「组件函数体 ≤ ~650 行」实达 ~470 行（JSX 430 行计入后整文件 1019）。

### 6.1 接线事故与根治（2026-09-06 真机三连症状 → 修复 commit）

- **症状（用户真机报告）**：拖块钉住坏 / LOD 缩远墨迹坏 / 自动选中坏。
- **根因**：拆解首版 `use-paper-regions` 自建了第二个 `regionsRef`（计划写的是「装配根持有、穿参进 hook」，写 hook 时漏了穿参一步）——装配根手里的实例恒空数组，而 InkLayer（LOD 墨迹）/拖块带心判定/自动选中命中表/视角飞行/键盘走卷这些**晚绑定读方**全读的是装配根那个空 ref。render 面（regions 值传递）全绿、ref 读面全瞎——这正是 jsdom 行为考官（perf-paper-pan 只测平移渲染）测不到的缝。
- **修复**：`regionsRef` 单一 owner（装配根 `useRef` 持有）经穿参进 `usePaperRegions`（每帧 `regionsRef.current = regions`）；hook 删自建实例、不再回传（调用方自有绑定）。
- **回归测试（一颗雷一个 commit 配回归测试）**：`tests/paper-regionsref-wiring.test.tsx`，从用户操作序列新写、挂真实组件穿全层——① InkLayer 真卷墨迹（缩进 LOD 档后桩条 fillRect > 0）；② 自动选中（视口中心悬停他卷 400ms → 切活跃卷；**用例② 随 2026-09-10 浏览跟随退役移除，① 仍在**）。**红性实证**：注入事故形态（穿恒空 ref）双用例精确复现两症状（LOD 无墨 / 永不选中）——这颗雷如再犯，考官即红。
- **harness 坑在册（真组件测试时序纪律）**：jsdom 下 clientWidth=0 → RO effect 直写 `setCanvasSize(0,0)`（perf-paper-pan 同款，测试须挂载后直写覆盖）；重挂清除 effect 见 spread 非空会发 `requestFocus` → 240ms 视角飞行逐帧覆写测试视口——**预置 `restoreView` 可同时掐掉飞行与落锚两股噪声**（守恒首测跳过落锚 + 重挂清除走清 pending 分支）。
- 真机验收一项（用户跑）：画布六手势无回归——平移/缩放/拖块钉住/抽纸条/小地图拖拽 + 键盘跳卷显式激活（自动选中一项随 2026-09-10 拍板退役）。
