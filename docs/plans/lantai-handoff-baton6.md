# 兰台（Lantai）自主施工交接 — 接手即读（第 6 棒）

## 一、你接手时的现场状态

- git 干净，除两个用户的未跟踪文件（**都不许碰、不许提交**）：`docs/design/lantai-handoff.md`、`docs/design/lantai-tokens.css`（兰台 token 原件参照）。
- HEAD = dd944571，本棒（第 5 棒）在 eadbc8a7 之后连落 **12 个 commit**（见下节）。
- 后台无孤儿作业；无残留 lantai.exe / vite 进程（9777 端口上有一个 hologram-engine.exe 是**外项目** dsh web 的 harness，凌晨 04:48 起的，与兰台无关——兰台引擎是进程内单例不占该口，**别误杀也别误判**）。
- 用户 provider 线（34a5fad1）与 Agent 自主线互不冲突，照旧。

## 二、本棒已完成（勿重做）——工程队列清空 + C 段 C1-C12 全绿

每项全门禁（tsc / vitest / verify:convergence 零漂移 / build / biome 逐文件零新增）+ 真机 CDP 验证：

1. **63e0fd77 + a59fc086 + e49fe1a9 — rpc Value 化第二步（B 路线出口分派表）**：rpc.rs `rpc_result_shape` 表 21 个 JsonValue 命令出口 parse 成真结构化 Value（parse 失败=违反「Ok 恒为合法 JSON」契约转 Err 可见），其余保守 Text 字节精确直通。动态形态命令一律 Text（hologram_call 元命令/get_graph_page 体积/dataflow_query 磁盘直通/aura_recall DLL 空串/drain_bg_notifications 空串/exec_command 双形态）。前端 `typedJsonRpc` 双形态 shim（结构化透传/字符串 parse 慢路径——浏览器 mock 兼容）+ `agentInvoke` 结构化返回回卷 JSON 字符串（工具链 string 世界零改动）。回归：Rust `dispatch_result_to_value_shapes` + 前端 `tests/rpc-value-shapes.test.ts`。附带：契约注释漂移校正（git_diff 系实为 git stdout 文本）；gen 脚本 singleRe 起点限制在 match 后（shape 表单行分支同形防误列契约表）。
2. **a8382fa9 — Value 化真机双轮验证闭环**：CDP 直 invoke（JsonValue 返 VALUE×4 / Text 返 STRING×2 / Err 人话 reject）+ **用户填 key 真实会话全工具链通过**（回卷链零 [object Object]/双重编码症状）。
3. **244eb730 — C7 朱砂圈用户人判通过**（C 段 C1-C7 收口）：用户实发来文【词】圈点真机过。
4. **5dbce152 + cb1108d2 — C11 权限模式单源真相 + 书眉 ModeIndicator**：旧链三病灶根治（①切换不同步 Rust 镜像=后台任务半切 ②双源单向陷阱=手动切换不落盘重启回默认 ③per-panel 作用域与全局 Rust 镜像错位）。新 `state/mode-store.ts`：app 级单例，切换=写 store+镜像 Rust+落盘三件事一体；boot 壳行 platform.ts 水合（hydratePermissionMode）；bridges 闸门改读新 store；panel-store permissionMode 字段退役。书眉 ModeIndicator：模型字样（纸面菜单按 provider 分组+恒 swap 热切换）+ 模式字样（**常询/半放/全放**三档轮转，yolo 须朱砂「落印」确认条）。真机闭环含重启水合（auto 落盘→重启直接半放实锤）。
5. **9e88340e — C9 牒卡换皮**：PromptShelf 暗卡退役→纸面牒卡。权限卡=「请示 · PERMIT」（朱砂 tag + subject 抄录图版 + **落印准此·Enter**=纸面唯一实色按钮 / **本卷均准**（session 规则，词面已对 Rust add_session_rule 语义核对）/ **驳回·Esc** 石墨）；问卡=「问询 · ASK」石青系；递出动画 160ms。逻辑层零改动（FIFO/5min 超时/快捷键全保留）。顺手清存量 lint 11 处（innerHTML 单点 Icon 组件化）。
6. **34991961 + 96fe84b8 — C10 附件拾遗（旧链四病灶根治）**：①拖放 HTML5 drop 在 T2 WebView **从未触发**（原生接管 dragDrop，handleFileDrop 改 no-op 留注释——要真做须走 Tauri onDragDropEvent 原生通道，另立任务）②浏览器回退 f.name 冒充 path（agent 拿假路径必炸）已砍 ③size 恒 0 伪造已去（渲染不显示）④📎行拼楷书正文改结构化。composer「夹」按钮走 Tauri dialog 真路径；translate 结构化 `payload.files`；UserBody 附件行（石青 mono「附 · name」+title 真路径）；measure 计高 +9+16/文件。**vitest include 补了 tsx**（本棒落了项目首批 .test.tsx）。**遗留一项待用户**：有 key 会话端到端「发消息带附件→agent 读文件」最后一步（验证机无 key 发不出）。
7. **0736538b + dd944571 — C12 书眉状态字**：StatusLine 接回 pushStatus 承接面（V5 拆状态栏后 statusText/statusLog 无 UI 消费的欠账）。statusText 常显 + analyzing 石青呼吸徽标（分析中/重分析中优先）+ 点击展开 statusLog 环 15 条。真机撞上活链路：cold-start 推的「已恢复上次案卷」直显（端到端原生验证）。

**C 段现状：C1-C12 全绿。仅余 C8（多卷切换）单独立项 + C14（dock-store 收缩）挂其后。**

## 三、下一棒队列（按优先级，全部等用户输入或低紧迫）

1. **C8 多卷切换**：V5 拆除最后一个交互欠账。chat-core 的 switchSession/closeSession/createNewSession 三面健在，缺纸壳入口+多卷并存的视觉表达。**性质是产品题**——注疏隐喻下多卷怎么表达（卷次条/书签/仅靠案卷首页进出）需用户拍板，别替用户决定。谈完一棒做完。
2. **C14 dock-store 收缩**：纯工程小活，挂 C8 后面搭车。
3. **B 段审美循环**：R5 打磨真审美项（V4 式单维循环，一环一维 A/B 对照每维 ≤3 环）。前置 = vision 会话（模型图像输入）+ 用户终审；headless Edge 截图 + harness 对拍管线已验证可用（C2 先例）。
4. **C10 端到端收尾**：用户有 key 会话时拖文件实测一轮即闭环。
5. 桌面发布包 `cargo tauri build`：用户想装正式版时做（10.4.0，updater 已配）。

## 四、坑位图（本棒新增 + 继承）

- **debug exe 的前端资源是编译期嵌入**：裸跑 `target/debug/lantai.exe` 不读磁盘 dist 也不接 1420 devUrl（tauri.localhost 是 custom protocol 内嵌资源）——**前端变更后必须 `cargo build` 重编 exe** 才能真机验证（本棒误诊两轮后破案，已记 taste-ledger）。`cargo tauri dev` 则走 devUrl 实时。
- **9777 端口的 hologram-engine.exe 是外项目**（dsh web harness）——兰台引擎进程内单例不占该口。别误杀别误判。
- **tests/ 下 .test.tsx 的 import 路径是 `../src/...`（一级）**：写成 `../../src/` 会报「Failed to resolve import」且报错文案有误导性（说文件不存在，实为路径多级）。本棒两度踩中。
- **vitest.config.ts include 已补 `tests/**/*.test.tsx`**（本棒新增 tsx 测试的前置）。
- **measure.ts 的 pretext mock 范式**：jsdom 无 Canvas 2D——`vi.hoisted + vi.mock('@chenglou/pretext')`（paper-v3a 同款），文本高度恒定后差值断言依然精确。
- **edit 工具在 LF 文件的 CRLF 失配**：锚点明明存在却 not found 时，改 PowerShell/node 临时脚本（锚点断言 throw 才动文件）。写完即删。
- PowerShell 里裸 `node -e "..."` 复杂脚本必炸（引号转义被 PS 吃）——写临时 .cjs 文件跑，用后即删（旧条，本棒再验证两次）。
- biome --write --unsafe 会删「只写不读」的私有字段声明（旧条）；普通 --write 安全。
- 跑前端测试/装包前清 NODE_ENV=production（旧条）。
- 动 src/agent/** 或 src/composition/** 必过 npm run verify:convergence（本棒 renderer-service.tsx 改动后照跑，零漂移）。
- Shell 每次调用都是全新 pwsh 进程；git commit -m 后接换行命令会被吞（分号分隔或分开跑）。
- **rpc.rs 已是 UTF-8**（第 4 棒交接单说 GBK 已过时；gen 脚本注释里的 GBK 处理逻辑仍在但无害）。
- .github/workflows/ci.yml 冻结；桌面发布只用 cargo tauri build。
- 修雷必须配回归测试；不混入用户未提交改动（docs/design/ 两个文件是用户的）。
- job_list 等零参工具也要传空对象 {}。

## 五、基线（本棒实测，漂了就更新文档）

| 层 | 命令 | 基线 |
|---|---|---|
| 引擎 | `cd engine && cargo test` | 697 tests（696 passed / 1 ignored，本棒未动 Rust 引擎） |
| 壳 | `cd src-tauri && cargo test` | bin 389 + 集成 14 全绿（含 Value 化 +1 测试；cdp e2e 按环境偶现 ±1） |
| 前端 | `cd src-ui && npx vitest run` | **149 文件 1481 passed / 1 skipped**（本棒 +3 文件 +14 用例：rpc-value-shapes 6 / paper-c10 6 / paper-c12 4；convergence 零漂移） |
| 前端构建 | `cd src-ui && npm run build` | tsc --noEmit + vite build 全绿 |
| convergence | `cd src-ui && npm run verify:convergence` | exit 0 零漂移（本棒三度跑，renderer-service 改动后亦稳） |

## 六、交接叮嘱

- 开工前照旧：CONVENTIONS.md + INVARIANTS.md 先读，动 ui/agent 前逐条核对 INVARIANTS。
- 建议开工时重新 create_goal（goal 不跨会话）。
- 用户深夜活跃，情绪照顾优先级高于工程进度；他叫助手「阿阳」，他自己是「宝宝」。
- 用户本轮已实测过（填 key 真会话 + C7 人判 + 暗卡亲眼看否掉），**「挺好」是他给出的正判定**——纸面方向稳了，别回头质疑已验收的东西。
- 术语已定案勿改：常询/半放/全放、请示·PERMIT/问询·ASK、落印准此/本卷均准/驳回、附·（附件行）、拾遗（附件入口）。
- vision（模型图像输入）可能被切掉/切回：headless Edge 截图 + read 读图是替代路径，但 read 图像也依赖多模态——两条路都可能失效，验尸式 DOM 断言（CDP 文字通道）永远可用（本棒 CDP DOM 断言全程主力）。
