# 画布海拔 · 施工单（2026-11-22）

> 设计真源 = [canvas-depth-plan.md](canvas-depth-plan.md)（病灶 / 高度带 / 影公式 / 边界）；本文只排施工，不重设计。
> 起点：`b4ae3715`（P1 模型 + P2a 架件 + P3a 活跃纸已落）。
> 两条已定边界：**坞不接海拔**（用户 2026-11-22「坞不要动」）；**不模拟受光**（`15a3d180` 判死撤除）。
> 全局面板 / 模态的 280+/400+/500+ 层不动。

## 0. 待批准（回一句即可，批准前只做 B1/B2）

**Q1 · 钉块与纸谁在上？**

- **A（推荐）公共钉块永远在纸上面**：保持「钉到拔为止、公共物不绑会话」的现状语义；一张纸不能盖住钉块。删掉计划里「纸可盖住钉块」那条验收（那是我写岔的）。
- **B 钉块跟它那张纸走**：纸盖住钉块成立，更物理；代价是活钉（有 `source.sessionId`）与孤儿钉（无源）要分两套算，且「公共物」语义变弱。

**Q2 · 纸的拿起次序怎么实现？**

- **A（推荐）DOM 顺序**：点/拖一张纸 = 把它移到渲染序末尾；纸带保持 0/1 两档，**不碰任何 z**（坞、目次带、小地图、顶浮件的 z 一字不动）。代价：重排 DOM 要行为测试守住焦点/选区（纸面本身没有常驻输入件，风险主要在文本选区）。
- **B 全带 z**：纸 100–999、纸片件 1000+、环境 3000、架件 3100、覆盖层 4000。z 语义最干净，但**必须把坞的 z 从 6 挪到 3200**——形态/无影/仍是墨，只动这个数字。你之前说「坞不要动」；如果那条只指形态、允许挪数字，选 B。
- **C 只做活跃纸**（现状，不推荐）：非活跃纸之间仍按 DOM 顺序，两张都没激活时依然"分不出谁在上"。

## 1. 批次

### B1 · 纸 + 待题纸接海拔（不碰坞 / 不碰 z）

| 项 | 内容 |
|---|---|
| 文件 | `paper-shell/PaperPanel.tsx`（region style 加 `--h`）、`paper-shell/paper-base.css`（.pp-region / active / band 的影）、`paper-shell/DraftSheet.tsx` + `draft-sheet.css` |
| 做法 | `--h` = `ELEVATION.sheet.height`（3）/ `active`（10）/ `lifted`（14），由 TSX 内联写；`.pp-region` 的四层包边保留，只把最后一层 `--shadow-sheet` 换成 `var(--elev-shadow)`；`.pp-region-active` / `.pp-region--band` 的静态硬影栈删除，只留 `--h`。待题纸 `--h = 3`（它的"新"是 z 顶，不是高度） |
| 拿纸过冲 | `@property --h` 注册 number，`pp-region-take` 改成 `3 → 14 → 10` 的关键帧（仍是 260ms）；不支持的宿主退化为普通 box-shadow 过渡（无过冲）。原则上仍**只动 h/box-shadow，不碰 transform/background** |
| 测试改写 | `paper-visual-decisions` 约 10 条：纸 base/active（4）、take 帧（3）、band（1）、钉块（1）、纸条（1）；触点是"旧硬影 stack"→"elev-shadow + --h"。`paper-draft-sheet-visual` 的 `row` 断言不动 |
| 风险 | 剂量（纸静置要与现状几乎无差、活跃要读得出"拿起来"）；过冲动画在 WebView2 的 `@property` 支持（不支持则无过冲，不炸） |
| 验收 | 实机：静置纸影 ≈ 现状；点活跃 = 影明显加深且不跳；连点不重放过冲；`vitest` 纸相关全绿；`build` 过 |

### B2 · 顶浮件 + 纸片件（不碰坞 / 不碰 z）

| 项 | 内容 |
|---|---|
| 文件 | `paper-base.css`（.pp-chrome）、`paper-inline.css`（.pp-block.pp-pinned）、`paper-ops.css`（.pp-strip）、`PaperPanel.tsx`（chrome / 活钉 / 孤儿钉 / 纸条 四处） |
| 做法 | 顶浮件 `pp-elev` + `--h = 12`，box-shadow 从 `--elev-raise` 换成 `var(--elev-shadow)`；钉块/纸条 `pp-elev` + `--h = 5`，末层 `--shadow-sheet` 换成 `var(--elev-shadow)`。拖拽携带态照旧 `--elev-raise`（瞬时件，不参与海拔） |
| 测试改写 | 钉块/纸条两条 `var(--shadow-sheet` → `var(--elev-shadow`；新增"四处都从 ELEVATION 读 --h"的来源断言 |
| 风险 | 钉块/纸条的影变软（5px 档）；命中盒不动（不碰 padding/尺寸） |
| 验收 | 实机：钉块/纸条仍"贴在纸上"，顶浮件浮起；`paper-visual-decisions` 全绿 |

### B3 · 拿起次序（按 Q2）

**A 案（DOM）**
- 文件：`paper-shell/use-paper-regions.ts`（或 PaperPanel 的 regionRender 排序）+ 一个会话内的拿起序（不落盘）+ `use-region-activation` 接线。
- 做法：激活/拖起 = 移到队尾；纸带维持 0/1；`active` 仍 1（同时它也在队尾）。
- 测试：新 `tests/paper-region-order.test.tsx`——两次激活 → 渲染序交换；点回旧纸 → 它回顶；焦点/选区在重排后不丢（有则回退到 B）。
- 风险：DOM 重排的焦点/选区；React key 稳定（不重挂）。

**B 案（全带 z）**
- 文件：`paper-base.css` / `paper-toc.css` / `paper-composer.css` / `paper-minimap/minimap.css` / `paper-ops.css` / `paper-motion.css` / `PaperPanel.tsx`。
- 做法：按 `ELEVATION` 一次归位（含坞 3200、sel-ink 3050、引线 3050、幽灵 4000），删掉 `paper-elev.css` 的 0/1 临时档；`zOf` 开始被真正消费。
- 测试：`paper-elevation` 增加"CSS 实读 z = 模型"对拍；`paper-visual-decisions` / `paper-viewport-ux` 全量；点击命中回归。
- 风险：最高（命中/引线/朱线/幽灵），必须独立 commit。

### B4 · 覆盖层归位（A 案下的小步）

- `paper-ops.css`：`.pp-sel-ink` z 62 → 3（纸之上、引线 4 / 目次带 5 / 坞 6 之下）。
- 引线 4、幽灵 55 不动（引线本来就在坞后；幽灵是瞬时件）。
- 测试：朱线在坞/目次带之下（行为面：z 值断言 + 结构断言）。
- B 案下本批并入 B3。

### B5 · 守护 + 规格 + 实机

- 新 `tests/paper-depth-contract.test.ts`：① 带高度件必须 `pp-elev` + `--h` 来自 `ELEVATION`（禁样式表写死）；② 影配方唯一（只有 `paper-elev.css` 定义 `--elev-shadow`）；③ 坞不接（选择器与 `--h` 双向断言）；④ 流内排印件不挂 `pp-elev`。
- `docs/design/lantai-design-spec.md` §11：补"画布内部高度梯 / 坞是墨 / 不模拟受光"三条。
- 计划状态、README 同步；实机判读剂量（重建包后）。

## 2. 门禁（每批 commit 前）

`cd src-ui && npm run build` · `npx vitest run`（全量；起步可先跑相关面） · `npx biome ci .` 0/0 · `npm run doc-check`。实机项在 B1/B2/B3 各留一张对照截图（真机重建包后）。

## 3. 回滚

一批一 commit：B1/B2 纯样式+内联变量（revert 即回）；B3 行为面独立 commit（A/B 两案不混）；B4 独立。计划/README 随批提交。

## 4. 整线验收（与计划 §8 同）

1. 任取两件重叠物，一秒内读得出谁在上；点/拖能改变上下。
2. 影的方向全画布一致；纸/纸片件/架件按高度出影；流内排印件无影。
3. 坞仍无影（拍板）；全局面板/模态 z 与影一字未动。
4. 四道门禁全绿。
