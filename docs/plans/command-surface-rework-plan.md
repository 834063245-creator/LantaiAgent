# 斜杠命令面重做（command-surface-rework）

> 触发：2026-09-19 用户报「斜杠命令退役的功能没删除、新加的能力没加入——这块需要重做了」。
> 状态：**已落地**（代码 + 门禁全绿）。契约面 v41 → **v42**。

## 结论一句话

斜杠命令的唯一真源 = `ctx.commands` 贡献通道；`/` 内联面板与 Ctrl+K 命令面板消费**同一份
合流清单**（`src/app/commands/command-catalog.ts` = 会话内建 + 通道贡献 + 技能候选）。
旧 `src/ui/command-registry.ts`（模块级单例 + 13 条裸表 + `_wireCommandHandlers` 就地写 handler）
整文件退役，chat-core 里的 slash/@/trail 三套死注册槽一并拆净。

## 病灶（审计取证，2026-09-19）

| # | 病灶 | 证据 |
|---|---|---|
| 1 | **两套命令面互不相通**：旧注册表只喂 `/` 面板，`ctx.commands` 只喂 Ctrl+K | `ComposerDock.tsx` 读 `CommandRegistry.instance.getAll()`；`CommandPalette.tsx` 读 `activeCommandContributions()` |
| 2 | **退役功能仍陈列**：`/trail` 点了没反应（handler 链到 `_onTrailToggle`，全仓零注册方）；`/fragile` `/cycle` `/impact` `/path` 把空话发给模型（应用内图工具面 2026-09-09 整量退役） | `command-registry.ts:141-197`；`grep setOnTrailToggle` = 仅定义处 |
| 3 | **新能力进不来**：面板/画布类命令（`/settings` `/paper` `/sidebar` `/dock`）只在 Ctrl+K | 四条贡献的 `shortcut` 全在 `ctx.commands` 侧 |
| 4 | **全局表就地 mutate**：`_wireCommandHandlers()` 把实例 handler 写进模块级 `DEFAULT_COMMANDS`（多面板互相覆盖的形状，INVARIANTS #1 家族） | `chat-core.ts` 旧 1813-1859 |
| 5 | **字段一名两义**：`shortcut` 同时装 `'/dock'`（斜杠词）与 `'ctrl P'`（键位）——命令面板把键位当命令陈列、斜杠面板把斜杠词当快捷键显示 | `services.ts` 旧 `CommandContribution` |
| 6 | **带参命令硬编码**：`/remember <事实>` `/goal <子命令>` 在 `sendMessage` 里前置于注册表解析（注册表里那两条永远不可达） | `chat-core.ts` 旧 1318-1349 |
| 7 | **死注册槽**：`SlashPanelHandle` / `AtAutocompleteHandle` / `_onTrailToggle` 三套（自注「V5 拆除后无注册方」） | `chat-core.ts` 旧 75-113 |

## 裁定（我的判断，留痕备翻案）

1. **真源唯一**：命令一律经 `ctx.commands` 贡献或会话内建表；合流点是一个纯函数模块，两个面板
   只差过滤（`/` 触发只列有斜杠触发词的条目，翰/Ctrl+K 列全量）。
2. **不新建插件产物**：会话内建命令（`/new` `/compact` `/export` `/goal` `/memory` `/remember`
   `/compact-stats`）是**核心能力不是可禁用特性**，由 `ChatCore.builtinCommands()` 提供（handler 绑
   本卷实例）——比塞进可禁用的 feature 产物更对；也避免新增产物四处登记 + 计数漂移。
3. **字段分家**：`slash?`（斜杠触发词）与 `kbd?`（键位提示，仅展示）。缺省两者 = 只进 Ctrl+K。
4. **参数走目录**：`local.handler(arg)`；`parseSlashInput` 拆「命令词 + 参数」，发送面只做一次解析。
5. **删而不留**：死槽、退役命令、旧注册表全部删除，不写 deprecated 兼容层（CLAUDE.md 破坏性授权）。

## 行为变更（用户可感知）

- **`/` 面板新增**：`/settings` `/paper` `/sidebar` `/dock`（此前只在 Ctrl+K 里）。
- **`/` 面板移除**：`/trail`（点了没反应）、`/fragile` `/cycle` `/impact` `/path`（图分析面已退役）。
- **Ctrl+K 面板新增**：会话内建命令（`/new` `/compact` `/export` `/goal` `/memory` `/remember`）——
  与 `/` 面板同一执行面。
- **`/remember` 无参**：从「报用法后清空输入」改为「填好 `/remember ` 前缀并提示用法」（少一次手打）。
- **`/goal`**：`/goal` 与 `/goal status` 等价（无参即查状态）。
- **技能提示文本**：`/memory` `/remember` 让模型用的工具名改为域工具写法（`memory(action="list"/"save")`）。
- **第三方插件**：命令贡献必须把 `shortcut` 改名为 `slash`（旧名不留别名）——契约 v42。

## 落地批次

| 批 | 内容 |
|---|---|
| P1 | `CommandContribution` 形状（slash/kbd + 具名 `CommandAction` + handler 收参）；四条贡献适配并补斜杠词 |
| P2 | 新建 `app/commands/command-catalog.ts`（合流/过滤/查找/解析）与 `skill-catalog.ts`（技能候选从 chat-core 迁出、工作区路径键控） |
| P3 | ChatCore：`builtinCommands()` + 能力位（`compactSession` / `exportSession` 公开 / `goalCommand` / `rememberFact`）；`sendMessage` 斜杠解析统一；`ComposerDock` / `CommandPalette` 消费合流清单 |
| P4 | 删除 `ui/command-registry.ts` + chat-core 三套死槽；插件宿主桥出口换新（`host.ts` / `host.aliased.ts` / `host-modules.ts`） |
| P5 | 契约 v42 四步（版本 / 变更记录 / 指纹）；测试：既有断言零改动、注入通道换内建命令位；新增 `tests/command-surface.test.tsx` 18 例 |

## 验证

- `npx vitest run`（受影响面 + 新增 18 例全绿；既有 composer-dock / composition-services /
  plugin-loader 断言**零改动**——只换注入通道，行为未变的最强证据）
- `npm run build` / `npx biome ci .` / `npm run verify:convergence` / `npm run doc-sync` / `npm run doc-check`
