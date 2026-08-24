# Handoff — 工作区归属架构根治（2026-08-24）

> **任务授权**（用户原话要点，全权委托）：
> 「今天直接根治这个毛病。我不管你是逐字节逐行抄别人的代码和实现，还是自己设计更合理的系统，我今天必须要根本性地解决架构上的问题。」
> 「这个事今天全权交给你来做，最后我要拿到一个正常的架构。我不要求它精妙至极，我只要求它至少也得是我们已知的成熟实现。」
>
> 本文档自包含：接手会话读完本文 + `AGENTS.md` + `CONVENTIONS.md` + `INVARIANTS.md` 即可开工，无需重读会话历史。

---

## 1. 现状快照

- **已 commit**：`8459f1a1`（fix(agent): 无 Key 冷启动后配置 Provider 即刻生效——三断点死路根治）。
  修了：`applyAgentConfig` 增加「Agent 缺席 → 全量装配」分支；persistence 行向占位工作区投递信号；占位工作区记忆化（`_placeholderWs`）；文案更新；两个守护测试（`provider-hotswap.test.ts` 改 + `persistence-signal-routing.test.ts` 新增）。
  **该修复已验证无效于用户的真实现场**（用户跑过 `cargo tauri build` 的新 EXE，症状仍在）。它会在本次架构重做中被部分吸收/替换，其守护测试需随语义改写。
- **用户症状（原始报告）**：配置好 provider 之后，会话侧恒提示「当前没有活跃会话——请在设置中配置 API Key 后重启应用」，重启无效。出处：`PaperPanel.tsx` / `SpineRack.tsx` / `SessionsHome.tsx` 的发送前置守卫（`sess.activeIdx < 0 || !sessions[activeIdx]`）。
- **未确认疑点**（根治后自然消灭，但记录在案）：症状仍存说明断点在 ④「装配内部静默失败」——`factory()` 内 `runtime.createAgent` 返 null（无提示）或 `_setupAgentInner` 中途 throw（只进 console）。用户 DevTools 被屏蔽（F12 打不开），无现场证据通道。
- **用户环境**：Windows，`D:\HoloGramHG`；DSH 参考实现在 `D:\useful\deepseek-harness`。

## 2. 根因诊断（已与用户充分对齐）

### 2.1 架构级病根：存在性依赖倒挂

```
兰台现状：配置快照 ──构造──> Agent ──装配成功──> 会话列表
         （任何一环断 → 会话整列消失，症状全同）
DSH 形态：会话记录（持久化，恒在）＋ 配置在使用点解析（每请求现取）
         （配置断了 → 会话照常显示，发送时报错）
```

三个具体断齿：

1. **会话列表存在性挂在 Agent 装配上**。`resetSessionState`（chat-session.ts:150）只在 `setAgent(agent)` 成功时建「案卷 1」；`setAgent(null)`（chat-core.ts:305）清空会话列表 + 注销工厂。无 Key 冷启动 → `_setupAgentInner`（workspace.ts:717）走拆除分支 → `autoRestoreLastSession` 被 `if (!getAgentFactory(...)) return`（chat-session.ts:772）拦住 → **历史案卷不恢复 → 用户看到空会话列表**。这是用户症状的第一现场。
2. **Workspace 双注册表 + 影子占位实例**。真工作区在 `shellRefs.workspace`（单槽）；占位工作区 `Workspace.placeholder()` 不进槽（现在记在 `rows/workspace.ts` 模块变量 `_placeholderWs`）。`switchWorkspace` 只 deactivate 槽里的——占位实例永生（runtime/监听器/fiber 泄漏）。每个信号路由点都要「猜」投给谁（persistence 行的三分支 if-else 就是猜的痕迹）。
3. **配置（尤其凭据）烘焙进构造**。factory 闭包构造时调 `loadSettingsWithSecrets()` 拿快照；无 Key → factory 返 null → Agent 不存在。凭据本应在使用点解析（DSH：`resolveApiKey` 每请求现取，`Models` 集合不持有 key）。配套病：装配失败静默（只进 console；违反宪法「错误不静默」）。

### 2.2 与宪法的冲突

- 双注册表 → 违反 `docs/adr/project-constitution.md`「单一权威源」
- 装配失败静默 → 违反「错误不静默」
- 用户点破的本质问题：「为什么存在『绑没绑过目录』这个状态？会话难道不是跟工作区绑定的吗」——会话归属靠切换时整体覆写副作用维系，无一等指针/数据。

## 3. DSH 对标事实源（接手者直接读这些文件）

| 主题 | 文件 | 核心机制 |
|---|---|---|
| 工作区注册表 | `D:\useful\deepseek-harness\packages\workspace\workspace\src\index.ts` | `WorkspaceRegistry`（cordis Service）：KV 持久化 + `enqueueOperation` 写链串行 + 两阶段写/pending marker/崩溃恢复 + **`validateStoredState` 启动验账，账不平直接 throw** |
| 会话归属 | 同上目录 `entity.ts` + `types.ts` | `WorkspaceRecord = {id: uuid, path: canonical, sessionIds[]}`；`attachSession` 双重校验（id 在册 且 header canonical cwd === workspace path），缺一拒绝写入 |
| 客户端工作区投影 | `packages\client\runtime\src\client\workspaces\service.ts` | `connectWorkspace` 复用/创建 blank session；`startInitialSelection` 启动一次性默认选中 |
| 会话创建 | `packages\client\runtime\src\client\sessions\manager.ts`（:536） | **`session.create` births the full Session+Agent — the client holds no intermediate state**；`{workspaceId}` 或 `{cwd}` 二选一（schema 强制互斥，`packages\host\apiproxy\src\api\sessions.schema.ts:102`） |
| Provider 配置 | `packages\llm\llm-pi-ai\src\index.ts`（:240-318）+ `adapter.ts` | settings section + `onChange` → 注册表**原子换路由集**（失败保留旧集 + logger.error）；每次解析产出**不可变快照**，配置变更建新集合不改在用集合 |
| 凭据 | 同上 `adapter.ts`（:1-70 头注） | **凭据不进 Models 集合**：每请求经 `resolveApiKey(provider, profile)` 现解析、冻结单次；命名引用 miss → `MISSING_CREDENTIAL` fail-loud，不回退 |

## 4. 根治设计（已定型，接手者不必重新设计）

**终态定义**：
1. 会话列表的真相源 = 磁盘（已有 L0 `_ledger.json` + 会话文件 + 用户级目录），内存 sess store 只是投影。**会话的显示不依赖 Agent 是否装配成功**。
2. Agent/句柄 = 惰性资源（已有 `ensureSessionAgent` 惰性水合机制），拟文时按需建，失败 = 可见错误提示，会话不动。
3. **Key 与 provider 配置在使用点解析**——Agent 构造不看 Key；无 Key 的表现是「请求时报错」而非「会话/Agent 不存在」。
4. Workspace 唯一注册表：`shellRefs.workspace` 单槽即唯一事实源，占位工作区 = 槽里的普通条目（path=''），影子实例/模块变量/三分支路由全部删除。
5. 装配失败必可见：agent-panel-store `setDiag`（已有通道）+ pushStatus。

**分五个 Phase 实施，每 Phase 独立可验证、可 commit：**

### Phase A — Workspace 单槽统一（小改动，先做）
- `src-ui/src/shell/runtime.ts` / `rows/workspace.ts`：占位工作区也进 `shellRefs.workspace`（不再有「placeholder 不进槽」的语义分裂）。`setupPlaceholderAgent`：槽里有就复用；`_placeholderWs`、`getPlaceholderWorkspace()` 全删。
- `src-ui/src/shell/rows/persistence.ts`：信号路由坍缩为单分支（查 `refs.workspace`），上轮加的占位投递分支删除；`tests/persistence-signal-routing.test.ts` 相应简化。
- **核对点**：`switchWorkspace`（rows/workspace.ts:74）从占位（path=''）切真目录时走 `deactivate` 链——`saveActiveSession('')` 的行为（path='' 语义 = 用户级目录，`loadSessionFromDisk(projectPath='')` 已有此语义，确认保存侧同构）；`workspace_activate {path:''}` 清后端绑定已有（rows/workspace.ts:188）。
- 风险：占位工作区被 deactivate 时其 fiber/runtime 正确拆除——`deactivate` 走 `fiber.dispose()`（workspace.ts:536-564），已有机制，重点验证。

### Phase B — 会话存在性脱离 Agent 装配（核心一刀，根治用户症状）
- `src-ui/src/workspace.ts` `_setupAgentInner` 无 Key 分支（:717）：**不再 `chatPanel.setAgent(null)` 清会话**。工厂照常注册（无 Key 时 factory 返 null 的语义保留到 Phase C 消灭它）；然后**照常调 `chatPanel.autoRestoreLastSession(this.path)`**。
- `src-ui/src/ui/chat-session.ts` `autoRestoreLastSession`（:771）：去掉 `!getAgentFactory(...)` 前置拦截——恢复**内容层**（sess 列表 + msgStore + 纸面）不需要 Agent。`restoreFromLedger`（:1026）里活跃卷的「真句柄」创建改为惰性：活跃卷也只恢复内容层，句柄留给 `ensureSessionAgent`（切卷/拟文时按需建——该机制已存在，:313）。
- `sendMessage`（chat-core.ts:927）已有 `ensureSessionAgent` 兜底——保留，无 Key 时它返回 false → addNotice「请先配置 API Key」，**会话还在，只是发不出去**。这就是 DSH 形态。
- ⚠️ **冻结文件警示**：`ui/chat-session.ts` 是冻结文件（INVARIANTS 头注 + CONVENTIONS §1.1）。本次改动是其核心状态机语义的架构级需求（用户全权授权），但动手前必须：逐条核对文件内 `⚠️ INVARIANT` 注释；保住 INVARIANTS #2/#3（streaming 写 session 缓存、streamingAssistantId 不清空）；不动 streaming 语义本身。
- 效果验收：无 Key 冷启动 → 案卷列表从磁盘照常恢复显示 → 发消息 → 「请先配置 API Key」→ 设置里配 Key 保存 → **直接发送成功**（ensureSessionAgent 现场建句柄），全程无重启、无「会话消失」。

### Phase C — Agent 构造与 Key 解耦：配置在使用点解析（深改，对齐 DSH 纯血形态）
- `src-ui/src/workspace.ts` factory（:938）：删掉 `if (!act.apiKey ...) return null`——Agent 恒可构造。
- 落点（二选一，实施时按侵入面定）：
  - **甲**（provider 层，推荐）：`provider/openai.ts` / `anthropic.ts` 的 stream 入口每次现解析 active provider 配置（baseUrl/model/key 经 `loadSettingsWithSecrets()` / credential 缓存），provider 对象降级为「无状态协议适配器」。注意 pricing/contextWindow 同为构造烘焙，一并移到使用点或随 profile 现解析。
  - **乙**（agent 运行时 seam）：保持 provider 引用，但在每次 run 前 rebuild。侵入面更小，但保留「换引用」传播链，不彻底。
  - 倾向甲；若 token 计数/压缩等消费 pricing 的链路过深，先甲后补。
- `applyAgentConfig`（workspace.ts:606）大幅缩编：恒 swap 热切换退役（provider 无状态化后无需换引用），保留协作模式分支。**`tests/provider-hotswap.test.ts` 守护语义整体改写**（P14 退役落账）。
- 凭据解析频率注意：`loadSettingsWithSecrets()` 每请求一次 IPC 太贵——加内存缓存 + `credential_store/delete` 写穿失效（或 settings 保存信号失效）。DSH 对应物是 credentials service。

### Phase D — 装配失败必可见（小）
- `_setupAgentInner` / factory 的 throw 与 null 返回路径：`useAgentPanelStore.getState().setDiag(...)` + `pushStatus(...)`，不只 console.error。`persistence.ts` 的 catch 同理。

### Phase E — 测试收口（贯穿，最后跑全量门禁）
- 重写：`provider-hotswap.test.ts`（语义变化）、`persistence-signal-routing.test.ts`（单落点）。
- 新增守护：「无 Key 冷启动 → 会话列表从磁盘恢复（非空）→ 配 Key → 不重启直接可发」端到端形态测试（vitest 层面 mock credential 往返）。
- 门禁（顺序跑，全绿才算完）：`cd src-ui && npx biome check --write <改动文件>` → `npm run build` → `npx vitest run`（注意先清 `NODE_ENV=production`；`tool-contract-doc` 在全量并行下有已知 5s 超时假红，单跑验证）→ `npm run verify:convergence`（动了 agent/composition 层必跑，standard preset 零漂移是硬门禁）→ Rust 侧零改动则免 cargo。
- **每完成一个 Phase 就 commit**（断连频繁，落盘优先）。

## 5. 关键文件地图（改动面）

| 文件 | Phase | 角色 |
|---|---|---|
| `src-ui/src/workspace.ts` | A/B/C/D | 工厂、setupAgent、applyAgentConfig、deactivate |
| `src-ui/src/shell/runtime.ts` + `shell/rows/workspace.ts` | A | ShellRefs 单槽、占位装配 |
| `src-ui/src/shell/rows/persistence.ts` | A | 信号路由坍缩 |
| `src-ui/src/ui/chat-session.ts` ⚠️冻结 | B | autoRestore/restoreFromLedger 去 factory 依赖 |
| `src-ui/src/app/chat/chat-core.ts` | B | setAgent(null) 语义收窄（不再清会话列表——注意 :305 分支与 disposePanelMessages 的连带） |
| `src-ui/src/provider/*.ts` + `settings.ts` | C | 使用点解析 + 凭据缓存 |
| `src-ui/src/agent/agent-session-state.ts` | B | 无改或微调（工厂注册语义） |
| `src-ui/src/app/panels/PaperPanel.tsx` / `SpineRack.tsx` / `SessionsHome.tsx` | B | 「无活跃会话」守卫自然失效，保留作防御 |

**明确不动**：`.github/workflows/ci.yml`、engine/、src-tauri/（本次零 Rust 改动）、graph-layout/gpu-layout、store 层（state/messages-store 等健康）、消息模型层、convergence baseline（如必须变走 change request 流程）。

## 6. 沟通约定（用户偏好，接手者必读）

- 中文交流；**说人话**，用户明确反感黑话轰炸（曾抱怨「你这个问题问的是什么东西啊」）。
- 用户深度参与架构判断，会挑战设计（「为什么存在绑没绑过目录」就是他点破的）——有疑点摆事实讲因果，不要替用户脑补。
- 用户断连频繁：**每阶段落盘/commit**，长任务先写进度再干。
- 现场调试受限：用户 DevTools 被屏蔽（F12 无效），拿不到 console 证据——推理靠读代码，验证靠测试与用户实测回报。

## 7. 进度状态

- [x] 调查 + 三断点止血修复（commit `8459f1a1`，被用户实测证伪为不彻底）
- [x] 架构病根诊断（存在性依赖倒挂 + 双注册表 + 配置烘焙）
- [x] DSH 对标（事实源清单见 §3）
- [x] 根治设计定型（§4，用户已拍板「直接根治、不要过渡方案」）
- [x] Phase A — 单槽统一（commit `afe93298`；含交接未预见的修正：`saveActiveSession`
      去 `!projectPath` 早退——零目录会话此前**从不落盘**的数据丢失一并修复；
      `appendLastMessage` 保留空路径守卫，Rust `session_append` 空路径写相对路径）
- [x] Phase B — 会话存在性脱离装配（commit `5570a7b2`；所有卷（含活跃卷）只恢复
      内容层 + `ensureBaselineSession` 兜底建卷 + `setAgent(null)` 收窄 +
      `ensureSessionAgent` 回填源改 `readVolumeData`）
- [x] Phase C — 配置使用点解析（commit `8adf5c69`；新增 `provider/live.ts`
      `createLiveProvider` + `provider/credentials.ts` 凭据缓存写穿失效；
      P14 恒 swap 退役 → 身份变更才换引用；Agent/AgentHandle 新增 `setPricing` 链）
- [x] Phase D — 装配失败必可见（commit `ae3eaad5`；pushStatus + setDiag 双通道；
      fire-and-forget 补建收敛 `hydrateSessionAgentVisible`）
- [x] Phase E — 测试收口（`provider-hotswap`/`persistence-signal-routing`/`chat-epoch-guard`
      重写 + 新增 `provider-live.test.ts` / `no-key-cold-start.test.ts` 端到端守护）
- [ ] 用户验收：真机配 Key → 不重启 → 会话在 → 能发消息（待用户实测回报）

> 五 Phase 全部落地后的行为形态（与 §4 终态定义逐条对应）：
> 1. 会话列表真相源 = 磁盘，显示不依赖 Agent 装配（B）；
> 2. Agent 恒可构造，句柄惰性，失败 = 可见错误（B/C/D）；
> 3. Key 在使用点解析（live provider），无 Key = 请求期 `MISSING_CREDENTIAL`
>    响亮报错（C）；
> 4. `shellRefs.workspace` 单槽即唯一注册表，占位 = path='' 普通条目（A）；
> 5. 装配失败经 pushStatus + setDiag 双通道可见（D）。
