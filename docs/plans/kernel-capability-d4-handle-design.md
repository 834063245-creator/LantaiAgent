# D4 句柄域收敛接口设计件（browser/uia）——R4 执行蓝本

> 状态：**定稿（agent 裁定，2026-09-05）**。上游：c3 §5（句柄域边界——「每会话类型
> 一能力口 + 参数化操作，不是每工具一接口」）+ v3 §4 域归属终态 + §5 执行序 R4 行。
> 自查模式产出：本文全部设计断言已对代码库逐条验证（§7 自查清单），
> 勘察发现的偏差以「⚠ 勘察修正」标注。

## 0. 裁定表（agent 落款，无待拍板项）

| # | 决策点 | 裁定 |
|---|---|---|
| D4-1 | 接口粒度 | **action 化（git_cap 同构）**：`browser_cap {action, ...}`（action = 37 工具名）、`uia_cap {action, ...}`（action = 17 工具名）。不收敛操作组 |
| D4-2 | 编排/能力边界 | 句柄层（CDP 会话注册表/wire/COM worker/lease/grant/审计/敏感词表）**全留口内**；回 TS 的只有参数拼装与结果整形（已在 TS）——snapshot 解析/audit 组装/tree 分页**不迁**（见 D4-3） |
| D4-3 | 分页与报告 | 树分页（uia offset/max_results）与 snapshot 分页**留在源**（COM worker/CDP 会话内截取）：迁 TS = 全树过 IPC，性能回归 + 零行为收益。audit 报表从 Rust 审计环组装——审计落盘是 v3 §2 明文保留的强制层面，**不迁** |
| D4-4 | 口内闸形态 | **不构造 PluginToolAdapter**——直接构造 `BrowserTool`/`DesktopTool` 调 `crate::utils::check_permission`（插件原路径同款；比 git_cap 的 adapter 构造更直接）。⚠ 与 git_cap 的差异及理由见 §4 |
| D4-5 | 过闸时机 | **无条件过闸**（不按 is_agent 分流）——插件原语义就是 Agent/用户路径都过闸（BrowserTool/DesktopTool 自带 agent_id，Ask 链路两态通用）。⚠ 与 git_cap 的 is_agent 门差异见 §4 |
| D4-6 | 参数键语言 | 口收**顶层 snake**（能力口统一契约）；TS 工具面键不变（manifest 语言：browser camelCase / desktop snake_case），execute 层做 camel→snake 顶层映射（R3-b fs 先例；11 键表见 §5） |
| D4-7 | meta 双键 | `agent_id` 显式键或 `_agent_id`/`_owner_id` meta 兼容读取（rpc.rs 三口先例同一行式）；`_callId` 对 browser/uia 无消费（两插件零 emit_progress），不进契约 |
| D4-8 | 返回形状 | **Text**（git_cap 同判：字节精确优先；37+17 action 全部返回字符串——插件 text() 直通的原文语义） |
| D4-9 | 事件面 | **零事件**（勘察证实 cdp/uia 模块零 emit 调用；permission-ask 由权限引擎统一发射，形状不动） |
| D4-10 | self 路由 | `target="self"` 判别与 self 只读拒绝语义**原样迁口内**（self_or_agent/is_self 逻辑逐行为迁） |
| D4-11 | 内部消费 | browser/uia **无信封内部消费**（勘察证实：TS 侧唯一消费 = browser.ts 工具面 + browser-desktop-domain 一行贡献 + domains.ts 动作名映射；Rust 侧无内部消费）——退役 = 模型族换轨即净 |
| D4-12 | 退役序 | 批 1 立口（插件在册，execute 委托口内实现——单一实现零双份）→ 批 2 browser 模型族 zod + 直呼 + builtin.browser 整目录退役 → 批 3 uia 同型 |

## 1. 侦察事实（全部已验证）

- **插件本体是薄编排**：`tool_plugins/browser/mod.rs`（595 行）= 37 个业务函数，
  每个 = 权限自检（`BrowserTool{action}` 过闸）+ 参数提取 + `crate::cdp::cdp_*`
  直调 + `text()` 返回。`tool_plugins/uia/mod.rs`（534 行）同型，外加
  `desktop_uia_write` 的 resolve→classify→grant→lease→exec→audit 全链。
- **真实现（句柄层）全在插件外**：cdp/（session.rs 会话注册表 + transport +
  actions + AUDIT 审计环，1931+2076 行）、uia/（worker.rs 专用线程 + com.rs
  COM + grants.rs 租约 + cache.rs，2521 行）、desktop.rs、sensitive.rs。
  这些**不动**——能力口只是换了个调用它们的壳。
- **权限形状**：browser/uia manifest **零 permission 声明**（两插件单测钉死
  §8 裁决）→ dispatch 侧 adapter 恒 Passthrough → `plugin:builtin.browser.*`
  精确规则寻址面**从未存在**（与 git 不同）——唯一权限面 = 插件内
  BrowserTool（"Browser" 家族 deny > allow > 只读放行 > attach 后页内放行 >
  高危 Ask）+ DesktopTool（六层）+ click_sensitive/type_sensitive 运行时二次
  Ask（check_sensitive，ADR 0003 D6 L3）+ uia resolve→classify→grant→lease。
  **全部单键 adapter 表达不了 → 全走口内业务自检**（shell/browser 先例形状）。
- **TS 消费面**：browser.ts = `browserManifestTool`/`desktopManifestTool`
  （schema = manifest 字节，execute → `agentInvoke('tool_call', {plugin, tool,
  args})` 信封）+ 3 个复合工具（browser_fill / browser_navigate_snapshot /
  desktop_uia_fill，**已是 zod**，逐字段调细粒度动作）+ 结果整形
  （truncate 8000 + parseStructuredError）。信封 args 是嵌套键不经 bridge
  转换——这是现状 browser 键保持 camelCase 的原因；直呼后改顶层显式映射。
- **事件面**：`grep -rn "\.emit(" cdp/ uia/` = 零命中。浏览器/pty/lsp 事件
  通道在 pty 域（批 4 处置），browser/uia 域无事件面。
- **INVARIANTS #13 面**：worker.rs request 通道 / grants.rs
  acquire_input_lease / com.rs 物理路径——本设计**零触碰**（uia_port 业务函数
  原样调用 crate::uia 同一组公开函数；COM 不跨线程语义不变）。

## 2. 能力口形状

```
browser_cap { action, ...params, is_agent, agent_id? }  → Text
uia_cap     { action, ...params, is_agent, agent_id? }  → Text
```

- action ∈ 退役前插件工具名（37 / 17 一一位）——模型面契约字节不变，
  测试三命运纪律下工具面零改动。
- params 与 action 同层顶层传递（**不做嵌套 args 袋**）：37×17 参数异构
  （windowSize 对象 / urls 数组 / modifiers 数组…），Rust 侧若逐参数具名
  解构要 60+ 形参——fs_cap 8 参数具名形状在此不成立。裁定：口函数签名收
  `params: serde_json::Value` + action，口内按 action 提取（键语言仍顶层
  snake 契约，helper = tool_plugins::plugin::arg_str 同款）。这是对 fs/git
  具名形状的**显式偏离**，理由：参数面宽度（60+ 形参不可维护）+ action
  分派函数内部本就要逐 action 提取。
- rpc.rs 分支：`req_str(action)` + `params.clone()` 直传 + is_agent +
  agent_id（`opt_str("agent_id").or(_agent_id)` 三口同款行式）。
- rpc_result_shape：两口均 Text。

## 3. 边界裁定明细（回 TS / 留口清单）

**留口内（永久）**：
- CDP 会话注册表、wire transport、launch/connect/attach 生命周期。
- UIA worker 线程 + COM（INVARIANTS #13）+ 控件缓存 + probe_route。
- 输入租约 acquire_input_lease + 窗口 grant（has_grant/grant/list_grants）。
- classify_uia_action / uia_action_needs_physical / sensitive 词表
  （check_sensitive）——权限分类是强制层判定，非编排。
- 逐动作审计（desktop_audit_log/desktop_audit_query + cdp AUDIT 环 +
  审计文件落盘）——v3 §2 强制层审计保留项。
- resolve（只读解析，写动作分类前置）。
- 参数物理校验（端口界 / windowSize 界 / u32 截断）。

**回 TS（本次换轨）**：
- schema 真源：54 工具 zod 转录（BROWSER_CAP_SCHEMA 37 + UIA_CAP_SCHEMA 17，
  三域先例逐字节范式）。
- execute 通道：信封 → browser_cap/uia_cap 直呼（顶层 camel→snake 映射 +
  meta 透传）。
- 结果整形（truncate / 结构化错误 / 分页提示）——已在 TS，不动。

**不迁（勘察修正——批序假设里三项的核实结论）**：
- snapshot 解析：cdp_snapshot 的树渲染在会话层源内完成，输出即文本；
  「解析回 TS」无对象可迁。
- audit 报告组装：审计环/文件在 Rust（强制层），组装随环走。
- tree 分页：分页在 COM worker 源内截取（INVARIANTS #13 线程边界决定了
  全树无法廉价出线程）——迁 TS = 全树序列化过 IPC，纯负收益。

## 4. 口内闸形态（与 git_cap 两处差异的理由）

git_cap 口内闸 = Agent 路径构造 PluginToolAdapter（is_agent 门 + 精确名
寻址 + 家族回退）。browser/uia 口不沿用该形状，理由（两条均已核实）：

1. **无精确名寻址面**：manifest 零 permission 声明 → dispatch adapter 恒
   Passthrough → `plugin:builtin.browser.*` 规则从未存在，无需保留寻址名。
   直接构造 `BrowserTool{action, agent_id}` / `DesktopTool{action, agent_id,
   hwnd, window_title}`（TypedTool 结构，`name()` = "Browser"/"Desktop"
   家族名）调 `crate::utils::check_permission`——与插件内
   `ToolContext::check_permission` 同一条路径（该函数就是
   `get_ctx(state)` + `check_permission(tool, &perm_ctx, app)`）。
2. **无条件过闸**：插件业务函数的 check_permission 不分流 is_agent
   （browser_launch/disdesktop_probe 等全部如此）——用户路径同样过规则与
   Ask。git_cap 的 is_agent 门是 dispatch adapter 语义的复刻；browser/uia
   的闸本来就在业务内、两态通用。口内保持原语义（行为零漂移优先），
   Agent/用户路径都过闸。

敏感二次闸（click_sensitive/type_sensitive）与 uia 全链（resolve→classify→
grant→lease）留在口内业务函数内——它们是同一业务函数的组成部分，不拆。

## 5. 键语言映射表（browser camelCase → 口 snake；TS execute 层消费）

| 工具面键（camelCase） | 口键（snake） |
|---|---|
| windowSize | window_size |
| proxyBypass | proxy_bypass |
| httpOnly | http_only |
| sameSite | same_site |
| targetId | target_id |
| maxResults | max_results |
| maxChars | max_chars |
| requestId | request_id |
| fullPage | full_page |
| deviceScaleFactor | device_scale_factor |
| promptText | prompt_text |

（uia 面键本就是 snake_case——直呼幂等零映射。单词小写键 target/scope/
selector/value/limit/offset/port/url/… 转换正则不命中，天然不动。）
meta：`_agent_id`/`_owner_id` 已是 snake，bridge.rpc() 转换幂等原样到达。

## 6. 批序与验收（= v3 §5 R4 行分解）

| 批 | 内容 | 验收 |
|---|---|---|
| R4-1 | D4 设计件（本件）+ browser_cap 口建立（业务函数自插件迁入为单一实现，插件 execute 委托口内——不退役）+ rpc.rs 分支/shape + platform_boundary + 口内 action 表单测 | cargo 全绿；插件行为零漂移（委托 = 同一实现） |
| R4-2 | browser 模型族 37 工具 zod 转录 + browser_cap 直呼（camel→snake 表）+ builtin.browser 整目录退役 + 生成物（kernel-manifests.generated / gen-kernel-manifest browser DOMAIN / frontend-rpc-contract.md）+ rpc-contract 契约 + 测试换轨 | vitest + convergence 双档 + biome + build + doc-sync 全绿；cargo 全绿 |
| R4-3 | uia_cap 口 + uia 换轨 + 17 工具 zod + builtin.uia 整目录退役 + 生成物 + 测试换轨 | 同 R4-2 |
| R4-4 | 小面清偿（web/editor/constraints/pty/lsp 立口换轨或落账余量） | 按容量如实落账 |
| R4-5 | R5 可先行部分 + v3/c3 执行序勾销落账 | — |

## 7. 自查清单（设计断言 × 代码验证）

| 断言 | 验证 |
|---|---|
| cdp/uia 零事件发射 | grep `\.emit(` cdp/ uia/ = 0 命中 |
| manifest 零 permission（无精确名面） | 两插件单测 `permission 必须为 None` + dispatch 注释「未声明的保持 v1 Passthrough」 |
| 插件过闸无条件（不分 is_agent） | browser_check/desktop_check 逐函数核对，无 is_agent 分支 |
| TS 唯一消费面 = browser.ts | grep builtin.browser/builtin.uia 全仓 = browser.ts + kernel-manifests.generated + browser-desktop-domain + 4 测试文件 |
| 复合工具已是 zod | browser.ts browser_fill/navigate_snapshot/desktop_uia_fill 三处 defineTool |
| 域工具（browser(...)/desktop(...)）按名分派经 Tool.execute | domains.ts convergeRegistry/createDomainTools——execute 换轨对域层透明 |
| bridge 转换幂等 | 已是 snake 的键不命中 `([a-z])([A-Z])`（三口先例同一行式在产） |
| 信封嵌套键不经 bridge（现状 camel 得以幸存的原因） | dispatch_tool_call 注释 + envelopeCall args 嵌套 |
| ToolContext.check_permission = get_ctx + check_permission | tool_plugins/plugin.rs:52-56 与 utils/path_resolve.rs:130 同路径 |
| agentInvoke 恒注 isAgent（→ is_agent） | agent/tool.ts:189-193 |
