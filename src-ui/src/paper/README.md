# src/paper — 白纸壳 headless 内核（走查弹 · tracer bullet）

> paper-shell 计划（`docs/plans/paper-shell/README.md`）的 V3a 前哨：真实数据穿全层的纸视图核心。
> 2026-08-21 走查弹开工。纪律：**零 UI 依赖 + 无头测试**（对齐 `agent/` 运行时纪律）。

## 分层（设计文档 §3.1 三层分离的落地）

| 文件 | 职责 |
|---|---|
| `block-model.ts` | 真相层：块物件 `{ id, kind, payload, state: flow\|pinned, x/y/w }` + 纯操作（pin/unpin/move） |
| `canvas-math.ts` | 交互层：无限画布数学（视口/缩放锚点/屏幕↔世界换算/流锚布局） |
| `translate.ts` | 宿主侧块转译 v1：`ChatMessage[]` → `SourcedBlock[]` 纯函数（agent 层零改动） |

壳层（React，不在本目录）：`src/app/panels/PaperPanel.tsx` — 灰框块渲染器 +
平移缩放拖拽 + 输入条。走查弹纪律「丑得理直气壮」：视觉极简灰框，结构对即可。

## 拍板决定的映射

- D-R1-2 默认 flow → `createBlock` 缺省 `state: 'flow'`
- D-R1-3 流锚甲 → `canvas-math.ts` `layoutFlow`（自锚点向上生长）+ `viewForAnchor`（锚点对视口下缘）
- D-R1-1 无限画布+方位感 → `zoomAt`/`panBy` 无边界 + `ORIGIN_CROSS` 原点十字
- D-R2-1 钉住=拖出+动手权 → `pinBlock`（动手权走查弹只做读侧：tool 输出可展开）
- D-R2-3 活引用 → `SourcedBlock.source` 挂消息/part 引用，重转译按稳定 id 续命钉住态
- D-R2-4 世界坐标唯一真相 → pinned 块 x/y 是唯一真相；flow 块坐标是布局复算值

## 后续（走查弹通过后 → V3a）

本目录是 V3a 骨架内核的第一批真文件：虚拟化（视口窗口化渲染）、Pretext
测量接入、IME spike、块渲染器 ctx service 化都在 V3a 展开——走查弹先验证
结构与「流的感觉」。
