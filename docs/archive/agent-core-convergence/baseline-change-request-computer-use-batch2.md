# Baseline 变更申请 — phase-0/tool-schemas.{full,plan}.json（批 2：坐标动作一等化）

> 申请日期：2026-11-22 · 申请人：编码助手（computer use 四批计划 批 2 / P0-2）
> 状态：**已批准**（2026-11-22 用户会话内批准"baseline 申请通过"）——record 已执行。
> 关联计划：`.lantai/plans/plan-1795321025508-cc89.md`

## 1. 变更对象

- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.full.json`
- `src-ui/tests/convergence/baseline/phase-0/tool-schemas.plan.json`

## 2. 漂移内容（逐项，均来自本批改动）

| # | 变更 | 模型可见后果 |
|---|---|---|
| 1 | `desktop_uia_click` 新增可选 `x` / `y`（整数，屏幕虚拟坐标） | 模型知道可以按坐标点（自绘界面的唯一路径），且知道「坐标须落在目标窗口内、先用 window_shot 确认」 |
| 2 | `desktop_uia_right_click` 新增可选 `x` / `y` | 同上（右键在自绘界面上开上下文菜单） |
| 3 | `desktop_uia_scroll` 新增可选 `x` / `y` | 滚轮可瞄准任意点（自绘列表/画布） |
| 4 | 三条动作描述改写（`desktop_uia_click` 双模式 + 权限新语义；`right_click` / `scroll` 同步） | 描述字节变化（click 约 +700 字符） |
| 5 | `desktop` 域描述改写（坐标模式 + 接管后放行 + 敏感/热键/抢前台例外；自绘应用指引改为「看图 → 按坐标点」） | 域描述字节变化（约 +250 字符） |

**不在本批的模型可见变化**：无。`click_at` / `right_click_at` / `scroll_at` 是**内部 action 名**
（权限分层用），不出现在工具面；`uia_physical_granted` 同理。

## 3. 为什么必须变

- 批 2 的目标是「自绘应用点得动」。模型原本**没有按坐标定位的入口**（`uia_click` 只认
  ref/selector），必须把 x/y 暴露到 schema 并说明口径（屏幕虚拟坐标，与 `rect` 同源）。
- 权限语义变了（接管窗口内物理路径不再逐次 Ask），域描述必须写实，否则模型会在旧语义下
  选择行为（例如为规避审批而绕路）。

## 4. 证据

- 代码面：`uia/worker.rs`（`ClickAt` / `ScrollAt` 两个请求变体）、`uia/com.rs`
  （`req_click_at` / `req_scroll_at` / `window_rect_of` / `ensure_point_in_window`——坐标必须落在
  窗口矩形内）、`uia/mod.rs`（`window_info` / `uia_click_at` / `uia_scroll_at`）、
  `commands/uia_cap.rs`（`desktop_uia_write_at` + x/y 分支 + `opt_i32_of`）、
  `tools/mod.rs`（坐标分支进 `uia_action_needs_physical`；`uia_physical_granted` 分层）、
  `browser.ts`（三处 schema + 三条描述）、`domains.ts`（域描述）；
- 生成物：`npm run gen:tool-contract` 已重写 `docs/agents/model-tool-contract.md`；
- 测试：`cargo test --bins desktop` —— 分类矩阵新增坐标三态（已接管放行 / 未接管 Ask /
  kill switch 关闭回 Ask）全绿；`vitest tests/desktop-tools.test.ts tests/desktop-uia-new-actions.test.ts` 27/27 绿；
- 安全边界（代码强制）：坐标必须落在目标窗口矩形内，否则 `ARG_INVALID` 并提示重新确认窗口位置；
  敏感目标与 `uia_keys` / `uia_activate` 永远每次 Ask（不受本批影响）。

## 5. 拟议变更

采纳 record 生成的新快照（full + plan 两份），其余快照零变化。

## 6. 落地步骤

1. ✅ worker/com/mod 坐标原语 + rect 校验
2. ✅ 能力口坐标分支（窗口定位 → 分类 → 过闸 → 批准即接管 → 租约 → 执行 → 审计）
3. ✅ TS schema/描述 + 域描述
4. ⬜ 用户批准本申请 → `record` 刷新两份 phase-0 快照
5. ⬜ 复跑 `verify:convergence`（standard + minimal）全绿
