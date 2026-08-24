# 兰台交接棒 16 —— 全清后的收尾窗口：竣工落账 + 雷区 M4/M6 清算

> 2026-08-24 上午会话（续第 15 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton15.md（第 15 棒：B⑤ capability 迁移收官，P4 存量拆解全清）

## 0. 本棒干了什么

baton15 §2 工作序只剩 C12 挂起（外部信号）与并行窗口自管线。本窗口按
「全清后收尾」接手三件事：竣工文档落账（session-ledger 合入后现状页
三行过期）、雷区地图第二批审计最后两条在册项（M4/M6）清算。

1. **竣工落账 ✅**：
   - `docs/plans/README.md` 现状页刷新——一句话现状升 2026-08-24（P4
     存量拆解全清 + session-ledger 竣工合入）；待执行表删 session-ledger
     行（L0-L3 已毕）、browser CDP 行落 ✅（五批全落地 + E2E 1-5 已于
     2026-08-22 Windows 真机 35/35 实跑；eval 隔离 world 为已拍板可选项
     不做）、P4 行补「存量拆解 2026-08-24 全清（baton15）」；等外部条件
     表补 C12 dsh-compat 行（唯一合法挂起）；真机验证欠账表补
     session-ledger 三项（重启工作集恢复/后台卷落盘/续开查重，需带 key
     真机会话）；已完成段点名 session-ledger。
   - `docs/plans/HISTORY.md` 补两条里程碑：P4 存量拆解全清（3dca1925）+
     session-ledger L0-L3 竣工合入（e677c5c8）。
   - session-ledger-plan.md 留在 plans/ 不物理归档（真机三项未闭，同
     shell-stability 先例；README 已如实点名）。
2. **M6 收账 ✅（已消解，非本批修）**：landmine-map M6（main.ts
   resetCheckPanelState deactivate 后回填人造✅进 checkCache）核实——
   该函数随 V5 拆除 + C14 check 面退役已不存在（全库零匹配；现行
   resetAgentCaches 清空 checkCache、setCheckResult 仅喂真结果）。雷区
   行标已消解，防下次审计重复排查。
3. **M4 拆弹 ✅（本批修复）**：`disposePanelStores` 生产零调用——每会话
   messages store（`storeId:sessionId` 键）只增不减，无界内存；且
   ChatCore/panelId 是应用级单例（`cp-时间戳-随机`，bootChat 仅启动跑
   一次）→ 同 storeId 跨工作区复用，旧项目全部卷 store 永久残留（新
   工作区撞号卷会短暂读到旧消息）。三条死亡路径接线：
   - **合卷**（closeSession）：`disposeSessionMessagesStore(storeId, sid)`
     单卷精确拆除（新增导出于 state/messages-store.ts；快照落盘在拆除
     前已从 agent 数据同步捕获，续开该卷走磁盘恢复重建）；
   - **工作区全量重置**（resetSessionState，setAgent 换工作区路径）：
     `disposeMessagesStores(storeId)` 前缀整批拆除（面板级 msg store 一
     并重建——流式标志/expandedReasoning 随全新会话树归零，语义更对）；
   - **setAgent(null)**（API key 清空/无 key 切换）：新增
     `disposePanelMessages(storeId)` 门面（chat-session.ts，对齐
     clearPanelAgents 形态）在清会话列表时整批拆除；
   - **换卷不拆**（switchSession）：摊开集内即时切换依赖内存态——守护
     用例钉死。
   - 顺带修正 chat-store.ts / messages-store.ts 里「生产暂未接线」的过期
     注释（msg 组成部分现已分路径接线）。
   - 回归测试 4 例（tests/chat-session.test.ts M4 describe）：拆除判定用
     「version 归零 + messages 空」谓词（活 store 的 setMessages 以
     Date.now() 起版，version 恒 > 0）。

### 0.1 本棒验证记录

- 定向：tests/chat-session.test.ts 44/44（含新 M4 四例）；
  tests/session-ledger.test.ts + tests/audit-fixes.test.ts 28/28。
- tsc --noEmit 零错；biome 改动文件零新增（对比 HEAD 基线：余下诊断均
  为存量行号漂移——noNonNullAssertion×3/noUnused×1 于 chat-session、
  noUnusedImports×1 于 chat-store、tests 存量 any/非空断言）。
- 全量 vitest：**166 文件 165 passed + 1 skipped / 1667 passed + 1 skipped /
  0 failed**（基线 1637 + 本批 4 例；余 +26 例来自并行窗口在途 untracked
  mode-indicator-model-menu.test.ts，共存全绿——顺序单跑无并行假失败）。
- biome --write 纪律：含 FIXABLE 存量的文件（chat-store.ts）不跑 --write
  （防顺手删存量未用导入）；只对 format/organizeImports 新增的三文件跑，
  并先在临时副本预览确认波及面。

## 1. 本机环境坑（沿袭 baton8-15 §1，全部继续有效）

1-13 沿袭 baton15 §1（NODE_ENV 渗入 / TEMP 错位 / 并行 vitest 假失败 /
多窗口还原 / 工具面契约同 commit / convergence record 危险操作 / cordis
asyncDispose 不级联 / zod TDZ / JSDoc `*/` 字面量 / ids() 收对象 /
cordis ctx inject 纪律 / root asyncDispose 非清理面 / NODE_ENV=production
进程内渗入）。

14. **PowerShell `git show > file` 重定向改写行尾**（本棒实锤）：抽取
    HEAD 基线文件做 biome 对比时，`>` 重定向产生 CRLF 与真实工作区不一
    致——format 类诊断不可信，只能对比 lint 类别计数；format 判别用工作
    区文件实跑。biome `--write` 会顺手修 FIXABLE 存量（如 noUnusedImports
    删行）——含 FIXABLE 存量的文件先临时副本预览 diff 再决定。

## 2. 下一窗口的工作序

工程面全清后剩余（与 baton15 §2 一致，无新增欠账）：

1. **C12 dsh-compat** 唯一合法挂起（外部信号依赖：DSH peer 出非
   workspace 版本即启动——p4a 调研已备好契约地图）。
2. 并行窗口 agent/provider 线（§3 清单）——其收口由该窗口自管。
3. **真机验证欠账**（需用户带 API key 会话）：session-ledger 三项（重启
   工作集恢复/后台卷落盘/续开查重）+ workspace-flip 批 3 边界观察项。
4. 新能力加面走通道（事实非待办）：docs/plugins/README.md §3。
5. 可选非欠账：browser CDP eval 隔离 world（计划内已拍板「可选不做」，
   无外部信号不做不启动）。

## 3. 环境与雷区备忘

- **并行窗口 agent/provider 线仍在途**（baton15 §3 同清单——agent.ts /
  chat-agent-handle.ts / ModeIndicator / ModelSelector / SettingsPanel /
  SpineRack / 各 css / AddProviderSheet / ProviderDetail / ProviderList /
  ProviderPage / status.ts / selection.ts / thinking.ts / settings.ts /
  paper-store.test / provider-page-staging.test / mode-indicator-model-menu.test /
  CONTEXT.md / lantai-design-spec.md + 两个未跟踪 plan 文档
  dynamic-edge-detection-plan.md / v11-analysis-engine-master-plan.md）——
  提交时继续排除，staging 前重新核对。本批改动面与其零交集。
- **M4 后会话 store 生命周期语义**：卷消亡（合卷）→ 拆单卷；工作区消亡
  （切换/拆除）→ 整批拆；摊开集内存活（换卷/切回）→ 保留。续开已合卷
  走磁盘恢复（loadSessionFromDisk 重建空 store 后灌入）。
- **landmine-map 第二批审计至此全清**（H1-H5/M1-M6 全 ✅/已消解；P2 低
  危段维持「记录在案暂不拆」的拍板不变）。

## 4. 本棒提交清单

- `<HASH>` — fix(chat): 雷区 M4 拆除——会话级 messages store 三死亡路径接线 dispose + 竣工落账（session-ledger/P4/browser CDP 现状页刷新 + M6 消解收账 + baton16 交接）

提交文件面（staging 复核清单——多窗口纪律）：
- src：src-ui/src/state/messages-store.ts（新增 disposeSessionMessagesStore）、
  src-ui/src/ui/chat-store.ts（注释）、src-ui/src/ui/chat-session.ts（三路径
  接线 + disposePanelMessages 门面）、src-ui/src/app/chat/chat-core.ts
  （setAgent(null) 拆除）
- tests：src-ui/tests/chat-session.test.ts（M4 describe 四例）
- docs：docs/plans/README.md、docs/plans/HISTORY.md、docs/landmine-map.md
  （M4 已拆 + M6 已消解）、docs/plans/lantai-handoff-baton16.md
- 排除（并行窗口在途）：§3 清单全部。
