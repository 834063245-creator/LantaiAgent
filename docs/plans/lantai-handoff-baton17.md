# 兰台交接棒 17 —— 创作坞+提供方联合体检方案甲施工：会话级模型真生效

> 2026-08-26 下午会话（续第 16 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton16.md（第 16 棒：竣工落账 + M4/M6 清算）

## 0. 本棒干了什么

用户报「provider 有毛病，后端抄的 DSH 问题不大，前端逻辑没抄过来」。全链路体检
（provider/settings/credentials/catalog/热切换/代理 + ComposerDock/compose-store/
ModelSelector/输入历史/斜杠）产出联合体检报告；用户提供第二份独立创作坞体检报告
（含方案甲定案），两报告合并落库后同日施工修完。

1. **联合体检报告落库 ✅**：`docs/plans/canvas-space/composer-provider-audit.md`
   （两份独立报告合并，A1/A2 互证共同命中；合并时复核扩大 B6 爆炸半径——
   `registerComposer` 死链实为 chat-core 内 9 处 `_composer?.focus()` 全部空转）。
2. **方案甲施工 ✅（commit `efc74e7d`）**：会话级模型/思考真生效。
   语义 = 全局是新卷/未改卷的实时默认；会话只存自己的覆盖；运行与显示都按会话解析。
   - compose-store 覆盖制重写：`ensurePrefs` 快照冻结退役；`resolveEffective` =
     覆盖 ?? 全局实时解析；`setModel/setThinking` 不再写全局 settings（信号带
     sessionId）；`hydratePrefs` 恢复期回填。
   - live provider 第三参会话覆盖（model/thinking；`setThinking` 不再 no-op）。
   - `AgentFactory` 签名带 sessionId（chat-session.ts 三调用点）；工厂按会话
     effective 装配 provider/pricing/contextWindow（`_contextWindowFor`）。
   - `applyAgentConfig` 重写：会话级分支只热切换目标会话（`getAgent`），
     settings-saved 走 `forEachAgentEntry`（新增）逐会话重解析——覆盖卷保持
     自己的值，未改卷裸 live 跟随全局。
   - 会话覆盖随卷落盘/恢复：`SessionSnapshotData.compose`（同 paper 模式）。
3. **全批修复 ✅（commit `254ad008`）**：B1 模型下拉打开置空 query；B2 compact
   只列已配置厂商（封死写错行 400）；B3 无 Key 分组头标注；B4 测试连接改最小
   落盘面（`onPersistProbe` 读盘-改-写回，取消不再隐性提交暂存）；B5 历史导航
   `navigateHistory` 纯函数（↑↓/越出恢复草稿）；B6 ComposerDock 注册
   `registerComposer` 接活 9 处死链；B7 后台卷运行态指示+停止；C1 插话 notice；
   C2 切卷清本地态；C3 斜杠键盘导航；C4 打字热路径去 loadSettings；
   D1 `getActiveProvider` 空表双兜底；D4 legacy thinking 显式 option。
4. **落账 ✅（commit `36ad9ed5`）**：体检报告修复落账节（逐条状态 + 实机验收
   七项 + 改动清单）；本棒补 plans/README 现状、HISTORY 两条里程碑、返工清单
   叠加段、本 baton。

### 0.1 本棒验证记录

- 全量 vitest：**180 文件 1762 passed / 4 skipped / 0 failed**（基线 1742 + 本批
  新增：compose-store 重写 9 + history-nav 7 + model-selector 扩展 2 + hotswap
  重写 7 - 退役旧断言若干）。
- `npm run build`（tsc+vite）✓；`verify:convergence`（**必须 $env:NODE_ENV='test'**，
  见 §1）exit 0；`npx biome ci .` 0 error。
- 适配的既有测试：composer-dock-rework（ensurePrefs 退役→setThinking 自带落覆盖）、
  composition-preset-assembly（工厂签名锚点更新）、persistence-signal-routing
  （第三参 undefined 断言）、provider-hotswap（重写为方案甲形态断言——原
  「forEachAgent 全量轰炸」断言是 A1 病灶的固化，已翻案）。

## 1. 本机环境坑（沿袭 baton8-16 §1，全部继续有效）

1-14 沿袭 baton16 §1（NODE_ENV 渗入 / TEMP 错位 / 并行 vitest 假失败 / 多窗口
还原 / 工具面契约同 commit / convergence record 危险操作 / cordis asyncDispose
不级联 / zod TDZ / JSDoc `*/` 字面量 / ids() 收对象 / biome --write 预览副本 /
CRLF 存量）。本棒新增实证：

15. **convergence 也吃 NODE_ENV 注入**：`npm run verify:convergence` 不带
    `$env:NODE_ENV='test'` 会 7 个 phase specs 全红（`No such built-in module:
    node:`）——与 vitest 同源（Cowork 进程链注入 production），报告形态是
    「Failed Suites 7」而非测试断言失败。先怀疑环境再怀疑代码。

## 2. 剩余工作（工作序）

1. **实机验收（最优先，用户跑）**：
   - 体检验收七项（composer-provider-audit.md 修复落账节）：会话隔离/跟随语义/
     重启保留/选择面/取消回滚/历史焦点/后台运行态。
   - Stage-4 返工清单 P0-P4（stage-4-rework-checklist.md）：P0-1 关窗崩溃 /
     P1-1 三道闸 / P1-2 落点 / P3-1 布局。
   - Stage-3 四项 + 分层四项 + session-unify 四项（plans/README 欠账表）。
2. **体检未动项（在册小账）**：C5 目录失败面（DSH groups/failures/routable
   三分面，独立小工程）；D2 settings-saved 面 IPC 收窄（诊断改走 resolveApiKey
   缓存）；D5 组件级测试缺口（↑↓/斜杠键盘行为的组件测试仍欠）。
3. **Stage-5 草案待审**（stage-5.md）：画布布局持久化 + 公共物工作区级 +
   工作区切换收口 + 零目录退役；开工依赖 = 返工清单 + 体检验收实机勾销。
4. **挂起项不变**：C12 dsh-compat（等 DSH 外部信号）；v11 分析引擎 plan
   （启动需用户拍板）；repo 改名 GitHub 侧（用户操作）。

## 3. 方案甲语义要点（接手必读）

- **覆盖制铁律**：compose-store 的 `sessions` 表只存「用户显式改动过的卷」。
  `resolveEffective(sid)` = 覆盖 ?? 全局活跃 provider（实时读 settings——未改
  卷跟随全局，改过卷不跟随）。显示（ComposerDock）与运行（工厂/热切换）同源。
- **live provider 双形态**：无覆盖 = 裸 `createLiveProvider(name)`（配置全在使用
  点按名现解析，实时跟随全局行值）；有覆盖 = 第三参 `{model, thinking}` 钉住
  该会话维度。`setThinking(undefined)` = 清除覆盖回落行值；`''` = 显式自动。
- **热切换两条路**：会话级信号（model-switched/thinking-changed 带 sessionId）
  → 只打该会话句柄；全局信号（settings-saved）→ 逐会话重解析（forEachAgentEntry）。
  **没有会话维度的「全量轰炸」路径了**——谁再写 forEachAgent 换 provider 就是
  A1 复发，provider-hotswap.test.ts 有静态钉。
- **会话覆盖持久化**：`StoredSession.compose`（可选字段，旧存档无 = 无覆盖）；
  写盘在 saveActiveSession/saveSessionById；读盘回填在 loadSessionFromDisk
  （hydratePrefs，不发信号）；合卷 removePrefs 既有。
- **测试纪律**：改 compose-store/live/workspace provider 面 → 必跑
  compose-store.test / provider-hotswap.test / provider-live.test /
  composer-dock-rework.test / persistence-signal-routing.test /
  composition-preset-assembly.test（源码窗口断言对工厂签名敏感）。
