# src/paper — 白纸壳 headless 内核（V3a 骨架）

> paper-shell 计划（`docs/plans/paper-shell/README.md`）V3a：走查弹毕业后的骨架内核。
> 纪律：**零 UI 依赖 + 无头测试**（对齐 `agent/` 运行时纪律）。
> 壳层（React，不在本目录）：`src/app/panels/PaperPanel.tsx`。

## 分层（设计文档 §3.1 三层分离的落地）

| 文件 | 职责 |
|---|---|
| `block-model.ts` | 真相层：块物件 `{ id, kind, payload, state: flow\|pinned, x/y/w }` + 纯操作（pin/unpin/move） |
| `canvas-math.ts` | 交互层：无限画布数学（视口/缩放锚点/屏幕↔世界换算/流锚布局） |
| `translate.ts` | 宿主侧块转译 v1：`ChatMessage[]` → `SourcedBlock[]` 纯函数（agent 层零改动） |
| `measure.ts` | **V3a** 块高真测量：`@chenglou/pretext`（上游包，待定 #8）+ prepare 缓存纪律 + 纸面字体常量（具名栈：Fraunces/Noto Serif SC/JetBrains Mono） |
| `virtualize.ts` | **V3a** 视口虚拟化：视口→世界矩形、flow 窗口二分（O(log n)）、pinned 矩形相交——数据全量、渲染窗口化 |
| `selection.ts` | **V3a** 抽纸条（待定 #10）：`PaperStrip` 用户层物件——拷贝语义快照 + 世界坐标，与块级活引用区分 |
| `ime.ts` | **V3a** IME 安全谓词：输入条提交守卫（合成中 Enter 不发送）；V3b 块内编辑的候选窗错位风险记录在案 |

## 拍板决定的映射

- D-R1-2 默认 flow → `createBlock` 缺省 `state: 'flow'`
- D-R1-3 流锚甲 → `canvas-math.ts` `layoutFlow`（自锚点向上生长）+ `viewForAnchor`（锚点对视口下缘）
- D-R1-1 无限画布+方位感 → `zoomAt`/`panBy` 无边界 + `ORIGIN_CROSS` 原点十字 + **V3a** Home 回原点快捷键 + 小地图（壳层）
- D-R2-1 钉住=拖出+动手权 → `pinBlock`（**V3a 手势分工**：块头手柄=整块拖出；文本区=原生选择——抽纸条前提）
- D-R2-3 活引用 → `SourcedBlock.source` 挂消息/part 引用，重转译按稳定 id 续命钉住态；**纸条例外**：拷贝语义（待定 #10 拍板——活引用仅块级）
- D-R2-4 世界坐标唯一真相 → pinned 块 x/y 是唯一真相；flow 块坐标是布局复算值
- 待定 #8 测量引擎 → `measure.ts`（上游 `@chenglou/pretext` 取代内部 `lib/pretext` 快照——已退役删除；`ui/pretext-cache.ts` 观测台侧同步切上游包）
- 待定 #10 抽纸条 → `selection.ts`：选中文字拖离流 = 纸条（拷贝、可拖动），空选区手势落空

## 测试

- `tests/paper-core.test.ts`（23）——走查弹三层纯逻辑
- `tests/paper-v3a.test.ts`（28）——测量封装（mock canvas：kinds 全谱 / 截断路径 / FIFO 淘汰）/ 虚拟化 / 抽纸条 / IME 谓词

## V3a 之后

V3b 壳装配（组合层 roster 挂载 + 块渲染器 ctx service 化）；V2 视觉契约（token 转录）。
已知记录在案：V3b 钉住块就地编辑的 IME 候选窗错位风险（`ime.ts` 头注）。
