# 会话持久化 seam 接线施工计划（sessionPersistence 承诺做实——C 定案）

> 立项：2026-09-05 · 状态：**plan 定稿待施工（下窗执行）** · 上游：平台化 Phase 2 · D11（施工⑥）
> + 归属反转会话模型换代（2026-08-27）+ R5 落账窗发现（2026-09-05）
> 拍板：用户 2026-09-05 定 **C**（把承诺做实——产品会话持久化全链经 seam，插件换 provider 即换存储后端）。
> 自查模式：本文全部断言已对代码实测（file:line 落点）。

## 0. 背景：为什么做（五事实，R5 落账窗实测）

1. **消费面是空的**：seam 消费单点 `sessionExecute()`（session-persistence-service.ts:78）全仓零产线调用——唯一设计消费方 agent-store 磁盘 CRUD 已于 2026-09-01 内存化退役（agent-store.ts 头注）。
2. **真实会话持久化全在 seam 外直连**：今天产品里真实存在的会话落盘 = `saveActiveSession`/`saveSessionById` **全量快照**（chat-session.ts:644/681，经 kernelWriteFile→fs_cap 写 `{ws}/.lantai/sessions/{id}.json`）+ 目录扫描恢复。全部直调 fs 具名 helper，不经 seam。施工⑥范围注记明文「chat-session 落盘链 P5 全量挂 seam 时统一」——该后续从未发生。
3. **append 目标 RPC 也死了**：默认 provider 的 append 动作转发 `agent_session_append`，该 RPC 在 src-ui/src 零产线调用方（agent 侧 session-log.ndjson 的 TS 写入者随 agent-store 一起消失；rpc-contract.ts:524-534 注记的「保留路径」已无写入者）。
4. **动作形状对着旧世界**：`SessionPersistAction = read/write/append/appendLog/mkdir/delete` 六动作照旧 agent-store 磁盘 CRUD 设计，对不上今天的会话模型（全量快照/目录扫描/墓碑删除——没有「存快照」「列卷」动作位）。
5. **插件手册在说谎**：docs/plugins/README.md:74 消费面栏仍写「sessionExecute（agent-store）」——引用已拆除的消费方。净效果：**插件作者今天注册 SQLite 会话后端，产品行为零变化**。且空承诺会静默烂——R5 窗实锤：默认 provider 还在走已退役的 tool_call 信封，炸了没人发现，因为没人跑它。

用户拍板 C。sessions-seam.test.ts 头注「seam 骨架的拆除与否另行立案」由此立案闭环。

## 1. 勘察事实（实测落点，批 1 复核清单以此为底）

### 1.1 真实会话 IO 面（产线，全部待接线/豁免裁定）

| # | 落点 | 现走路径 | C 后动作 |
|---|---|---|---|
| 1 | chat-session.ts:559-562 `readSessionJSON(filePath)` | kernelReadFileRaw | `read_volume {root, id}` |
| 2 | chat-session.ts:585-587 `readVolumeJSON(root,id)` | ↑ 经 1 | `read_volume` |
| 3 | chat-session.ts:592-607 `scanMaxSessionId` | kernelListDirectory | `list_volumes {root}` |
| 4 | chat-session.ts:624-634 `writeSessionSnapshot`（saveActiveSession:644 / saveSessionById:681 / 合卷落盘 / renameSessionFile:711 共用） | kernelWriteFile | `save_volume {root, id, data}` |
| 5 | chat-session.ts:1075-1089 `deleteSessionFile`（墓碑重写 deleted:true） | kernelWriteFile | `delete_volume {root, id}` |
| 6 | chat-core.ts:735-741 `restoreCanvasSpread` 目录枚举 | kernelListDirectory（自带路径构造，与 570 重复） | `list_volumes` |
| 7 | chat-session.ts:784-804+ 恢复并行读面（P0-3） | kernelListDirectory + 卷读 | `list_volumes` + `read_volume` |
| 8 | SessionsHome.tsx:14（读 `{path}/.lantai/sessions/`，具体调用形态批 1 清点） | 待清点 | `list_volumes`/`read_volume` |
| 9 | chat-session.ts:1475 导出 .md | kernelWriteFile | **豁免**（用户自选路径的导出，非会话存储语义） |
| 10 | shell/rows/workspace.ts:166-172 ensure 会话根目录 | kernelCreateDirectory | **豁免**（工作区脚手架结构 op；壳行执行时序早于插件装载不可依赖 seam；default provider save 走 kernelWriteFile 自带父目录自动创建兜底） |
| 11 | Rust `workspace_remove` 直删工作区目录（含会话根） | Rust 命令 | **豁免**（工作区生命周期语义，非会话持久化；SQLite provider 场景的一致性边界记录 §6） |

### 1.2 seam 现状

- `composition/session-persistence-service.ts`：Service + ContributionRegistry + 模块级 `sessionExecute` 消费单点；`SessionPersistAction` 六动作（旧 agent-store 形状）；**在开放面契约 v12 文件清单内**（contract-version.ts:33）→ 本计划必升 v13。
- `plugins/builtin/sessions-builtin/index.ts`：默认 provider `builtin/rust-sessions`（R5 批 3 已换 fs_cap 直呼 + SESSIONS_FS_CAP_BY_ACTION 表）。
- `sandbox.ts:145,160`：动态插件白名单声明 `sessionPersistence: ['execute']`——但 Service **没有 execute 方法**（只有 register/get/list）——白名单引用不存在的方法（第二处小谎，C 顺带变真）。
- `roster.ts:236`：seam 行源 = provider id 清单（'builtin/rust-sessions'，id 稳定 → 零漂移预期）。
- `agent_session_append` RPC：TS 零调用方（D-5 处置）。

## 2. 目标形态

```
chat-session.ts / chat-core.ts（会话 IO 消费方，冻结文件最小 diff）
   │  sessionExecute('read_volume'|'list_volumes'|'save_volume'|'delete_volume', args)
   ▼
ctx.sessionPersistence（seam 注册表——后注册胜取默认；组合 seam/sessionPersistence 域可禁用）
   │  默认 provider = builtin/rust-sessions（kernel* 具名 helper 转发 → fs_cap 用户路径）
   ▼
{ws}/.lantai/sessions/{id}.json   ←—— 换 provider（SQLite/远程仓）即整链换存储，产品代码零改动
```

承诺句（做实后）：**插件注册 SessionPersistenceProvider 即接管产品会话持久化**——今天这条承诺是假的，C 之后必须可用测试证明。

## 3. 裁定表（agent 落款，无待拍板项）

| # | 决策点 | 裁定 |
|---|---|---|
| D-1 | 动作面 | **四动作，会话语义**：`read_volume {root,id}→StoredSession JSON 串或 'null'` / `list_volumes {root}→文件名 JSON 数组（provider 侧滤目录；消费方各自 parse id/墓碑判别）` / `save_volume {root,id,data(快照 JSON 串)}→'null'` / `delete_volume {root,id}→'null'`。不做 fs 语义动作（read/write/mkdir 照抄旧面 = 把存储布局焊进接口） |
| D-2 | 墓碑语义归属 | `delete_volume` 语义动作；**默认 provider 实现为墓碑重写**（deleted:true——listSavedSessions 过滤契约与恢复剪枝消费方依赖此形态，行为字节不变）；SQLite provider 可真删。StoredSession 形状（含 deleted 字段）留在消费方 chat-session——provider 存取不透明 JSON 串 |
| D-3 | 默认 provider 实现 | **走 kernel* 具名 helper**（kernelReadFileRaw/kernelListDirectory/kernelWriteFile——既有 fs_cap 用户路径包装），不走裸 fsCapCall。理由：①行为与今日直连逐字节一致；②**测试 mock 面（tests/helpers/kernel-fs.ts kernel 层）零迁移**——三命运黄金标准（换轨 commit 测试 diff 零 = 行为零漂移最强证据） |
| D-4 | 宿主桥 | sessions-builtin host.ts/host.aliased.ts 增三 kernel helper 导出（**graph-builtin agentInvoke 先例**——faceDeps 桥既有模式）+ host-modules.ts Record 类型同步；构建门禁兜底 |
| D-5 | append/appendLog 处置 | **从动作面删除**（目标 RPC 零产线调用方——事实 3）；`agent_session_append` RPC 本体留 Rust 不动（TS 死链标注，退役另立——扩 Rust 面无收益） |
| D-6 | 消费单点归属 | **Service 增 `execute` 方法**（与模块级 sessionExecute 同一注册表决议）——sandbox 白名单既有 `'execute'` 声明变真（sandbox.ts 零改动，非契约文件不动指纹面）；模块级 sessionExecute 保留为产品代码消费单点 |
| D-7 | 消费接线策略 | **冻结文件最小 diff**：chat-session.ts 仅换 IO 调用表达式 + import（控制流/消息形状/时序零动）；豁免依据 = 施工⑥范围注记明文 deferred（「P5 全量挂 seam 时统一」）。不做 session-io 中间层（StoredSession 类型在 chat-session，回引会造层间环；四动作 args 直传即可） |
| D-8 | 契约升版 | session-persistence-service.ts 在 v12 清单内且必改 → **v13 四步同 commit**（bump + open-surface-contract.md 变更记录行 + gen:contract-fingerprint + 同 commit） |
| D-9 | 豁免清单 | 表 1.1 的 #9/#10/#11 各带理由（导出=用户文件 op；ensure=脚手架+时序；workspace_remove=生命周期）——豁免是显式裁定不是遗漏 |
| D-10 | 文档面 | plugins/README.md:74 消费面改真话（sessionExecute——会话卷四动作）；first-party-manifest.ts:66 「（agent-store）」过期括注清；sessions-seam.test 头注「另行立案」注记销账 |

## 4. 批序（每批独立全门禁绿 commit；agent 裁定可调）

| 批 | 内容 | 验收 |
|---|---|---|
| 批 1 | 勘察清点（不 commit）：① SessionsHome.tsx 的会话 IO 调用形态（直调 kernel* 还是经 chat-session 导出）；② renameSessionFile 主体（L711——save_volume 覆盖确认）；③ readSessionJSON/readVolumeJSON 全调用方清点（restoreCanvasSpread 并行读面的 helper 链）；④ sandbox.ts:140-165 上下文；⑤ docs/cookbook/ 有无 session seam cookbook；⑥ host-modules.ts faceDeps 组装点（graph-builtin 先例的桥接实现位置） | 清点报告进批 2 commit message |
| 批 2 | **seam 动作面重设计 + 默认 provider 换轨**（纯加面——旧消费方为零，无破坏面）：session-persistence-service.ts 四动作 + Service.execute（D-1/D-6）+ **v13 四步**（D-8）；sessions-builtin provider 换新动作面（D-2/D-3）+ host 桥三导出（D-4）；sessions-seam.test ①动作名随迁 + ② 表重钉 + **③ provider-swap 端到端新测试（fake provider 注册 → sessionExecute 路由过它——承诺为真的可执行证明）** + ④ default provider 对 kernel-fs 内存盘 roundtrip | cargo 不涉及；vitest 全绿 + build + biome 0/0 + convergence 双档（roster 行 id 稳定零漂移实证）+ doc-sync + **契约指纹 v13 一致** |
| 批 3 | **消费接线**（冻结文件最小 diff 批）：chat-session.ts 六处换轨（表 1.1 #1-#5、#7）+ chat-core.ts:735（#6）+ SessionsHome（#8，按批 1 清点）+ 豁免三处代码注记（#9/#10/#11 显式豁免理由落注释）；**测试零改动实证**（kernel-fs mock 面零迁移——理想 = 会话族测试文件 diff 为零） | vitest 全量（**会话族测试 diff 为零**）+ build + biome 0/0 + convergence 双档 + doc-sync |
| 批 4 | 文档面 + 落账：plugins/README.md:74 真话 + first-party-manifest:66 括注 + sessions-seam 头注销账（D-10）+ README.md 计划表行勾销 + 窗末三行 | doc-sync + biome（.md 不进 biome，纯对拍） |

## 5. 验收

1. **承诺可证**：③ 号测试（fake provider 端到端）绿 = 「插件换 provider 即换存储后端」从空话变成可执行断言。
2. **grep 验收**：`sessionExecute(` 产线调用方 ≥ 2 文件（chat-session/chat-core）；chat-session/chat-core 内 kernel* 会话卷直调清零（#9 导出豁免除外）；`.lantai/sessions` 路径构造收敛（chat-session:570 唯一权威 or provider 内部——批 2 定）。
3. **行为零漂移**：会话族测试文件 diff 为零（kernel-fs mock 面零迁移实证）；convergence 双档零漂移。
4. 契约 v13 指纹一致；全门禁绿；分批复核 commit。

## 6. 风险与边界

- **冻结文件纪律**：chat-session.ts diff 必须 = import + IO 调用表达式；出现控制流改动即违批——批 3 commit message 贴 diff stat 自证。
- **恢复链性能**：seam 层多一跳 async（注册表决议）——恢复并行读 P0-3 语义不变，开销可忽略；不动两阶段恢复结构。
- **SQLite 一致性边界**：workspace_remove Rust 直删工作区目录（含会话根）——工作区生命周期语义不进 seam；第三方 provider 的数据迁移/清理是 provider 自己的责任（D11 契约原文已含「存储后端可替换」，边界记录于本节）。
- **宿主桥缺口**：faceDeps 三 helper 若装配缺失，产物域运行时炸（host.aliased throw）——批 2 build 兜底 + graph-builtin 先例对齐；回退方案 = provider 改裸 fsCapCall（测试 mock 面需迁移，三命运代价，仅作回退不首选）。
- **时序安全**：三动作消费点全部发生在 workspace open 之后（插件已装载）——ensure_dir 壳行已豁免（D-9 #10），无 boot 时序依赖 seam 的路径。

## 附：门禁与踩坑（本机实录，carry over R5）

- src-ui 每条命令前 `$env:NODE_ENV='test'`（新 shell 不继承）；全量门禁**顺序跑**（vitest × cargo 并行互扰假红）。
- cargo test 用 PowerShell `*>` 重定向后查 log「test result: ok」，exit code 不可信；git bash grep 日志加 `-a`（GBK 字节被当 binary）。
- commit -F 用绝对路径 D:\tmp；staging 前 `git status --short` 重核（并行窗口还原风险），验证绿立即 commit。
- 不 stage AGENTS.md/CLAUDE.md（工作树在途规则增补待用户处理）。
- biome 改动文件零新增纪律：含 FIXABLE 存量的文件先副本预览（会话族测试文件多为存量 CRLF，勿误当新引入）。
- 执行契约 carry over：技术决策 agent 全拍（先例/风险最小/测试兜底），落账写「agent 裁定」；设计件只在先例不覆盖时写；禁挂起话术；窗末三行（做了什么/风险在哪/下一窗做什么）。
