# 纸面流区「从坏点起全乱」排查留档（2026-09-03）

> **文档性质**：疑难 bug 排查留档。下次再遇到同类症状（追加输入后来文消失、
> 排版从某块起全碎、合卷重摊开自愈），先读本文 + 按文末「取证手册」抓证据，
> 不要从零重查。
>
> **结论速览**：已修两刀（`f02cd543` + `8d62132f`），均为防御性兜底，根治了
> 「NaN 级联打碎」的机制面；但**实机触发源未 100% 锁定**（见 §6 存疑），若
> 再复现务必取证。

---

## 1. 症状（用户原话归纳）

- Agent 正常结束一个工作后 loop 停止 → **追加新输入**后
- **来文块（user 消息）偶发消失**，且**从坏掉的那条来文开始往后，所有渲染
  全部坏掉**（不是单块问题，是级联）
- 会话**合卷后再重新拖入画布即恢复正常**
- 偶发：不是每次追加都触发；无法稳定复现

## 2. 已确认机制：NaN 布局级联（实锤）

用最小复现探针（`layoutFlow` 传入单块 `h: NaN`）实测输出：

```
y = NaN, NaN, NaN, -248, -100
```

**单块高度 NaN → 该块自身 + 其上方所有块 y 全部变 NaN**（布局自底向上累积，
游标 `cursor = y - h - gap` 被 NaN 污染一次，上游全毁）。

NaN 的 y 进虚拟化二分（`visibleFlowWindow`，依赖 y/bottom 单调）→ 二分失效
→ 块被窗口漏掉 = **「块消失」** + 整体错位 = **「排版打碎」**。

**合卷重摊开自愈** = 重新读取正常数据/宽度，NaN 不再出现。

## 3. 级联链条（根因路径）

```
某处产生「流区宽」NaN/脏值
  → PaperPanel adaptBlocks: contentW = regionW - REGION_CONTENT_MARGIN
     → 块宽 w = NaN（Math.min(NaN, x) = NaN，无兜底）
  → measureBlockHeightCached: 测高用 NaN 宽 → 高度 NaN
  → layoutFlow 游标被 NaN 污染 → 坏块及其上方全 NaN（§2）
```

**脏值来源（两类，均已封堵）**：

| 来源 | 路径 | 封堵 |
|---|---|---|
| 磁盘 `canvas.json` 恢复 | `loadCanvas` 对 `spread[].width/anchorX/anchorY` **零校验直接透传**——缺失/null/NaN/Infinity/越界值都能进布局 | `loadCanvas` 恢复校验：width 限 `[720, 2160]`、anchor 限有限数，脏值回落默认 |
| 运行态异常 | 流区宽被拖动/缩放/脏状态写坏（具体触发源未锁定，见 §6） | `adaptBlocks` 对 regionW/块宽做有限数兜底；`layoutFlow` 对 h/w 做最后防线 |

## 4. 已提交修复（两刀）

### 刀一 `f02cd543` — 会话销毁清理实测残留

- **问题**：`paper/measure.ts` 的 `observedHeights`（RO 实测高回写表）是**模块级
  Map、跨会话存活、合卷时不清**（生产代码零清理，只在测试里清）。会话重建后
  块 id 复用（撞号），`measureBlockHeightCached` 的实测优先路径（**无签名守卫**）
  会无条件吃旧会话旧块的实测高 → 布局错乱。
- **修复**：`state/messages-store.ts` 的 `disposeSessionMessagesStore`（合卷）与
  `disposeMessagesStores`（工作区重置）补 `clearObservedHeightsForSession()`。

### 刀二 `8d62132f` — NaN 级联三层防御

1. **`state/canvas-store.ts` `loadCanvas`**：恢复时校验 width ∈ [720, 2160]、
   anchor 有限数；脏值回落 `STREAM_REGION.width` / 0（磁盘侧防火墙）
2. **`PaperPanel.tsx` `adaptBlocks`**：regionW / 块宽非有限数回落默认版心宽
   （运行态防火墙，`FALLBACK_BLOCK_W = 720`）
3. **`paper/canvas-math.ts` `layoutFlow`**：单块 h/w 非有限数按 0 / 默认宽兜底
   （**布局最后防线——宁可压扁单块，不级联全卷**）

## 5. 验证

- 新增回归测试 3 个：
  - `tests/paper-core.test.ts`：`layoutFlow` 单块高 NaN 不级联（所有块 y 有限）
  - `tests/paper-core.test.ts`：块宽 NaN 兜底默认宽（x 不污染）
  - `tests/canvas-store.test.ts`：`loadCanvas` 脏数据（NaN anchor / NaN width /
    越界 width）回落默认，恢复值全有限数
- 相关 7 文件 218 测试全过；全量 vitest 243 文件 2407 通过（提交时基线）
- biome 干净；tsc 本文档所涉文件零错误

## 6. 存疑 / 未锁定（下次复现重点关注）

1. **运行态 NaN 的确切触发源未锁定**。磁盘侧已封（loadCanvas 校验），但
   「偶发追加后触发」的**活体来源**仍有嫌疑：
   - 四角缩放流区（`clampRegionW` 对 NaN 输入不免疫：`Math.min(2160, Math.max(720, NaN))` = NaN）
   - 视图 zoom 异常 → 边缘拖动 `dx/zoom` 得 Infinity
   - 并行会话（小地图插件化，2026-09-03 在途）可能引入新写路径
2. **`observedHeights` 的「撞号」面在来文（user 块）上不成立**（user 不读实测
   表）——刀一修的是资产/图表/拟策/工具卡族；**来文消失的主因应是 NaN 级联**
   （刀二），但来文本体的 NaN 高度从哪来仍需实机证据。
3. 排查途中发现工作区有**并行会话未提交改动**（PaperPanel 小地图插件化 +
   overlay-context 类型半成品，tsc 当时是红的）——**合流后建议跑一次完整
   `npm run build` 确认**。

## 7. 取证手册（下次复现时照做，5 分钟拿到关键证据）

复现「追加输入后来文消失/打碎」时，**先别合卷**，按序取：

1. **打开 DevTools Console**，看有无：
   - `NaN` 相关警告 / `[paper]` / `[canvas]` 前缀的错误
   - `ResizeObserver loop` 警告（实测回写抖动的信号）
2. **抓布局数值**（Console 执行）：
   ```js
   // 找到纸面根节点后，检查坏卷的块 transform 是否有 NaN
   document.querySelectorAll('.pp-block').forEach((el) => {
     const t = el.style.transform;
     if (t && t.includes('NaN')) console.log('NaN 块:', el.dataset.messageId, el.dataset.sessionId);
   });
   // 检查流区锚点
   document.querySelectorAll('.pp-stream-region').forEach((el) => {
     const t = el.style.transform;
     if (t && t.includes('NaN')) console.log('NaN 流区:', el.dataset.sessionId);
   });
   ```
3. **抓 canvas.json**（若上述 NaN 块/流区来自脏恢复）：
   ```
   <工作区>/.lantai/canvas.json
   ```
   重点看 `spread[].width / anchorX / anchorY` 是否有异常值（<720、>2160、null、字符串）。
4. **记录坏前操作**（一句话即可）：拖过流区边缘？四角缩放过？拖过块钉住？
   缩放视图？窗口 resize？
5. 把以上（Console 输出截图 + canvas.json + 坏前操作）贴给 Agent。

## 8. 相关代码地图（下次排查入口）

| 文件 | 角色 |
|---|---|
| `src/paper/canvas-math.ts` `layoutFlow` | 布局累积（NaN 级联发生地，已兜底） |
| `src/paper/measure.ts` `observedHeights` / `measureBlockHeightCached` | 实测高表（无签名守卫，撞号污染源，已随会话清理） |
| `src/paper/virtualize.ts` `visibleFlowWindow` | 二分窗口（y 单调前提；NaN 即失效） |
| `src/state/canvas-store.ts` `loadCanvas` | 磁盘恢复入口（脏数据防火墙，已加） |
| `src/plugins/builtin/paper-shell/PaperPanel.tsx` `adaptBlocks` | 块宽适配（运行态防火墙，已加） |
| `src/ui/chat-stream.ts` `appendUserBubble` / `_finaliseStreamingAssistant` | 追加输入链路（引用提交正确，排除） |
| `src/ui/message-model.ts` `resetMsgIdCounter` | 已证为空操作（id 全局唯一，排除撞号主路径） |