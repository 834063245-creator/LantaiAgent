# 交接窗——内核插件运行时 Phase 2 全量竣工窗（P2-5/P2-6 实施完成）

> ⚠ **已归档（2026-09-16 · 文档面重构 P3）**：内核插件运行时线**已建成又已拆除**（v3 拆除令，2026-09-05），本件是该线 Phase 2 全量竣工窗的交接记录，是历史留存。决策真源见 [`docs/plans/kernel-plugin-architecture-decision.md`](../plans/kernel-plugin-architecture-decision.md)，在办计划入口见 [`docs/plans/README.md`](../plans/README.md)。

## 当前态（本窗结束，已实核）
- **main 头部**：d419c9d7 = P2-6（builtin.pty + builtin.lsp）；c12281e8 = P2-5（builtin.browser + builtin.uia）；70c85db1 = 设计件 §8 增补
- **Phase 2 全量竣工**：九域（fs/editor/constraints/git/shell/browser/uia/pty/lsp）全部内核插件信封化，rpc.rs **45 methods**（145 → 45 全历程），kernel-plugin-runtime 工具域收口
- 工作区剩未跟踪：docs/plans/handoff-p2-window.md（本交接件，预期提交）+ 一个锁死的 src-tauri/cargo_lib_bins_test.log（测试日志，勿提交；已被 git 忽略面外，删除需先释放句柄）
- 内核插件 11 个 = 75 工具（search 1 + web 2 + fs 13 + editor 1 + constraints 2 + git 16 + shell 7 + browser 37 + uia 17 + pty 4 + lsp 3）
- vitest 2433 / cargo 446 / convergence 零漂移 / build / doc-sync / biome 改动文件 0 错，基线全绿

## Phase 2 权限形状最终形态（两族分治，勿混）
- **fs/editor/constraints/git**（P2-0~P2-3）：manifest 声明 permission——dispatch 侧 PluginToolAdapter 承载工具级门（Read/Edit/Git 家族 + subcommand），业务免检化
- **shell**（P2-4）+ **browser/uia/pty/lsp**（P2-5/P2-6，§8 裁决）：**不进 manifest permission**——dispatch 恒 Passthrough，权限整体留插件内业务自检（shell 的 bg/fg 双检查不对称；browser 的 BrowserTool 四层 + click/type_sensitive 运行时二次 Ask + self 路由；uia 的 DesktopTool 六层 resolve→classify→grant→lease 全链 + 逐动作审计；pty/lsp 无家族规则直接走高层函数）
- tools/mod.rs 的 BrowserTool/DesktopTool 是插件内真权检查依赖，**保留不动**

## 生成器/镜像/契约纪律（继续沿用）
- manifest schema 唯一转录通道 = src-ui/scripts/gen-kernel-manifest.ts 生成器；新增域 = 加 TOOLS_SPEC（tsTool 直出 / 手写 schema）+ npm run gen:kernel-manifest + gen:plugin-manifests + --check 复检
- 单键语言：模型面键 = manifest 键 = 插件实收键。browser 面 camelCase（信封 args 不经 bridge 转换原样到达）、uia/pty/lsp 面 snake_case
- rpc.rs 改后跑 node scripts/gen-rpc-contract-md.cjs（SECTIONS 数组须与 rpc.rs 分区同步删）；工具面不变不跑 gen:tool-contract（P2-5/P2-6 零漂移已证）

## Phase 3 待办（下一窗候选）
- 内核插件管理面：plugin_tool_manifests 消费 + 启停持久化 + 能力授予 + 第三方内核插件装载（docs/plans/kernel-plugin-runtime-plan.md Phase 3 行；RPC 45 methods 中生命周期族仍在）

## 真机验收清单（Phase 2 竣工后待用户/真机窗补跑，自动化门禁已全绿）
- browser：launch/connect/sessions/switch_session/cookies/attach/snapshot/click/type/navigate/eval/screenshot/audit（cdp e2e 已覆盖 launch/kill/profile/cookies/navigation/forms；network+AX 并行假红单跑绿）
- uia：probe/tree/find/read/wait/click/type/keys/activate/window_shot/audit/status（真实窗口 e2e 需 HOLOGRAM_UIA_E2E=1）
- pty：spawn 后能看到输出（pty-output 事件）、write/resize/kill
- lsp：start 后 completion/hover/definition/diagnostics（lsp-message 事件仍工作；lsp-client 已换 kernelLspRequest 信封）

## 建议下一位 Agent 开工顺序
1. 提交本交接件（docs/plans/handoff-p2-window.md 是当前内容——git add 后 commit 为 docs 落账）
2. Phase 3 或按 docs/plans/README.md 五行总表取下一项
