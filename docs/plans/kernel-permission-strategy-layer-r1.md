# R1 —— TS 权限策略层：复用现状 + 收拢双份名单（设计件 + 拍板记录）

> 状态：**定稿**（2026-09-04，R1 拍板）。锚：kernel-plugin-architecture-decision.md v3
> （TS 策略建议层 + Rust 能力口强制层的双层安全模型）。
> 本文件 = R1 设计 + 裁决记录。审过即开 R2 代码。

## 0. R1 拍板（用户 2026-09-04）

**形态 = 选项 A：复用现状 + 收拢双份名单，不做 Claude Code 四层重写。**

- 保留 `.lantai/permissions.json` 三段式（deny/ask/allow）+ 家族规则语义 +
  现有 Ask/remember 链路 + PromptShelf 卡片 + mode 三档（ask/auto/yolo）。
- TS 策略层 = 现有 frontend Ask 生态的**逻辑补全**，不是新引擎：
  把散在两端的分身（白名单、危险规则、suggestion 生成、匹配语义）收成单一真源。
- 范围 = 尽量推进代码级（用户：尽量多干少人工，实机验证按需）。

为什么不是 B（Claude Code 分层）：
1. 现状不是雏形——Ask/remember/规则三段式/模式已是产线链路（bridges.ts 事件桥 +
   PromptShelf 卡片 + mode-store 真源 + permissions.json 落盘往返），复用 = 拆旧不造新
   （AGENTS.md 默认值）。
2. 兰台强制层在 Rust 能力口，TS 策略层只需「建议/体验」语义——Claude Code 四层
   堆叠/八层 source/参数通配是它在 Node 直碰模型下把表达力全压规则层的结果；
   兰台的物理最后闸不依赖 TS 规则完备。
3. 重写 = 现有用户规则文件迁移 + Ask UI 交互重做 + mode 五档语义改——代价大、收益
   在兰台双层模型下被能力口兜住。

## 1. 现状事实（勘察核实，本设计的事实基础）

### 1.1 权限裁决编排在 Rust（v3 要迁 TS 的部分）

`src-tauri/src/permissions/`：

- **规则模型 rule.rs**：`PermissionRule { source: System|Project|User|Session, behavior:
  Allow|Deny|Ask, value: RuleValue{tool_name, content} }`。工具名 PascalCase 家族
  （"Bash"/"Read"/"Edit"/"Git"/"WebFetch"）+ 可选 `Tool(content)` 内容。匹配三条腿：
  `:*` 前缀 / glob（`src/**`，含路径边界语义）/ 子串。`RuleSource::User` 已声明
  **但无用户级文件加载路径**（注释 "for user-level rules in future"）——占位。
- **中央裁决 mod.rs `has_permission_to_use_tool`**：六步编排——① 工具级 deny（精确名
  `plugin:<id>.<tool>` → 家族回退两级）→ ② 工具级 ask → ③ 工具自检
  `check_permissions`（Tool trait，各家族自己判定）→ ④ 模式 → ⑤ 裸 Allow → ⑥
  Passthrough→Allow。**这六步是「策略」逻辑，v3 归 TS。**
- 系统规则（load_system_rules）：写死的 deny 表（`.lantai/permissions.json`、
  `.git/config`、`~/.ssh/authorized_keys`…）+ ask 表（git push/commit/checkout…）+
  danger 表（`rm -rf /*`=ForceRecursiveRoot 等）——**在 Rust 编译期内置**。
- 模式镜像：`PERMISSION_MODE` AtomicU8（ask/auto/yolo），真源在 TS mode-store，Rust
  只镜像供后台同步路径旁路。auto 白名单 `auto_mode_allows` = {Edit}。
- Ask oneshot 通道：register_ask/resolve_ask/remove_ask + PENDING_ASKS map。

### 1.2 执行路径接缝（Rust 权限引擎挂在哪些执行面上）

- `tool_plugins/mod.rs dispatch_tool_call`：仅 Agent 链路过闸——
  `PluginToolAdapter::build(...)` → `check_permission(...)`（六步）；UI 路径零规则。
- `utils/path_resolve.rs`：`require_read/require_write`（async，Agent 过 Ask+规则）、
  `resolve_read/write_dispatch`（is_agent 分流：Agent→require_*，UI→只解析）、
  `check_permission_sync`（后台同步路径，无法等前端弹窗：yolo 放行 / auto 白名单放行 /
  其余拒绝）+ `require_read_sync`。confined_fs / fs 插件 / shell 插件消费。
- 工具自检 Tool trait：家族 Bash/Read/Edit/Git/WebFetch 各自主判（bash.rs/filesystem.rs/
  git.rs/web.rs），**其中既有策略（危险命令表、git 子命令规则、路径判定）又有物理
  判定（sandbox）**。

### 1.3 TS 侧现状（Ask 生态 = 承接面，非规则引擎）

- `state/ask-store.ts`：ask_user 模型提问队列（每会话队列 + 归属上溯）。**与权限
  Ask 无关**——权限卡片经 `permission-ask` 事件桥。
- `shell/rows/bridges.ts bootBridges`：`typedListen('permission-ask')` → 前端先按本地
  mode 短路（yolo 全放 / auto+白名单 {Edit} 放行）→ 弹 PromptShelf 权限卡 → 回
  `permission_ask_response`（allow + remember→rule_to_add/rule_behavior）。
  **`AUTO_WHITELIST = {'Edit'}` 与 Rust `auto_mode_allows` 双份镜像（两端各自一份）。**
- `app/chat/PromptShelf.tsx`：Ask/AskBatch/Permission 三卡。Permission 卡 = 三键
  （本卷均准=remember / 落印准此 / 驳回）+ danger 红卡 + Esc/Enter 键。suggestions 来自
  Rust 侧 Ask payload。
- `state/mode-store.ts`：mode 单一真相（ask/auto/yolo 三档），切换 = 写 store + 镜像
  Rust `set_permission_mode` + 落盘 settings（下次启动水合）。
- `commands/identity.rs permission_ask_response`：remember → `add_session_rule`
  （**会话级**，跨重启消失）。项目级 `append_project_rule`（写 permissions.json）是
  **dead_code（API ready, not yet called）**——「本卷均准」文案与 Session 语义一致，
  尚无「永久记忆」入口。

### 1.4 双份名单/逻辑分身清单（R1 收拢对象）

| # | 分身 | Rust 侧 | TS 侧 | R1 收拢去向 |
|---|---|---|---|---|
| 1 | auto 白名单 | permissions::auto_mode_allows = {Edit} | bridges.ts AUTO_WHITELIST = {Edit} | TS 单真源，Rust 经能力口授权语义化 |
| 2 | 系统规则表（deny/ask/danger） | rule.rs load_system_rules（编译期） | 无 | TS 策略层规则文件（出厂段） |
| 3 | danger 标签 | rule.rs danger + bash.rs::check | PromptShelf 红卡消费 | TS 侧规则携带，透传渲染 |
| 4 | suggestion 生成 | has_permission 六步 ② + 工具自检 | bridges 取 suggestions[0] | TS 裁决器生成 |
| 5 | mode 三档语义 | AtomicU8 镜像（旁路判定） | mode-store 真源 | 真源留 TS；Rust 只保留「sync 路径旁路」镜像（见 §4） |

## 2. R1 做什么（代码级），不做什么

### 做
1. **收拢 auto 白名单为 TS 单真源**（最小、可独立验证的 R1 落地）：
   - TS：把散在 `bridges.ts` 的 AUTO_WHITELIST 与 `mode-store` 的旁路语义抽成
     `state/permission-policy.ts`（或 `agent/permission/` 下的策略模块）单一真源：
     白名单定义 + `autoAllows(tool)` 判定 + 说明注释（真源位置锚）。
   - Rust：`auto_mode_allows` 的「名单」退役为**语义**——能力口不再按工具名判
     auto，改由 TS 策略层把 auto 裁决结果随授权票据带给能力口（R3 票据化后闭环）。
     本批先停用 Rust 名单判定入口（见 §4 依赖序）。
2. **收拢系统规则与 danger/suggestion 数据面**（设计 + 轻量落地）：
   - 把 load_system_rules 的表**以出厂规则文件形态**迁移 TS（首个真源文件），
     Rust 侧对出厂段的消费改为「接受 TS 下发」或随 R3 能力口收窄。
   - danger 标签、suggestion 生成收进 TS 裁决器（v3 终态），PromptShelf 消费面不动。
3. **规则文件语义补全**（谨慎，见 §5）：补 `RuleSource::User` 的对应文件加载？
   —— R1 先只做**设计定格**，不落加载代码（属于 R3「TS 策略闸接管权限」主批）。
4. **测试**：TS 侧策略模块单测（白名单/旁路/危险判定收拢后行为等价）；既有
   permissions.json 读/写/往返测试在 Rust 侧**先不动**（R3 才迁）——R1 不能留红门禁。

### 不做
- 不改 permissions.json 三段式文件格式与既有用户规则语义（兼容保留——用户资产）。
- 不重写 Ask 卡片 UI / 不引入 mode 四档五档。
- 不动 Rust 六步裁决的执行序（那是 R3 迁移主批）；R1 只收「策略数据面」分身，
  物理强制（sandbox/resolve/canonical）一律不动。
- 不引入 Claude Code 的 source 八层 / toolMatchesRule 参数通配（记录为待定，见 §6）。

## 3. 目标：R1 收口后的分工

```
TS 权限策略层（R1 收口，建议/体验）：
  permission-policy.ts   —— auto 白名单单真源 + autoAllows()  + 旁路语义（yolo/auto）
  system-rules（出厂）     —— deny/ask/danger 表单一真源（自 load_system_rules 迁入）
  rule 匹配语义           —— glob/前缀/子串（迁 TS；Rust 同名实现退役随 R3）
  danger/suggestion      —— 策略层生成，UI 透传渲染
  Ask UI / remember      —— PromptShelf 三键 + permission_ask_response（链路原样）
  mode-store             —— ask/auto/yolo 真源（原样）

Rust 能力口（保留 = 物理强制，v3 §3）：
  sandbox resolve / canonical / 物理边界  —— 原样
  已授权校验 + 审计落盘                    —— 原样（授权来源随 R3 票据化）
  sync 后台旁路镜像                        —— 过渡保留，R3 改为吃 TS 票据
```

**双份名单消除的验证点**：`grep AUTO_WHITELIST` 只命中一处；`auto_mode_allows` 不再
被 Agent 路径消费（或已删）。

## 4. 依赖序（为什么 R1 只做数据面，不做裁决迁移）

R1 收「策略数据面」（白名单/系统规则/danger/suggestion 的真源归 TS）**不需要**先动
执行序：TS 侧真源与 Rust 侧当前实现共存一个过渡窗（真源在 TS，Rust 按旧逻辑跑——
行为等价由测试盯）。但**「TS 裁决器接管六步」本身必须等 R2 把薄域编排送回 TS**
（编排在 TS 才能在同进程内先过策略闸，再走能力口）——所以六步裁决迁移排 R3 主批，
R1 落真源 + 文档契约，R2 落薄域试点（search/web 编排回 TS），R3 落闸。

## 5. 风险与缓释

- **行为等价**：R1 收拢白名单时 Rust 侧若先删 auto_mode_allows，auto 模式会短暂
  双份不一致 → 缓释：R1 只「加 TS 真源 + 停用 Rust 名单的 Agent 消费点」，判定结果
  以 TS 为准（bridges 短路已先行）；Rust 侧名单保留到 R3 与六步裁决一起退役，
  期间以守卫测试盯两侧一致。
- **remember 语义**：现「本卷均准」= Session 规则（跨重启消失），append_project_rule
  dead_code。R1 不新增「永久」入口；产品若要永久记忆，R3 再开（新增 UI 键 + 落盘
  permissions.json），先记录。
- **出厂规则迁 TS 后 Rust 六步裁决仍读 Rust 规则**（双份系统表过渡）→ 缓释：出厂表
  是编译期常量且本窗不动；R1 只把「同一份表」镜像成 TS 真源文件，等 R3 裁决迁移时
  Rust 读 TS 下发，不提前拆。

## 6. 待定（非 R1 阻塞，R3/R5 前定）

- 是否需要 `RuleSource::User` 用户级规则文件（`~/.lantai/`）——现只有 Project 级
  `.lantai/permissions.json` + Session。Claude Code 四层里的 user/policy 在兰台哪个
  落点（用户机器级 vs 项目级 vs 策略内置）。
- 参数内容通配（toolMatchesRule 参数级）要不要——R1 记录：兰台能力口在 Rust，
  TS 规则到参数级匹配的边际收益低，倾向不做，R3 复核。
- 「永久记忆」入口（remember → permissions.json 而非 Session）——产品决策，R3 前定。
- 物理沙箱形态核验（os_sandbox read-only/workspace-write 两档承诺）——R2 起核。

## 7. 测试与门禁

- R1 新增：TS 策略模块单测（白名单真源、autoAllows 语义、危险判定数据面、出厂规则
  表与现系统规则等价对拍）。
- 门禁：`cd src-ui && npx vitest run` + `npm run build` + `biome ci`；改动不触 Rust
  生产路径时壳 cargo 快验（`cargo check`）即可；触 Rust 名单则 `cargo test`。
- R1 不动权限行为 → 无用户可感知行为变更；若改了 mode/auto 判定路径，commit message
  写明。

## 8. 本批 commit 清单（草案）

1. `docs(plans): R1 拍板 + 设计——TS 权限策略层复用现状、收拢双份名单`（本文件 +
   v3 §6 更新）。
2. `feat(permission-policy): TS 单真源——auto 白名单/出厂规则/danger 数据面收拢` +
   测试（vitest 全绿）。
3. （如触 Rust 名单消费点）`refactor(permissions): auto_mode_allows 停用 Agent 消费，
   R3 随裁决迁移退役` + cargo 全绿。
