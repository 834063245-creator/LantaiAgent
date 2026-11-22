# Baseline 变更申请 — phase-0/tool-schemas.{full,plan}.json（批 1：窗口截图进上下文）

> 申请日期：2026-11-22 · 申请人：编码助手（computer use 四批计划 批 1 / P0-1）
> 状态：**已批准**（2026-11-22 用户会话内批准"baseline 申请通过"）——record 已执行
> （`npm run record:convergence`，漂移只落 `phase-0/tool-schemas.{full,plan}.json`）。
> 关联计划：`.lantai/plans/plan-1795321025508-cc89.md`

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`
- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.plan.json`
- 首个差异位置：第 1132 行（desktop 域动作 schema 的键序处）

## 2. 漂移内容（逐项，均来自本批改动）

| # | 变更 | 模型可见后果 |
|---|---|---|
| 1 | `desktop_screenshot` 新增可选布尔参数 `attach_image`（默认 false） | 模型知道"全屏图默认不进上下文，要图得显式开口"。旧 `z.object({})` 无参数 |
| 2 | `desktop_screenshot` 描述改写：删「text-only 模型看不到图、把路径交用户」，改「默认不接图，`attach_image:true` 才接」 | 描述字节变化（约 +150 字符） |
| 3 | `desktop_uia_window_shot` 描述改写：声明输出带 `{image, attachment, imageNote}`、窗口图默认进上下文、给出自绘应用的标准流程 | 描述字节变化（约 +300 字符） |

**不在本批的模型可见变化**：无。`imageChannel: true` 是 executor 内部旗标（不进 schema/描述），
不进快照。

## 3. 为什么必须变

- 本批目标 = 让模型**看见窗口**（`desktop_uia_window_shot` 的输出进附图通道）。
  模型必须知道「图会自动进上下文」才可能不把 PNG 路径甩给用户；
  全屏截图默认不接图是隐私决策，必须在参数面与描述里写清（否则模型无从得知开关存在）。
- 工具面增量 = **1 个可选参数**（`attach_image`），不新增动作、不新增域。

## 4. 证据

- 漂移仅两处快照文件；报告 `src-ui/tests/convergence/reports/check-2026-11-22T04-30-00-601Z.md`
  显示唯一差异是 `automation_id` → `attach_image` 的键序与描述文本（第 1132-1135 行）；
- 代码面：`src-ui/src/plugins/builtin/browser-desktop-domain/browser.ts`（schema + 两条描述 +
  `uiaCapTool` 的 imageChannel 声明）、`src-tauri/src/commands/uia_cap.rs`（`attach_shot_ref` 转存）、
  `src-tauri/src/uia/{shot,mod}.rs`（`shot_dir` 单一真源）；
- 生成物同步：`npm run gen:tool-contract` 已重写 `docs/agents/model-tool-contract.md`；
- 新增/更新测试：Rust `commands::uia_cap::tests::*`（5 例：白名单 / 字节嗅探 / 参数缺省 / 上限）、
  TS `tests/desktop-tools.test.ts`（2 例：imageChannel 只挂窗口截图、attach_image 参数存在）；
- 已绿：`cargo check`、`cargo test --bins uia_cap`（8/8）、
  `vitest run tests/desktop-tools.test.ts tests/desktop-uia-new-actions.test.ts`（27/27）。

## 5. 拟议变更

采纳 record 生成的新快照（full + plan 两份），其余快照零变化。

## 6. 落地步骤

1. ✅ Rust 侧转存（`attach_shot_ref` / `load_shot` / `is_shot_path` / `shot_dir`）
2. ✅ TS 侧 schema + 描述 + `imageChannel`
3. ✅ 契约文档重生成 + 测试
4. ⬜ 用户批准本申请 → `record` 刷新两份 phase-0 快照
5. ⬜ 复跑 `verify:convergence`（standard + minimal）全绿 → 提交批 1

## 7. 后续批次预告（同源漂移）

批 2（坐标 `x`/`y` 参数）、批 3（新动作 `desktop_uia_batch`）、批 4（`anchors` 参数）
都会各自带来一次 baseline 漂移，按计划 §6 每批各写一份申请文件。
