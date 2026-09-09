# Stage-4 会话内体验（创作坞 + 目次带）（画布支第四阶段展开）

> 立项：2026-08-25 · 状态：**已落地（2026-08-26，门禁全绿）** · 类型：阶段展开（Agent 起草 → 施工完成）
> 总设计：`canvas-space-model-notes.md` §5（拍板 9 创作坞 + 拍板 10 目次带 + 输入区自动选中）+ §7（施工顺序）
> 依赖：Stage-3 会话出生与管理 ✅（侧边栏 + 书脊三手势 + 生命周期闭环）
> 施工纪律：原则一（每步可测切片）· 原则二/三（插件行落位不改核心）· 原则四（随做随清）
>
> ⚠️ 2026-09-10 拍板修正：**自动选中（浏览跟随）整体退役**——活跃会话转移 = 显式动作独占，三道闸/停留计时/守卫群/输入锁存全拆。本文中相关条目均为历史施工记录，保留原貌（详因 `canvas-space-model-notes.md` 输入区归属拍板的 2026-09-10 修正）。

## 0. 一句话

把"输入"和"翻找"做成会话内的成熟体验：**创作坞 = 带设置的输入条**（集成模型 / 权限 / 思考强度 / 发送 / 停止，状态跟随活跃会话热切换），**目次带 = 会话内 minimap**（轮次锚点导航，右缘窄条跟随活跃会话）。两者共用的地基是**活跃会话判定（自动选中 + 高亮）**。

## 1. 目标与验收（用户视角）

**验收一句话**：多会话切换输入流畅、草稿不丢、模型热切换；长会话用目次带定位。

- [x] 创作坞：带设置的输入条（模型/权限/**思考强度**/发送/停止集成一处），跟随活跃会话，配置热切换立即生效
- [x] 状态归属铁律落地：草稿按会话隔离（切走切回字还在）、配置热切换（下一条消息即用）、token/上下文惰性缓存不重算
- [x] 自动选中 + 高亮：视口中心判定活跃会话（三道闸 + 输入锁存），活跃流区边界高亮
- [x] 目次带：会话内 minimap（轮次锚点 + 点击跳转 + 位置指示 + hover 首句预览），右缘窄条跟随活跃会话
- [x] 插件化落位：创作坞/目次带以贡献行消费 ctx.space + 会话状态，不改核心
- [x] 旧路径拆除（旧 composer/旧高亮镜像路径收敛清理），门禁全绿

## 2. 现状代码地图（本阶段要动的文件）

| 文件 | 现状 | 本阶段改动 |
|---|---|---|
| `app/panels/PaperPanel.tsx` `.pp-composer` | 底部输入条（input/textarea + 发送/停止），input-store 真相源，IME 谓词 | 升级为创作坞（加设置行 + 活跃归属） |
| `app/panels/ModelSelector.tsx` | 模型选择下拉（现仅设置面板用） | 集成进创作坞设置行 |
| `app/panels/ModeIndicator.tsx` + `state/mode-store.ts` | 权限模式控件（书眉）+ mode-store 单源真相（镜像 Rust + 落盘） | 权限切换集成进创作坞（ModeIndicator 职责可能收敛） |
| `agent/agent.ts` / `provider/thinking` + `provider/types.ts` | **思考强度套件已备**：ThinkingPolicy（StoredThinking）/ ThinkingEffort + 运行时 `setThinking`（切档位不重建 Provider，热切换基础已具） | 思考强度集成进创作坞 |
| `state/paper-store.ts` `activeRegionId` | 活跃流区镜像（sess activeIdx 镜像）+ 高亮（Stage-2） | 自动选中判定写入（视口驱动 setActiveRegion） |
| `state/input-store.ts` | inputText 面板级单一 | 扩展 per-session 草稿隔离（keyed by sessionId） |
| 新增 | — | 目次带组件（流区附着渲染通道②）；会话状态 API 核对/小扩（打孔③） |

## 3. 核心概念（来自总设计，本阶段落地）

- **创作坞状态归属铁律**（拍板 9 注）：创作坞是视图不是容器，不拥有任何会话状态，只"指向"活跃会话。每会话持有完整状态对象（模型/权限/思考强度=可热切换；token/上下文=惰性计算+缓存）。切换会话 = 指针换向，不迁移不重算。
- **活跃会话 = 有记忆的状态**（输入区拍板）：转移三情形——显式动作立即切；浏览态三道闸（视口停住+中心点落流区+连续停留约 400ms）；缩放永不切/空白保持当前。输入锁存：开始打字后自动切换关闭，仅显式动作可切。
- **目次带**（拍板 10）：屏幕固定右缘窄条、内容跟随活跃会话；轮次锚点（user 输入）+ 点击跳转 + 位置指示 + hover 首句预览；与创作坞同级（视口固定 + 跟随活跃会话的附件）；书脊左缘管卷外、目次带右缘管卷内。

## 4. 子任务分解（拓扑序，每个独立可测）

**4.1 自动选中 + 高亮（活跃会话判定地基）**
- 视口中心点 → 流区几何（复用 visibleRegionWindows）→ 活跃会话判定
- 三道闸：视口停住（平移中不判）+ 中心点落在流区 + 连续停留 ~400ms；缩放不触发；空白保持当前
- 输入锁存：composer 聚焦/输入中关闭自动切换
- 显式动作（书脊点击/侧边栏点击/边缘拖拽）走既有 setActiveRegion
- 高亮 = 活跃流区边界（Stage-2 已有高亮，接自动选中源）
- 可测：判定逻辑单测（视口序列→活跃会话序列）+ 实机（多流区间平移看高亮跟随）

**4.2 创作坞集成（集成任务非新设计）**
- 形态：视口固定底部输入条 + 上沿设置行（可展开收起）
- 模型：复用 ModelSelector（读/写会话状态对象）
- 权限：读 mode-store 写镜像（热切换：当前会话下一条消息用新权限）
- 思考强度：**集成**（provider 已有 ThinkingPolicy/Effort + 运行时 setThinking——热切换基础已具，见 `provider/thinking`）
- 发送/停止：沿用 composer 既有（sendMessage / 停止）
- 可测：实机——一个会话切模型/权限，下一条消息验证生效；切会话配置跟手

**4.3 状态归属落地（铁律实现）**
- 草稿按会话隔离：input-store 扩展 per-session inputText（keyed by sessionId），切会话草稿互不覆盖
- 配置热切换：会话状态对象（模型/权限）写回即生效
- token/上下文：惰性计算 + 缓存（切会话直接读不重算）——核对现有计数来源（agent-execution-state 或消息层）
- 可测：单测——两会话草稿各自保持；热切换写回生效

**4.4 目次带（打孔清单②：流区附着渲染通道）**
- 右缘窄条，屏幕固定、内容跟随活跃会话（切换即换内容）
- 锚点 = 每个 user 轮次（从活跃会话转译块取 kind==='user'，刻度映射相对高度）
- 点击跳转 = focus 到该轮（视口定位 + 块高亮）；位置指示 = 当前视口在带上的刻度
- hover 预览：轮次首句缩略
- 可测：单测（锚点几何/映射）+ 实机（长会话点刻度跳转）

**4.5 插件化落位（原则三）**
- 创作坞/目次带 = 上层形态 = 贡献行，消费 ctx.space + 会话状态 API
- 会话状态 API（打孔③）：核对现有 agent-config/settings 是否已暴露，未暴露则小扩（核心数据层小步，非 UI 形态）
- 可测：vitest——以贡献行注册 + 消费对拍

**4.6 旧路径拆除（原则四）**
- 旧 composer（无设置行/无活跃归属）改造后清理
- activeRegionId 旧镜像路径（仅手动切换）与自动选中接合后的死分支清理
- ModeIndicator 书眉控件**收掉**（权限/模型已进创作坞，书眉两枚小控件职责收敛，跟创作坞走）
- 可测：门禁全绿 + 无旧路径残留核查

## 5. 技术方案要点（Agent 执行用，简略）

- **自动选中判定**：视口中心世界坐标 → 流区矩形相交（复用 Stage-2 几何）→ 命中流区 + 停留计时（rAF 或 timeout，~400ms）→ setActiveRegion。锁存标志放 ref，composer focus/blur 控制。
- **草稿隔离**：input-store 改 `perSession: Record<sessionId, string>` + 活跃镜像，composer 读写走活跃键。
- **目次带几何**：活跃会话块数组（blocks）+ user 块 y 坐标 → 归一化映射到窄条高度；点击反查块 id → focus。
- **流区附着通道**：对齐 services 通道模式（register→Disposer），挂 ctx（暂名 ctx.regionOverlay 或并进 ctx.space），目次带经它挂载到活跃流区右缘。

## 6. 插件化约束（原则二/三）

- 创作坞/目次带 = 上层形态 = **插件/贡献行**；空间 API 已在 Stage-2 打孔，本阶段新增的唯一核心面 = 会话状态 API 小扩（若现有未暴露）+ 流区附着通道（若需）
- 自动选中属于空间内核（活跃会话判定是平台行为）——内核小步，高亮/UI 属形态
- 验收含「创作坞/目次带以贡献行注册」证据

## 7. 验收清单（阶段完工 = 功能 + 拆旧 + 门禁全绿）

- [x] 创作坞设置齐全（模型/权限/发送/停止；思考强度核对后定）
- [x] 热切换生效（切模型/权限，下一条消息验证）+ 草稿按会话隔离
- [x] 自动选中 + 高亮（平移跟随/输入锁存/显式切换）
- [x] 目次带（轮次锚点/点击跳转/位置指示/hover）
- [x] 插件化落位（贡献行 + 消费对拍）
- [x] 旧路径拆除干净 + 门禁全绿

## 8. 拍板点（已全定 2026-08-25 痞老板审）

1. **思考强度 = 集成**：provider 已有完整套件（ThinkingPolicy/ThinkingEffort + 运行时 setThinking），热切换基础已具，直接进创作坞
2. **创作坞设置行 = 常驻一行只放高频件（模型 + 权限），其余（思考强度等）进展开**（一眼可见又不占空间）
3. **ModeIndicator 书眉控件收掉**：权限/模型跟创作坞走
4. **目次带锚点 = 先纯 user 轮次**（关键块标记后置）

---

## 落地状态（2026-08-26 施工完成，门禁全绿）

> 实现全部对齐 §1 验收 / §4 子任务 / §8 拍板点；旧路径（PaperPanel 内嵌旧 composer、
> 书眉 ModeIndicator）已随本阶段拆净。实机手感（自动选中跟随、目次带跳转）留用户实测迭代。

**已交付**：

| 子任务 | 落点 | 验收 |
|---|---|---|
| 4.1 自动选中 + 高亮 | `paper/active-region.ts`（视口中心命中 + 三道闸停留控制器 `createSettleSelector`）；PaperPanel 自动选中 effect（平移/缩放/动画/输入锁存折叠成 moving，200ms 兜底停住判定 + view 订阅即时取消）；显式动作 `activateRegion` adopt 防拉回；高亮 = 既有 `pp-region-active` 接自动选中源 | `tests/stage4-active-region.test.ts`（命中 + 三道闸 + adopt，7 用例） |
| 4.2 创作坞集成 | `app/panels/ComposerDock.tsx`（设置行 = 活跃会话/token/模型 ModelSelector/权限 mode-store + 思考档位展开；输入行 = 附件/斜杠/输入/发送/停止）；经 `ctx.overlays` slot:'composer' 贡献行渲染 | 插件贡献 + 组件接线（见 4.5） |
| 4.3 状态归属落地 | `state/compose-store.ts`（每会话 ComposeSessionPrefs：模型/思考，缺失惰性快照；写 = 落全局 settings + model-switched/thinking-changed 信号 → Workspace.applyAgentConfig 热同步）；草稿 = input-store 既有 sessionDrafts（ChatCore/chat-session 切卷 save/restore，ComposerDock 只读写 live）；token = sessionTokens 惰性读取 | `tests/compose-store.test.ts`（隔离/热切换/清理，6 用例） |
| 4.4 目次带 | `paper/toc.ts`（纯几何：轮次锚点/相对高度映射/点带反查/视口指示）+ `app/panels/TocStrip.tsx`（右缘窄条、跟随活跃会话、hover 预览、点击 `flyToPoint` 跳转）；经 `ctx.overlays` slot:'right-edge' 贡献行渲染 | `tests/stage4-toc.test.ts`（8 用例） |
| 4.5 插件化落位 | `composition/overlay-service.ts`（`ctx.overlays` register→Disposer 通道 + `overlayServicePlugin`）；`plugins/compose-dock-plugin.ts`（composer/right-edge 双贡献 + `compose/space-status` 命令消费 ctx.space）；PaperPanel 渲染贡献行 + `paper/overlay-context.ts`（拆 Dock/Region 双 context，创作坞不随平移重渲） | `tests/stage4-compose-dock.test.ts`（贡献注册/消费对拍/dispose，4 用例） |
| 4.6 旧路径拆除 | PaperPanel 摘除旧 composer 内嵌块（输入/附件/斜杠/停止迁入 ComposerDock）；`ModeIndicator.tsx` + `mode-indicator.css` + `tests/ui/mode-indicator-model-menu.test.ts` 删除（权限/模型进创作坞）；交互探针（stop-button/slash-at-composer）改扫 ComposerDock；compose-store 生命周期接线（resetSessionState clearAll / closeSession removePrefs / disposePanelStores） | `paper-interaction-handoff.test.ts` 全绿 + grep 无旧路径残留 |

**门禁**：vitest 全量 176 文件 1742 passed / 4 skipped · `npm run build`（tsc + vite）✓ · `npm run verify:convergence` exit 0 · `npx biome ci .` 0/0。

**实机待验**：自动选中跟随手感（400ms 停留/输入锁存）、创作坞设置行交互、目次带跳转与位置指示、思考档位热切换——留给用户实测反馈迭代。