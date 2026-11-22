# Baseline 变更申请 — phase-0/tool-schemas.{full,plan}.json（批 4：OCR 视觉锚点）

> 申请日期：2026-11-22 · 申请人：编码助手（computer use 四批计划 批 4 / P1-2）
> 状态：**已批准**（用户 2026-11-22 会话内批准 baseline 申请，覆盖四批）——record 随本批执行。
> 关联计划：`.lantai/plans/plan-1795321025508-cc89.md`

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`
- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.plan.json`

## 2. 漂移内容（本批唯一来源）

| # | 变更 | 模型可见后果 |
|---|---|---|
| 1 | `desktop_uia_window_shot` 新增可选布尔参数 `anchors`（默认 false） | 模型知道可以要「OCR 文字锚点」：`{anchors:[{text, rect, center}]}` 已是屏幕虚拟坐标，可直接喂 x/y 点击 |
| 2 | `desktop_uia_window_shot` 描述追加 anchors 段（含自绘界面的标准流程：probe → shot(anchors:true) → 点 center → 复看） | 描述字节变化（约 +400 字符） |
| 3 | `desktop` 域描述的自绘应用指引改为「window_shot(anchors:true) 给图 + 文字锚点」 | 域描述字节变化（约 +80 字符） |

工具面增量 = **1 个可选参数**；不新增动作、不新增域。

## 3. 为什么必须变

- 批 4 的目标是「自绘控件有文字锚点」。锚点必须与截图同一次调用返回（否则模型要先 shot、
  再另一调用拿锚点，两张图可能不同帧）；参数不暴露到 schema 就等于能力不存在。
- 描述必须写清坐标口径（屏幕虚拟坐标，与 rect / 批 2 的 x/y 同源）——口径写错，模型会把
  图片内坐标当屏幕坐标用，点击落偏。

## 4. 证据

- 代码面：`uia/ocr_anchors.ps1`（内嵌 PowerShell + WinRT `Windows.Media.Ocr`，引擎候选 =
  用户语言 + `zh-Hans-CN`，取识别行数多者；纯 ASCII 以适配 PS 5.1 的 ANSI 解析）、
  `uia/ocr.rs`（`anchors()` 执行 + `parse_anchors()` 纯函数：行框 = 词框并集、加窗口原点、
  脏数据跳过）、`uia/mod.rs`（`uia_window_shot(..., want_anchors)`：OCR 失败只降级为「只给图」
  并写 `ocrNote`）、`commands/uia_cap.rs` 与 `commands/uia_batch.rs` 传参；
  `browser.ts`（schema + 描述）、`domains.ts`（自绘应用指引）；
- **可行性已实测**（探针）：本机 `AvailableRecognizerLanguages = en-US, zh-Hans-CN`；
  对程序生成的测试图，OCR 返回逐词包围盒（`Save/Close/Cancel/0K` 及其 x/y/w/h）——
  中文语言包在线，Anchor 路线成立；
- 生成物：`npm run gen:tool-contract` 已重写 `docs/agents/model-tool-contract.md`（55753 chars）；
- 测试：`cargo test --bins ocr` 3/3（行框合并 + 窗口原点偏移 / 脏行脏词跳过 /
  engine=none 与非法输出）· `cargo test --bins desktop` 9/9 ·
  `vitest tests/desktop-tools.test.ts + desktop-uia-new-actions.test.ts` 29/29。

## 5. 拟议变更

采纳 record 生成的新快照（full + plan 两份），其余快照零变化。

## 6. 落地步骤

1. ✅ 可行性探针（WinRT OCR + 语言包）
2. ✅ `uia/ocr_anchors.ps1` + `uia/ocr.rs` + `uia_window_shot(anchors)` + 两处调用点
3. ✅ TS schema/描述 + 域描述 + 契约文档
4. ⬜ `record` 刷新快照（本批执行）
5. ⬜ 复跑 `verify:convergence`（standard + minimal）全绿
