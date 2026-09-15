# 前端交互原语专项：浮层 / 焦点 / a11y 修复计划

> 状态：**已竣工（2026-08-29 全部档位 A+B+C 落地）** · 门禁：build ✓ / vitest 211 文件 1992 passed ✓ / biome 0/0 ✓
> 背景：UI/UX 专项迭代期启动；本文档是「组件库 0 使用」话题下对前端交互原语的实测诊断与修复路线。
> 一切结论基于真实代码扫描，非臆测。

> **新窗口开工须知（AGENTS.md 强制项）**：动代码前先读根目录 `CONVENTIONS.md`；涉 `src-ui/src/ui/**`、
> `src-ui/src/agent/**` 时读 `INVARIANTS.md`。前端门禁 = `npm run build` + `npx vitest run` +
> `npx biome ci .`；本机跑 npm 前先清 `NODE_ENV=production`（AGENTS.md §10 纪律）。行为变更写进 commit message。

## 0. 一句话

**你的前端不是「裸奔」，而是「自建了一套交互原语 + 三个真缺口」**：
P0 堆叠上下文脱节（token 意图 vs 现实）、P1 模态无背景 inert + 焦点陷阱/ARIA 半成品、P2 Escape 处理 9 处重复。
修复分档位 A（零依赖即做）/ B（产品决策需拍板）/ **C（已拍板：ModelSelector 手写 combobox 直接换 @react-aria/combobox）**。

## 1. 现状事实（扫描证据）

### 1.1 浮层组件清单（全部内联渲染，全库 0 处 `createPortal`）

| 浮层 | 挂载位置 | 定位 | z-index | 备注 |
|---|---|---|---|---|
| `CommandPalette` | **App 顶层**（App.tsx:31） | fixed | `--z-palette` 510 | ✅ 无 transform 祖先，健康 |
| `PromptShelfHost`（ask/权限卡） | **App 顶层**（App.tsx:32） | fixed | `--z-shelf` 500 | ✅ 健康 |
| `ConfirmDialog`（设置面板内） | `#settings-panel` 内（SettingsPanel.tsx:721、ProviderPage.tsx:354/368） | absolute | 60 | ⚠️ 锁在面板上下文 |
| `AddProviderSheet` | `#settings-panel` 内（ProviderPage.tsx:347） | absolute | 60 | ⚠️ 同上 |
| `ModelSelector` dropdown | ComposerDock 内 | absolute | 60 | ⚠️ 手写 combobox |
| `ComposerDock` pp-mode-dialog / thinking-menu | ComposerDock 内 | fixed/absolute | — | ⚠️ 面板内 |

### 1.2 已有的自建基础设施（不是没做）

- ✅ **焦点陷阱**：`src/app/dialog-focus.ts`（50 行：焦点移入 + Tab 环游 + 卸载归还），消费者 ConfirmDialog/AddProviderSheet/CommandPalette
- ✅ **z-index 单一事实源**：`src/app/tokens.css:58-69` 海拔层级 token（`--z-shelf:500 / --z-palette:510 / --z-dialog:520`）
- ✅ **Escape 防穿透**：各浮层自持 `document.addEventListener('keydown', ..., true)` capture 拦截
- ✅ **视觉统一**：`.cd-overlay` / `.cd-sheet` 纸面风格模态（provider-settings.css:663）

## 2. 问题清单（按严重度）

### P0｜堆叠上下文脱节：token 意图与实现不符

**证据链**：
- `#settings-panel` 带 `transform: translate(-50%,-50%)` + `overflow: hidden`（settings-panel.css:38/44）→ 形成**新的 containing block + stacking context**
- `ConfirmDialog`/`AddProviderSheet` **内联渲染在面板树内**（SettingsPanel.tsx:721）→ `.cd-overlay` 的 `position:absolute; inset:0`（provider-settings.css:664）以面板为包含块，**「全屏遮罩」实际只盖住面板区域**
- tokens.css:68 注释声明 `--z-dialog: 520`「模态确认框……盖过命令面板」——但真实实现 `z-index: 60` 且锁在面板上下文里，**永远压不过命令面板（510）和 ask 卡（500）**。

**影响**：不是视觉 bug（面板内模态工作正常），而是**文档意图与实现脱节** + **全局浮层永远盖不住设置面板内模态**（若产品要求「确认框必须盖过一切」则现实现不满足）。

### P1｜模态无背景 inert（a11y 缺口）

- `ConfirmDialog` 标了 `aria-modal="true"`，但**全库 grep 无一处 `inert`**（11 处 aria-hidden 全是装饰性图标）
- 后果：读屏器虚拟光标可穿透到背景设置项——模态不「模态」

### P1｜焦点陷阱 + ARIA 半成品

- `dialog-focus.ts` 的 `FOCUSABLE` 选择器**不含 `[contenteditable]`**；只拦 Tab，不处理背景 inert、不处理程序化 focus 逃逸
- `CommandPalette` 只有 `role="dialog"`，**无 listbox/option/aria-activedescendant** → 读屏听到「一坨按钮」而非可导航列表
- `ModelSelector` 手写 combobox/listbox 键盘导航（typeahead/activedescendant）——**a11y 最难件在手写，2026-08-29 用户拍板：直接替换（档位 C）**

### P2｜重复代码

- Escape 处理在 9+ 组件各自 `document.addEventListener('keydown', ..., true)`（CommandPalette/PromptShelf/ConfirmDialog/AddProviderSheet/StatusLine/ComposerDock/SessionSidebar/ModelSelector/PluginsPage…），行为不统一（有的 stopPropagation 有的没有）

## 3. 修复方案（分档位，可独立施工）

### 档位 A｜零依赖，现在就能做（半天量级）——推荐先做

1. **新建 `src/app/overlay.tsx`：Overlay 原语**
   - `createPortal(children, document.body)` + 统一 Escape 注册 + 背景 `inert` 开关
   - 收编 9 处重复 Escape 处理为单点 hook（`useDialogEscape(onClose, opts)`）
   - 现有浮层逐个迁入（CommandPalette/PromptShelfHost 已是顶层可先不动，先迁面板内三件 + ConfirmDialog/AddProviderSheet/ModelSelector）

2. **`dialog-focus.ts` 补强**
   - FOCUSABLE 加 `[contenteditable]`
   - 模态开启时背景设 `inert`（仅面板内模态场景可选）

3. **CommandPalette 补 ARIA**
   - `role="listbox"` + 子项 `role="option"` + `aria-activedescendant` + `aria-selected`

**门禁**：`npm run build` + `npx vitest run`（overlay 相关新增测试）+ `npx biome ci .`

### 档位 B｜产品决策（需用户拍板）

- **决策点**：设置面板内的 ConfirmDialog/AddProviderSheet 是「面板内模态」（现状，视觉统一）还是「全局模态」（须盖过命令面板/ask 卡）？
  - 若**全局模态** → 迁 portal 到 body + 换 fixed 遮罩 + 用 `--z-dialog: 520`
  - 若**面板内模态**（现状就是）→ 改掉 tokens.css 那段误导注释，明确「面板内模态是产品决策」
- 无论选哪个，都消除 P0 的文档/实现脱节

### 档位 C｜已拍板：替换 ModelSelector 手写 combobox（2026-08-29）

- **选型**：`@react-aria/combobox` 的 `useComboBox`（headless，样式 100% 保留 `--obs-*` token，零样式侵入）
  - 选它的理由：ModelSelector 是**可输入 combobox**（typeahead 搜索 + 自定义模型名提交 + 分组 + compact/展开双形态 + 元数据徽标，ModelSelector.tsx:337-506）——需要「输入列表外的自定义值」提交语义（ModelSelector.tsx:274-280），这是 **useComboBox 支持而 Radix Select 不支持**的关键（Radix Select 是纯选择件，不支持自定义输入值）
- **替换目标**：`src/app/panels/ModelSelector.tsx` 手写的 `handleKeyDown`（↑↓/Enter/Escape 导航，260-284 行）、`role="combobox"`/`listbox`/`option`/`aria-activedescendant` 手工接线（337-506 行）→ 换成 `useComboBox`（`inputValue`/`setInputValue` + `useListBox`/`useOption` 渲染列表）
- **保留**：分组表头（`ms-group-head`）、compact 触发按钮（ms-trigger）、元数据徽标（ModelRow 的 badges）、空态文案、目录获取失败态
- **注意**：`@react-aria` 依赖需加入 `package.json`；`npx biome check --write` 改动文件
- **门禁**：`npm run build` + `npx vitest run`（ModelSelector 相关测试若有则更新）+ `npx biome ci .`

## 4. 待审阅点（开工前请确认）

1. **档位 A 是否直接开做？**（推荐：是——零依赖、纯收益、贴合 UI/UX 迭代期）
2. **档位 B 的产品决策**：面板内模态 vs 全局模态？（二选一，决定 P0 修法）
3. ~~**档位 C**：ModelSelector combobox 是否纳入本次范围？~~ **✅ 已拍板：直接替换（2026-08-29）**

## 5. 验证门禁

- 前端构建：`cd src-ui && npm run build`
- 前端测试：`cd src-ui && npx vitest run`
- 格式：`cd src-ui && npx biome ci .`
- 涉及 Agent 运行时/组合层的改动跑 `npm run verify:convergence`（本次预计不涉及）
- 行为变更在 commit message 写明（对话框层级/焦点行为若有变化）

## 6. 不做的（防止范围蔓延）

- 不引入带样式组件库（AntD/MUI/shadcn）——与 `--obs-*` 设计语言冲突，选型正确
- 不整体替换现有浮层体系（自建 + token 化的方向是对的）
- 不碰 React 状态管理/路由/图表（超出交互原语范畴）

## 7. 竣工记录（2026-08-29 施工）

> 范围拍板：档位 A + B + C 全做；档位 B 选 **面板内模态**（视觉零变化，只修文档/实现脱节）。

### 档位 B（已落地）

- `src/app/tokens.css`：新增 `--z-panel-modal: 60` token；`--z-dialog: 520` 注释改为「全局模态保留位——当前无消费者；产品决策为面板内模态」；海拔注释补充面板内模态档位说明。
- `src/app/panels/dock-panels/provider-settings.css`：`.cd-overlay` 的魔法值 `z-index: 60` → `var(--z-panel-modal)`。

### 档位 A（已落地）

1. **新增 `src/app/overlay.tsx`**：`useDialogEscape(onClose, opts)` 单点 Escape hook（enabled/capture/blockPropagation 三开关）+ `Overlay` 原语（`open`/`onClose`/`portal`（createPortal 到 body）/`inertBackground`（遮罩兄弟子树 inert，关闭还原）/`veilClose` 遮罩点关）。
2. **迁入 Overlay**：`ConfirmDialog`、`AddProviderSheet`（面板内模态 `portal=false` + `inertBackground`）——各自删除手写 Escape effect 与 `.cd-overlay` 遮罩点关，交给原语；焦点环（mountDialogFocus）与 Enter 确认保留。`StatusLine` 日志气泡迁 `useDialogEscape`（非模态：capture=false/blockPropagation=false，行为逐字节不变）。
3. **`src/app/dialog-focus.ts`**：FOCUSABLE 补 `[contenteditable]:not([contenteditable="false"])`。
4. **`src/app/CommandPalette.tsx`**：`role="listbox"`（`#pal-listbox`）+ 每行 `role="option"` + `id="pal-opt-N"` + `aria-selected`；input 补 `role="combobox"` + `aria-controls` + `aria-activedescendant`；组头 `role="presentation"`。
5. **测试**：`tests/overlay-focus-a11y.test.tsx`（Overlay portal/inert/遮罩点关/Escape + useDialogEscape + dialog-focus contenteditable + CommandPalette ARIA，9 用例）。
6. 非模态/输入级 Escape（CommandPalette 输入、ComposerDock、SessionSidebar 等）保持原位——它们是 React 合成 onKeyDown 而非 document 监听器，强制收编会改行为，不在本次范围。

### 档位 C（已落地：ModelSelector → @react-aria/combobox）

- **依赖**：`@react-aria/combobox` / `@react-aria/listbox` / `@react-aria/i18n` / `@react-stately/combobox` / `react-stately`（^3.49.0，`Item` 集合构建器），React 19 peer 兼容。
- **`src/app/panels/ModelSelector.tsx` 重写**：手写 `handleKeyDown`（↑↓/Enter/Escape）+ 手工 `role=combobox/listbox/option/aria-activedescendant` 全部退役 → `useComboBoxState`（items 受控 = 已过滤 results，`allowsCustomValue` 自定义值提交语义）+ `useComboBox`（inputProps 接管键盘/ARIA）+ `useListBox`/`useOption`（列表渲染）。
- **保留（逐项核对）**：`.ms-trigger` compact 触发按钮、`.ms-group-head` 分组表头（含 noKey/fetch/fail 徽标）、ModelRow 元数据徽标、空态文案、目录获取失败态、same-model guard、streaming guard。
- **行为对齐**：`selectedKey: ''` 空值哨兵保住「空选中 + 输入自定义名 + Enter/blur 提交」的旧语义（react-aria 默认空 displayValue 不回调 onSelectionChange(null)）；Escape 拦截覆盖 react-aria 默认 revert（取消不提交）；打开自动聚焦输入（combobox 键盘流）；ARIA 焦点自动落当前选中项。
- **测试**：`tests/model-selector-compact.test.tsx` 原有 12 用例全保 + 新增键盘导航（aria-activedescendant 跟随）/Enter 选中/自定义值提交/Escape 不提交 4 用例（16 全绿）。
- **测试环境**：`tests/setup.ts` 补 `CSS.escape` 最小 polyfill（jsdom 缺失，react-aria ListKeyboardDelegate 依赖）。

### 门禁（2026-08-29 实测）

- `npm run build`：tsc --noEmit + vite build 全绿
- `npx vitest run`：211 文件 / 1992 passed / 4 skipped（基线 1895 passed，净增 97 用例）
- `npx biome ci .`：525 文件 0 errors / 0 warnings
- 未触及 `src/agent/**` / `src/composition/**` → 不跑 verify:convergence（计划 §5 预判一致）
