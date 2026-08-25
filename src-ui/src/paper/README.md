# src/paper — 白纸壳 headless 内核（V3a 骨架 + V3b 装配）

> paper-shell 计划（`docs/plans/paper-shell/README.md`）V3a/V3b。纪律：内核零 UI 依赖 + 无头测试（对齐 `agent/` 运行时纪律）。
> 壳层（React，不在本目录）：`src/app/panels/PaperPanel.tsx`；装配（V3b）：`paper-plugin.ts`。

## 分层（设计文档 §3.1 三层分离的落地）

| 文件 | 职责 |
|---|---|
| `block-model.ts` | 真相层：块物件 `{ id, kind, payload, state: flow\|pinned, x/y/w }` + 纯操作（pin/unpin/move） |
| `canvas-math.ts` | 交互层：无限画布数学（视口/缩放锚点/屏幕↔世界换算/流锚布局） |
| `translate.ts` | 宿主侧块转译 v1：`ChatMessage[]` → `SourcedBlock[]` 纯函数（agent 层零改动） |
| `measure.ts` | **V3a** 块高真测量：`@chenglou/pretext`（上游包，待定 #8）+ prepare 缓存纪律 + 纸面字体常量（具名栈：Fraunces/Noto Serif SC/JetBrains Mono） |
| `virtualize.ts` | **V3a** 视口虚拟化：视口→世界矩形、flow 窗口二分（O(log n)）、pinned 矩形相交——数据全量、渲染窗口化；**Stage-2** 加跨流区窗口 `visibleRegionWindows`（一纸多卷） |
| `space.ts` | **Stage-2** 画布空间纯函数 + 常量：流区宽 1440 / 间距 720 / 吸附网格 2160 / 边缘宽 6px / 线性排比默认落位 / X 吸附 |
| `selection.ts` | **V3a** 抽纸条（待定 #10）：`PaperStrip` 用户层物件——拷贝语义快照 + 世界坐标 + source 溯源元信息（收尾 2026-08-24：持久化接入 `state/paper-store.ts`，随会话快照落盘/恢复） |
| `ime.ts` | **V3a** IME 安全谓词：输入条提交守卫（合成中 Enter 不发送）；V3b 块内编辑的候选窗错位风险记录在案 |
| `paper-plugin.ts` | **V3b** 壳装配：纸面板经 PanelsService 贡献挂载（第一方插件行——面板贡献走组合层通道，不自建旁路）；块体渲染器消费第五通道（`composition/renderer-service.tsx` 的 `resolveRenderer`） |

## 拍板决定的映射

- D-R1-2 默认 flow → `createBlock` 缺省 `state: 'flow'`
- D-R1-3 流锚甲 → `canvas-math.ts` `layoutFlow`（自锚点向上生长）+ `viewForAnchor`（锚点对视口下缘）
- D-R1-1 无限画布+方位感 → `zoomAt`/`panBy` 无边界 + `ORIGIN_CROSS` 原点十字 + **V3a** Home 回原点快捷键 + 小地图（壳层）
- D-R2-1 钉住=拖出+动手权 → `pinBlock`（**V3a 手势分工**：块头手柄=整块拖出；文本区=原生选择——抽纸条前提）
- D-R2-3 活引用 → `SourcedBlock.source` 挂消息/part 引用，重转译按稳定 id 续命钉住态；**纸条例外**：拷贝语义（待定 #10 拍板——活引用仅块级）
- D-R2-4 世界坐标唯一真相 → pinned 块 x/y 是唯一真相；flow 块坐标是布局复算值
- **收尾 2026-08-24：纸面用户层持久化**——钉住块坐标 + 纸条经 `state/paper-store.ts` 按会话管理（scoped store），随会话快照落盘（`StoredSession.paper`）与恢复；切卷/合卷/删卷/切工作区各路径清理；抽纸条手势重写（判拖防误触 + 选区锚点块校验 + source 溯源）
- **Stage-2 一纸多卷（2026-08-25）**——`canvas-math.ts` 加 `layoutRegion`（多锚布局）、`virtualize.ts` 加 `visibleRegionWindows`、新增 `space.ts`（流区常量/落位/吸附）、`state/paper-store.ts` 扩展流区位置（`region` 随会话快照落盘/恢复 + `activeRegionId`）、`composition/space-service.ts` 立 `ctx.space` 通道（读状态/订阅/定位/落位/展开/收起）；`PaperPanel` 渲染多个流区共享同一视口（边缘拖动移动流区、吸附网格、活跃流区高亮）
- 待定 #8 测量引擎 → `measure.ts`（上游 `@chenglou/pretext` 取代内部 `lib/pretext` 快照——已退役删除；`ui/pretext-cache.ts` 观测台侧同步切上游包）
- 待定 #10 抽纸条 → `selection.ts`：选中文字拖离流 = 纸条（拷贝、可拖动、可销毁），空选区手势落空

## 测试

- `tests/paper-core.test.ts`（23）——走查弹三层纯逻辑
- `tests/paper-v3a.test.ts`（28）——测量封装（mock canvas：kinds 全谱 / 截断路径 / FIFO 淘汰）/ 虚拟化 / 抽纸条 / IME 谓词
- `tests/paper-v3b.test.ts`（10）——第五贡献通道（注册/覆盖/兜底/dispose）+ 纸壳面板贡献合流对拍

## V3b 之后

V4 视觉打磨环（防发散协议——一环一维/对照反馈/品味账本/机械 gate/止损）；V5 壳切换（preset 双装配）。
已知记录在案：V3b 钉住块就地编辑的 IME 候选窗错位风险（`ime.ts` 头注）。
