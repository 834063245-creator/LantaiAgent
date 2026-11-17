# 交互原语收口（interaction primitive consolidation）

> 状态：**✅ Done（2026-11-17 立项 + 当日复核修订 + 当日五批全落地）**——结果与逐批 commit 见 §7。
> 触发：2026-11-17 用户自查四问——「重复到第三遍的是什么」，交出 9 份手势 / 4 份外点 / 808 行跟库较劲。
> 门禁：`src-ui/tests/interaction-primitive.test.ts`（形态对齐 `motion-contract.test.ts`）**已落地**。

## 0. 要裁什么（结论在前）

**结论：不是缺库，是「共性只收了一半」——三处抽象都做对了，收尾都停在 60%，且没有守卫阻止第四份长出来。**

| 病灶 | 实测（2026-11-17） | 已做对的那一半 | 停在哪 |
|---|---|---|---|
| **拖拽手势** | 9 份各自 `addEventListener('mousemove')` + 自行收尾；7 个纯 hook 合计 **1995 行**，另两处在组件内 | `lost-focus.ts`（37 行）抽出「失联即收」 | 只接了 **3/9**（`use-paper-drag` / `use-paper-strips` / `use-pin-strip-resize`），余 6 处窗外松手留 in-flight 死状态 |
| **外点关闭** | 4 处各写一份 `document mousedown` | `overlay.tsx` 收编了 9 处 Escape | 外点未收编——同一次「点空白」被拆成两个半场 |
| **动效时序** | 全库 **0 处** `transitionend` / `animationend`；退场窗与落纸窗全靠 `setTimeout` 估 | `tokens.css` 立了三档时长 + 两条曲线，`motion-contract.test.ts` 钉死跨语言镜像 | JS 侧仍在猜「动画什么时候结束」 |

第四类是**指针所有权**——它不是又一份重复，是上面三条共同的根：画布空白处 `preventDefault`（平移手势），
吃掉下游一切 `mousedown`；于是每个浮在它上面的东西都要自己打一次「怎么不被吃掉」的补丁。
自 2026-08 起同类病灶复发 **5 次**（`181fd753` 预览死锁 / 09-22 Escape 失联 / `24d9c168` 题签被抢焦点 /
`ModelSelector` 330 / 436 两处），**每次修的都只是当前那个组件**。

### 一句话判据

> 凡是「浮层关闭」或「手势收尾」要自己写 `document.addEventListener` 的，都是本线要收的东西。

### 复核补记（2026-11-17 开工前，对着源码逐条核过）

立项时的手表只点了**拖拽手势**这一族（9 份），但判据一旦写成上面那句话，覆盖面就比手表宽——
全库带 `mouse*/pointer*` 监听的**文件**实测 18 个，其中 3 个是纯 pointer 面（`TocStrip` /
`MinimapView` / `resize-zones`，本批的先验样本），**剩下 2 个既不在 9 份里、也不是浮层**：

| 漏账 | 在哪 | 性质 | 处置 |
|---|---|---|---|
| **拖选自动滚屏** | `use-paper-viewport.ts` L560-595（`mousedown` capture + `mousemove` + `mouseup` + `edge-scroll` 驱动） | 完整手势，但**不移动任何东西**：按在块文本上开始扩选，指针到边缘就滚。没有「窗外交付」语义（选区不跟指针出窗） | 进 **C5 例外表**，不并入 `useDragGesture`；批 E 白名单登记 |
| **边缘滚动卧倒** | `edge-scroll.ts` L361（`mousedown` capture → `disarm()`） | 不是手势，是**手势的中止信号**（按下即收）。它听 `mousedown` 是为了「先于拖拽域跑到」 | 同上，白名单登记 |

**后果**：若不补这条，批 E 的断言在批 C 落地当天就会把这两个文件判红，而白名单只能靠
「看到再补」长出来——**正好重演它自己批判的那条根因**（抽象是可选的，不是强制的）。

## 1. 为什么会有今天（三条根因）

1. **抽象是可选的，不是强制的**。`useLostFocusCancel` 抽出来了，但用不用随人——9 份里只有 3 份接上。
   抽出来 ≠ 用上去，中间缺一道门禁。
2. **收口只做「当下撞到的那一半」**。`overlay.tsx` 收 Escape 时，外点不在那次故障的现象里，于是留在原地；
   等到外点出问题，已经隔了三个批次，没人回头补。
3. **「跟手」的压力被画布单点承担**。`PaperPanel` 在空白处 `preventDefault` 是平移手势的正确实现，
   但它同时是**全局副作用**——它不知道上面还浮着谁。这条从第一天就埋着，只是每加一个浮层暴露一次。

## 2. 契约（四条新口径）

### 2.1 手势层：改用 Pointer Events + `setPointerCapture`

现状 9 份全部是 `mousedown` / `mousemove` / `mouseup`。**换成 Pointer Events 不是为了换名字，是换掉病灶本身**：

- `setPointerCapture` 之后，指针移出元素甚至移出窗口，`pointerup` **仍然会送到捕获者**——「窗外松手」从「要防的意外」变成「不会发生的事」；
- `pointercancel` 是浏览器免费给的失联信号（触控被系统接管、设备断开、窗口失焦），比手写 `blur` + `visibilitychange` + `mouseleave` 三连更短也更准；
- `lost-focus.ts` 保留为**兜底**（WebView2 边界，见 §3 批 C 的验证项），不再是主路径。

**⚠ 首批必验**：本机 WebView2 的 pointer capture 可靠性。`window-drag.ts` 已有先例证明 WebView2 会光栅化 `app-region`，
普通元素上的 capture 是否同样干净，必须先在两个手势上实测通过再铺开。

### 2.2 外点关闭：收进 `overlay.tsx`，与 Escape 同门

新增 `useOutsideClose(onClose, opts)`，与 `useDialogEscape` **同文件、同形状、同参数名**（`enabled` / `capture`）。

- 判据：`capture` 阶段监听（画布在冒泡阶段 `preventDefault`，冒泡收不到）；
- 「点自己算不算外」：`ref.contains(e.target)`——四处各自定义的差异在此统一；
- 不许 `preventDefault`（外点关闭不消费这次点击）。

**同批必须一起对齐的第五处**：`overlay.tsx` 自己的遮罩——`Overlay` 的 `onMouseDown`
（L96）就是一次「点空白 → 关闭」，只是它长在 JSX 上不是 `addEventListener`，所以既没进
立项的 4 处表、也不会被批 E 的源码断言抓到。**同一次「点空白」不能有两个半场**
（Escape 已收编、外点未收编）——批 A 把它一并收进 `useOutsideClose`（`ref` = 遮罩自身，
判据换成 `e.target === veil` 的等价形态），收编后 `Overlay` 与四处浮层走同一条路径。

### 2.3 指针所有权：浮层优先，画布殿后

确立一条裁决：**指针事件的归属按层高排序，高层未消费才落到画布。**

- 浮层 / 手势区在 capture 阶段先判定，命中即 `stopPropagation`（不 `preventDefault`）；
- 画布 `onCanvasMouseDown` 只在**没有任何浮层打开、没有手势在途**时才 `preventDefault`；
- 实现形态 = 模块级引用计数（`claimPointer` / `releasePointer`），不引库、不进 store（不进 zustand 避免无谓重渲染）。

### 2.4 动效时序：能听事件就听事件，听不到的才留超时

> **移用为通则**：`setTimeout()` 的毫秒数，只允许出现在「元素即将消失、没有事件可听」的位置。

- 新增 `useMotionEnd(el, { fallbackMs, onEnd })`：听 `transitionend` / `animationend`，`fallbackMs` 只作保险；
- 退场窗、落纸窗、淡出窗全部改事件驱动；
- 260ms 的镜像面缩小：**能听事件的，TS 侧不再保留常量**；`DockPanel.PANEL_LEAVE_MS`（卸载前等待，元素已无）与
  `boot-cover.BOOT_COVER_FADE_MS`（index.html 先于 tokens.css）两处保留，理由写在代码注释里。

## 3. 批次

### 批 A · 外点关闭收口 ✅ 可立即施工（0.5 人日）

- 新增 `useOutsideClose` 到 `app/overlay.tsx`；
- 收编 4 处：`CommandPalette`（L104）、`SessionSidebar`（L399，capture）、`ModelSelector`（L445）、`StatusLine`；
- **外加 `Overlay` 遮罩自己**（L96 的 `onMouseDown`，见 §2.2 尾注）——它是第五处，
  形状不同（`e.target === veil`）但语义同一，收编后全库「点空白关闭」只剩一条实现路径；
- 逐处对照原判据，差异（哪些算「外」）显式写进 opts，不许静默统一：

| 收编点 | `ref` | `enabled` | capture | 判「外」的口径 |
|---|---|---|---|---|
| `CommandPalette` | 面板 `boxRef` | `open` | 缺省（新 hook 默认 true） | `!box.contains(target)` |
| `SessionSidebar` | 栏根 `asideRef`（新挂） | `confirmingDeleteId !== null` | **true**（原样保留） | `!aside.contains(target)`（原判据是 `.closest('.ss-sidebar')`，语义等价） |
| `ModelSelector` | 容器 `containerRef` | `isOpen && compact` | 缺省 | `!container.contains(target)` |
| `StatusLine` | 根 `hostRef` | `logOpen` | 缺省 | `!host.contains(target)` |
| `Overlay` | 遮罩自身 | `open && veilClose` | 缺省 | `target === veil`（`refContains` 换三参形态，见 hook 签名） |

**风险**：低。只改变「谁来听」，不改变「听到之后做什么」。

### 批 B · 动效时序事件驱动 ✅ 可立即施工（1.5 人日）

| 改点 | 现状 | 改成 |
|---|---|---|
| `region-motion.ts` 退场窗 / 落纸窗 / 摊开窗 | `until = now + REGION_MOTION_MS` | 听元素 `transitionend`，窗长仅作兜底 |
| `use-paper-strips.ts` L172 `220` / L207 `400` | `setTimeout` 猜 lift 淡出、settle 落定 | 同上 |
| `use-paper-strips.ts` L645 `3000`（确认态） | 纯业务计时器 | **保留**（不是动画，是交互态超时） |
| `use-paper-focus.ts` `FOCUS_FLIGHT_MS` | rAF 自算进度 | **保留**（rAF 本身就是逐帧驱动，不是猜） |
| `DockPanel.PANEL_LEAVE_MS` / `boot-cover` | `setTimeout` | **保留**（卸载前等待 / index.html 早于 token） |

**收益**：调时长不再需要同步 5 处；改 `--m-sheet` 一处，全链跟随。

### 批 C · 手势层 + 指针所有权 ✅ 可施工（3–4 人日）

> **前置条件已满足**（2026-11-17 `6f225ee0`）：ComposerDock 拆解（1688 → 370 行）已提交，
> `composer-*.tsx` / `surface/use-composer-*.ts` 已落位。本批要动的 `use-paper-strips`(678) 与
> `use-composer-float`(306) **不在拆解范围内**（后者属 paper-shell），无撞车面。

**C1 · 先验后做**：在 `use-pin-strip-resize`（76 行，最小）上落一次 `setPointerCapture`，真机验 capture 是否可靠。不成立则退回 mouse events + `pointercancel` 兜底，方案不塌。

**C2 · 核心**：`useDragGesture` —— 一个核心 + 三个能力位：

| 能力位 | 供谁 |
|---|---|
| `threshold`（起手阈值） | `use-paper-drag` / `use-paper-strips` / `use-branch-drag` / `SpineRack` / `SessionSidebar` |
| `cancelOnLostFocus`（失联即收，不提交） | 全部（`lost-focus.ts` 降为兜底） |
| `clampToViewport`（窗外松手即定夺） | `use-composer-float` / `PluginWindowFrame` |
| 无能力位（纯跟手） | `use-region-move` / `use-pin-strip-resize` |

**C3 · 收编 9 处**，逐处回归。顺序按风险升序：`use-pin-strip-resize` → `use-region-move` → `PluginWindowFrame` →
`use-branch-drag` → `use-composer-float` → `SpineRack` → `SessionSidebar` → `use-paper-drag` → `use-paper-strips`（事故源头，最后动）。

**C4 · 指针所有权**（§2.3）：`PaperPanel.onCanvasMouseDown` 改为「有浮层或有手势则让路」。

**C5 · 四处待核实**（不计入 9 份）：`TocStrip.tsx`（已有 pointer events + `setPointerCapture`，734 行）/
`MinimapView.tsx`（纯 pointer，275 行）/**`use-paper-viewport.ts` 拖选自动滚屏**（L560-595）/
**`edge-scroll.ts` 按下即收**（L361）——先判定是否同类，是则并入，否则在门禁里登记为例外。
判定口径：**「手势」= 有拖拽位移语义 + 有提交/取消两态**；只有其中一半（纯跟随、纯中止信号、
纯自动滚屏）就不并入，免得 `useDragGesture` 被塞进它不负责的语义。

**为何 3–4 天而非 2–3**：拖拽是手感型，自动化测不出来，9 处都要真机走一遍；其中 `use-paper-strips` 678 行是
「抽纸条失灵」的事故现场，改动风险最高。

### 批 D · ModelSelector 卸库 ✅ 独立，随时可插（1.5–2 人日）

**现状**：808 行 TSX + 411 行 CSS + 4 个包（`@react-aria/combobox` / `@react-aria/listbox` / `@react-stately/combobox` /
`react-stately`），其中 30 余处注释在解释「为什么不能按库的默认写」。

**目标**：自写轻量 listbox（约 150–200 行 + CSS 收敛）。必须保留的行为：键盘上下/Esc/输入过滤/外点关闭/滚动跟随/compact 模式。

**收益**：删 4 个包、约 1000 行、30 条对抗注释——**这 30 条注释是每次改动的门票钱**，删掉即省。

**风险**：它是「能跑的」，换回自写有回归面。因此独立成批、不与其他批混提交，`ModelSelector` 的现有测试是唯一判据。

### 批 E · 守卫（随批 C 落地，0.5 人日）

新增 `tests/interaction-primitive.test.ts`，形态对齐 `motion-contract.test.ts`（源码断言 + 白名单）：

| # | 断言 | 登记表（白名单） |
|---|---|---|
| E1 | `document`/`window` 上的 `mousedown` / `mouseup` / `mousemove` / `pointerdown` / `pointerup` / `pointermove` **监听器注册点**只许出现在登记表内的文件 | `overlay.tsx`（`useOutsideClose` / `useDialogEscape`）/ `use-drag-gesture.ts` / `window-drag.ts`（OS 标题栏，另一范畴）/ `resize-zones.ts` / `TocStrip.tsx` / `MinimapView.tsx` / `use-paper-viewport.ts`（拖选自动滚屏）/ `edge-scroll.ts`（按下即收）/ `lost-focus.ts`（兜底） |
| E2 | 「点空白 → 关闭」只许出自 `overlay.tsx`：其余文件不得出现 `document.addEventListener('mousedown'|'pointerdown')`**且**同一文件内同时有 `contains(` | 无（收编完成的终态断言，收紧于 E1 之上） |
| E3 | `setTimeout` 的毫秒字面量只许出现在已登记文件 | `DockPanel`（`PANEL_LEAVE_MS`）/ `boot-cover`（早于 tokens.css）/ `use-paper-strips`（3000 业务计时）/ `motion-bench` 一族（测试台架） |

> **E1 为什么按文件登记而不是按调用点语义**：「这是不是外点关闭」静态判不出来（同一个
> `document.addEventListener('mousedown')` 既可能是外点关闭，也可能是`use-paper-strips` 的
> 起手面登记）。**能机械判定的只有「注册点在哪」**——登记表把「新增一处监听」变成一次
> **显式决定**（加行 = 在 PR 里被看见），而不是一道猜谜题。E2 才是语义闸，它只在 E1 的
> 小集合上做一次 grep 组合判断，误报面被压到最小。

> **没有批 E，批 C 会在半年后长出第 10 份。** 这是本线唯一不能省的一批。

## 4. 不做什么（以及为什么）

| 不引入 | 理由 |
|---|---|
| `framer-motion` / `react-spring` | 本仓的动效是「纸的物理」——硬边、短促、带停顿（`hitstop.ts` 是故意的）。spring 曲线不对味；且 §0 的四个病灶没有一个是「缺动画引擎」。 |
| `@use-gesture/react` / `dnd-kit` | 手势层的价值在「失联即收 + 指针裁决」，这两个库都不管；引进来等于多一层包装再写同样的补丁。 |
| Radix / Base UI / 成品组件库 | 纸壳视觉为全站自绘，成品库的样式是纯负债。`ModelSelector` 已提供反证：买来的 808 行里有 30 条对抗注释。 |
| 重写纸壳视觉体系 | 与本线无关。 |

## 5. 验收

| 批 | 判据 |
|---|---|
| A | 四处浮层逐个打开 → 点空白 → 关闭；点自身 → 不关闭；浮层内点击 → 不关闭 |
| B | `scripts/motion-filmstrip.cjs` 逐帧检真机；`motion-contract` 全绿；改 `--m-sheet` 一处 → 全链跟随 |
| C | 9 处逐一手势回归（起手/跟手/松手/窗外交付/失联取消）；`paper-interaction-handoff.test.ts` 全绿；指针裁决：浮层打开时画布不平移 |
| D | `ModelSelector` 现有测试全绿；键盘导航 / Esc / 外点 / 输入过滤 / 滚动跟随 真机通过 |
| E | 新门禁绿；故意写一处违规验证会红 |

**统一门禁**：`npm run build` + `npx vitest run` + `npx biome ci .`（0/0）+ `npm run doc-check`。

## 7. 结果（2026-11-17 收口）

### 逐批落地

| 批 | commit | 结果 |
|---|---|---|
| 复核修订 | 见本文件 §6 | 补例外清单、补 Overlay 遮罩第五处、批 E 断言改为三条可机械判定 |
| A 外点关闭 | `6ae0d2dc` | `useOutsideClose` 落地，5 处收编（含 Overlay 遮罩）；+6 例 hook 语义 |
| A 连带账 | `675e30e2` | 宿主面基线重生成（指纹 fc715abd）+ host-modules 体量登记 |
| B 动效时序 | `1812d7c0` | `motion-end.ts` 落地；退场/落纸/落定三窗改听事件；+9 例 |
| C1+C2 手势核心 | `44737c23` | `useDragGesture`（阈值 / 失联即收 / Esc / clamp / captured）+8 例 |
| C3 收编 1-2 | `7a725a5f` `84bb37d3` | 立枝（判据换 `elementFromPoint`）、宽度手调（先验样本）+5 例 |
| C3 收编 3-9 | `85f2cd9a` `788f37f8` `049970c6` `e2e6807d` `19bff5b6` `84c33455` | 流区、浮窗、创作坞、书脊、侧栏、拖块/拖纸条/眉批/架上签条 |
| C4 指针所有权 | `84c33455` + `d7fe99be` | `pointer-claims.ts`；画布认领、手势让路 |
| C5 例外判定 | `9aeeb04f` | 小地图**并入**（两态齐）；TocStrip / 拖选滚屏 / edge-scroll / resize-zones 登记为例外 |
| D 卸库 | `436d99a1` + `82558c90` | ModelSelector 802 → 777 行，`@react-aria/*` 4 包退出依赖 |
| E 守卫 | `9ace5591` | `interaction-primitive.test.ts` 6 例（E1/E1b/E2/E3 + 反证） |

### 数字（实测）

- **手势**：9 份 → 1 份核心。全库 `addEventListener('mousemove'|'mouseup'|'mousedown')`
  从 18 个文件 / 19 处 → **0 处**（只剩手势核心与 8 条登记例外，全部走 pointer 事件）。
- **外点关闭**：4 处手写 + 1 处 JSX → 1 处（`overlay.tsx`）。E2 守卫钉死。
- **动效时序**：`transitionend`/`animationend` 从 0 处 → 3 个窗全部事件驱动
  （退场 / 落纸落墨 / 落定），`setTimeout` 毫秒字面量只在 6 个登记文件。
- **ModelSelector**：808 行 + 4 包 + 30 条对抗注释 → 777 行 + 0 包 + 0 条。

### 与预估的偏差

- **批 C 的「两处待核实」变成四处**（复核补记），其中一处（小地图）判为并入而非例外。
- **手势核心多长出两个能力位**：`cancelOnEscape`（原本各域各挂一条 window keydown）
  与 `DragState.captured`（捕获面下 `e.target` 恒为捕获元素，落点判据要靠它选面）。
- **批 D 不是纯本地改动**：`ModelSelector` 之外还牵连名册 `shared` 登记（批 C 让
  canvas-nav / paper-minimap 的模块图伸进了手势核心）。

## 6. 修订记录

### 2026-11-17 开工前复核（三处补 + 一处收紧）

复核方式：对着源码把 §0 的每一个数字与位置重新核了一遍（`grep` + 行号），再按判据反向扫
全库**没被手表收进来**的同类。结论：**手表里的取证全部属实**（9 份手势行数逐一对上，
第 7 个纯 hook 是 `PluginWindowFrame.tsx` 153 行；`useLostFocusCancel` 恰 3 处接线；
`transitionend`/`animationend` 全库 0 处），改的是**覆盖面**不是结论。

1. **补例外清单**（§0 复核补记 + C5 扩两处）：`use-paper-viewport` 拖选自动滚屏、
   `edge-scroll` 按下即收——两者都在 §0 判据的覆盖面内却不在 9 份手表里，进 C5 判定 + E1 登记表。
2. **补 overlay 遮罩**（§2.2 尾注 + 批 A 表）：`Overlay` 自己的「点空白」是第五处外点关闭，
   JSX 形态所以既没被立项的 4 处表点到、也不会被源码断言抓到。
3. **收紧批 E**（§3 批 E）：原三条断言里「除 X 外不得 `addEventListener('mousedown')` 做外点关闭」
   静态判不出来（`use-paper-strips` 的 mousedown 是起手面登记，不是外点），改成
   **E1 按文件登记注册点 + E2 语义组合闸 + E3 超时字面量**三条可机械判定的断言。
4. **补 C5 判定口径**：「手势」= 有拖拽位移语义 + 有提交/取消两态；只有一半的不并入，
   免得 `useDragGesture` 被塞进自动滚屏、中止信号这类它不负责的语义。

## 附 · 取证

| 项 | 实测 |
|---|---|
| 手势 9 份 | 7 个纯 hook 合计 **1995 行**（463+678+76+158+161+306+153）；另两处在组件内：`SpineRack` 543 / `SessionSidebar` 1552（整文件行数，拖行只占其中一段） |
| `useLostFocusCancel` 接入 | 3 处（`use-paper-drag` L305 / `use-paper-strips` L615 / `use-pin-strip-resize` L67） |
| `transitionend` / `animationend` | 全库 **0 处**（`grep -rn` 空结果） |
| 外点关闭重复 | 4 处（`CommandPalette` L104 / `SessionSidebar` L399 / `ModelSelector` L445 / `StatusLine`） |
| `ModelSelector` | 808 行 TSX + 411 行 CSS + 4 个包 |
| 画布吃指针 | `PaperPanel.tsx` L262 `onCanvasMouseDown`、L230 `preventDefault` |
| 同类复发 | 5 次（`181fd753` / 2026-09-22 Escape / `24d9c168` / `ModelSelector` L330 / L436） |
