# 创作坞 + 提供方（Provider）联合体检报告 · 方案甲定案

> 日期：2026-08-27（合并稿）；2026-08-26 修复施工落账；2026-08-26 夜在册小账收尾（D2/C5/D5）
> 来源：两份独立体检合并——①提供方链路审计（provider/settings/credentials/目录/热切换/代理）②创作坞体检（ComposerDock/compose-store/ModelSelector/输入历史/斜杠/插件挂载）。
> 性质：代码面体检，未改代码；部分结论需实机复验确认。
> 合并核验：两报告重叠项（A1/A2）已互证一致；创作坞报告的 B 组/C1 断言在本窗口逐一 grep/read 复核属实（`inputHistoryIdx` 全工程无读者、`registerComposer` 无调用方、chat-core.ts:1018 全局阻断、:998-1015 静默注入均实证）。唯一口径修正：原「B1 打开时永远不列全」——已选模型时成立（常见路径），模型为空时全表分支可触发。

## 条目来源标记

- 【共同】两份报告独立命中，互为证据
- 【提供方】仅提供方链路审计发现
- 【创作坞】仅创作坞体检发现

---

# 第一部分 · 体检结论

## 一、架构/行为级（最深的坑）

### A1. 「每会话模型/思考偏好」是显示层谎言——运行时所有会话共用同一个全局 active provider【共同】

- **现象**：创作坞声称「每会话持完整状态对象，切会话 = 指针换向」；但模型/思考热切换实际是**全局生效**的，会话偏好只决定 UI 显示。
- **证据**：
  - `src-ui/src/state/compose-store.ts:87-107` `setModel` 写全局 `activeProvider` + `updateProvider(s, providerName, {model})`，发 `model-switched` 信号；
  - `src-ui/src/workspace.ts:604-657` `applyAgentConfig` 用 `getActiveProvider(s)` 取唯一 provider，然后 `agentSessionState.forEachAgent((h) => h.setProvider(prov, pricing))` **同步到全部活句柄**；
  - `src-ui/src/workspace.ts:951-958` 工厂建句柄只读全局 active，`ComposeSessionPrefs` 从未进入 Agent 装配；
  - `src-ui/src/app/panels/ComposerDock.tsx:170-185` 只拿 prefs 做展示。
- **后果（实机会直接感受）**：
  1. 卷 A 切 anthropic/Y → 所有会话（含后台跑着的卷 B）下一条消息全部变成 anthropic/Y 计费——多会话互相污染，爆炸半径是全部会话；
  2. 卷 B 的创作坞仍显示旧偏好（deepseek/X），但发送实际走 anthropic/Y——**显示与真实发送不一致**；「每会话隔离、切回不重算」的承诺落空。
- **对照 DSH**（D:\useful\deepseek-harness）：`sessions.selectModel({sessionId, provider, model, effort})` 是真 per-session；host 验证后在 assembly 期快照（`packages/core/agent/src/model-selection.ts` 的 `selection.assembled`），并发切换在下个 step 生效、不撕裂。
- **修复**：见第二部分方案甲。

### A2. `setThinking` 把思考档位写错 provider【共同】

- **证据**：`src-ui/src/state/compose-store.ts:109-121` 写盘用 `getActiveProvider(s)`（全局活跃），不是当前会话 prefs 里的 `providerName`。`tests/compose-store.test.ts:103-110` 甚至把这个错误行为固化成用例。
- **后果**：会话 prefs.providerName ≠ 全局 activeProvider 时（A1 下必然发生），档位落盘到错误 provider 的设置行；且档位合法性是对着显示模型的目录声明校验、写入的是另一个模型，重启后档位丢失/错位。
- **修复**：随方案甲自动消除（会话改动不再写全局）；现有测试需改回真语义。

### A3. 三条发散路径，无回同步【提供方】

A1 的必然推论——显示与实际发散后没有任何机制收敛：

1. 卷 A 切模型拖累卷 B 的 Agent（forEachAgent 全量换 provider），但 B 的 compose prefs 不更新 → B 界面显示旧 provider/model，实际用新的；
2. 设置面板保存（`settings-saved` 信号）→ applyAgentConfig 换了 Agent，但 **compose-store 不监听**，所有会话的创作坞继续显示陈旧 prefs；
3. `setThinking` 落错行（= A2）。

**修复**：随方案甲根治（会话级真源 + 全局默认实时解析，发散面消失）。

### A4. localStorage 全量快照，多写者互相 clobber【提供方】

- **三个写者，last-writer-wins，无版本控制**：
  - 写者①：SettingsPanel 保存管线 `runSavePipeline`（整份 state 落盘）；
  - 写者②：`persistSettings`（测试连接时落盘，见 B4）；
  - 写者③：compose-store `setModel`/`setThinking` 直接 `saveSettings`（绕过设置面板的暂存语义）。
- **场景**：设置面板开着、暂存了 baseUrl 改动 → 用户去创作坞切了下模型（写者③落盘）→ 回设置面板点保存 → **面板的整份快照把刚切的模型覆盖回去**。
- **与方案甲的关系**：方案甲 §二.5 拆除写者③（会话改动不再写全局）→ clobber 面收窄为写者①②，但 B4 不修则②仍在。

## 二、功能错误（P1）

### B1. ModelSelector 紧凑形态「打开不列全」，P2-1 跨 vendor 直选没兑现【创作坞】

- **证据**：`src-ui/src/app/panels/ModelSelector.tsx:183-187` 触发器 onClick 里 `setQuery(value)`（把当前模型 id 预填进搜索框）→ `results` 走 `searchModels(value)` 分支（`:41-68`），「空查询列全部已配置 provider」分支（`:50-60`）在已选模型的常见路径下**永不触发**（口径修正：模型为空时全表分支可触发）。
- **后果**：点模型下拉，看到的不是「全部已配置 provider」，而是按当前模型 id 搜出的结果（通常 1 条）；自定义模型直接「无匹配模型」。必须手动清空输入才看得到全表——与 rework P2-1 声明不符。
- **附带限制**：`:65` `.filter((m) => m.kind === kind)` 只留同协议 provider——openai 兼容 ↔ anthropic 协议在创作坞里互切不了。
- **修法**：compact 打开置空 query（恢复「空查询列全部」语义）。

### B2. 搜索可选「未配置厂商」的模型 → 写错行 → 400【提供方】

- **证据**：搜索走全目录 `searchModels(q)`，只按协议 `kind` 过滤；`ComposerDock.tsx:30-40` `providerNameForModel` 找不到对应 provider 时 fallback 到当前 provider。
- **后果**：搜 "gpt" 时 openai 家模型（kind=openai）会列出，但用户没配置 openai 这个 provider → **把 `gpt-5.2` 写进 deepseek 的 model 字段** → 请求 400 model_not_found。
- **对照 DSH**：目录只列 host 报告的 groups，选不了不存在的路由。
- **修法**：创作坞选择面只列已配置 provider 的模型（未配置厂商不出现或显著标记）；跨协议限制（B1 附带）一并决策。

### B3. 无 routable 守卫：可静默切到无 Key 的 provider【提供方】

- **证据**：出厂自带 deepseek/anthropic 两个 provider 行（无 Key 也算「已配置」），compact 空查询全列出；选中 anthropic 模型 → 全局 activeProvider 切到无 Key 行（叠加 A1 = 所有会话一起切）。
- **后果**：下一条消息 MISSING_CREDENTIAL。请求期报错是 Phase C 的设计（fail-loud），但**选择器零提示零拦截**，且爆炸半径是全部会话。
- **对照 DSH**：`routable === false` 时 composer 直接禁用输入并说明原因（`ui-model-selection/service.ts` 的 conversation.blocks 机制）。
- **修法**：选择器标注无 Key 厂商；或选中即提示「该提供方未配置 Key」。

### B4. 「测试连接」隐性提交全部暂存改动，取消不再复位【提供方】

- **证据**：`ProviderPage.handleTest` → `onPersistSettings(updateProvider(settingsRef.current, name, {lastTest}))`；`persistSettings` 是 `setSettings(next); saveSettings(next)`（SettingsPanel.tsx:172-175）——**落盘的是整份 state，含所有未保存的 baseUrl/model/maxTokens 改动**。注释说「非配置类状态（如测试结果）」，实现是全量提交。
- **后果**：用户测完点「取消」，改动其实已经在盘上；关闭确认弹窗说「未保存的更改将丢失」，实际早已保存——言行不一。
- **修法**：测试结果落盘走「读盘-改 lastTest-写回」最小面，或暂存语义分离（lastTest 不与配置共用提交通道）。

### B5. ↑ 历史键不循环：永远取同一条，`inputHistoryIdx` 是死状态【创作坞】

- **证据**（已复核）：`src-ui/src/app/panels/ComposerDock.tsx:412-422` 每次 `history[history.length - 1]`；`inputHistoryIdx` 只在 `input-store.ts` 定义、`chat-core.ts:544` 写 `-1`，**全工程无任何读者**。
- **后果**：连续按 ↑ 永远回到最近一条；没有 ↓ 前进；placeholder「↑ 取历史」暗示的浏览行为是坏的。`inputHistoryIdx` 是写了一半没接完的历史导航。
- **修法**：接上 `inputHistoryIdx` 走历史浏览（↑ 回退 / ↓ 前进）。

### B6. 斜杠命令 fill 后焦点不还给输入框【创作坞】（合并时扩大了爆炸半径）

- **证据**（已复核）：`src-ui/src/app/chat/chat-core.ts:1398-1402` fill 分支 `this._composer?.focus()`——`registerComposer`（:232-233）**全工程已无调用方**，`_composer` 恒 null。
- **合并复核补充**：死的不止 fill 一处——chat-core.ts 内 **9 处 `_composer?.focus()/selectEnd()` 全部死链**（:207、:385-402 三处、:1231-1232、:1306、:1332、:1400-1401），含会话恢复后的焦点回归路径。修复时应一并接活，不只是 B6 场景。
- **修法**：ComposerDock 注册 focus 回调给 core（`registerComposer` 或等效）。

### B7. 后台会话运行无指示 + 停止钮只管活跃卷，但发送被全局阻断【创作坞】

- **证据**（已复核）：`src-ui/src/app/panels/ComposerDock.tsx:138-151` 只订阅活跃会话的 exec；`chat-core.ts:1017-1019` 任一后台会话在跑就拒绝新轮次（「有后台任务正在运行中」）。
- **后果**：用户在 A 卷，B 卷在后台跑——创作坞没有「停」、没有任何运行指示，一按发送被弹提示，且无从从创作坞停掉它。认知断裂。
- **修法**：归入「运行态感知」一组：创作坞加全局运行态（哪个卷在跑 + 全局停止）。

## 三、交互/UX（P2）

### C1. 运行中按 Enter 会静默注入运行中会话，无提示【创作坞】（已复核 chat-core.ts:998-1015）

- Agent 运行中发送被当成「向进行中的回合插话」（insertMessage 路径，无任何 notice）。placeholder / UI 都没说明这个语义，用户可能误以为 Enter 无效或被吞字。

### C2. 切卷不清理本地态：`localNotice`、思考展开 `settingsOpen` 跨会话残留【创作坞】

- `ComposerDock.tsx:72-73` 两者都是组件本地 state，切卷（activeSessionId 变）不重置。A 卷弹的「当前没有活跃会话」会残留到 B 卷；思考展开面板在切卷后仍开着。

### C3. 斜杠面板无键盘导航、无 Esc 关闭【创作坞】

- `ComposerDock.tsx:357-366` 斜杠列表只有鼠标点击；无上下键选、无 Esc。而 ModelSelector 那套键盘交互（:146-172）是全的——同一创作坞里两套交互标准。

### C4. 每击键全量 `loadSettings()`（localStorage JSON.parse）【创作坞】

- `ComposerDock.tsx:174-180` 每渲染调用；输入 onChange → 本地 state → 每键重渲 → 每键一次 localStorage 读 + JSON.parse。打字热路径不该做这个。
- **与方案甲的关系**：方案甲 §二.6 改显示层时一并处理（prefs 缺省回落全局走订阅/缓存，不走每渲染全量读）。

### C5. 模型目录是前端静态 JSON，无失败面【提供方】

- `mergeDynamicModels` 全局合并、`fetchModels` 失败静默返回 []，用户完全无感；静态目录数据 stale 无提示。
- **对照 DSH**：`SessionModels` 分 `groups`（last-good 保留）+ `failures`（per-provider 失败可见）+ `routable`。兰台缺整层失败反馈。
- **修法**：与 B3 routable 守卫同一批做（选择器加失败/降级标注）。

## 四、健壮性/工程（P3/P4）

### D1. `getActiveProvider` 对 `providers: []` 返回 undefined → `.name` 崩【提供方】

- `settings.ts:263-266`，`active || s.providers[0]`——空数组时 undefined。localStorage 腐坏（parsed.providers=[] 覆盖 DEFAULTS）时 `_buildProvider` 里 `getActiveProvider(settings).name` 直接 TypeError。compose-store 的 `snapshotFromGlobal` 有 try/catch，workspace 没有。
- **修法**：`getActiveProvider` 空表兜底（回 DEFAULTS 首行或抛带上下文错误），或 loadSettings 合并时校验 providers 非空。

### D2. 每个热切换信号全量 restoreSecrets IPC【提供方】

- `applyAgentConfig` → `loadSettingsWithSecrets` → restoreSecrets 对每个 provider 逐个 `credential_get`（localStorage 里 key 全被 sanitize 成空，每家都查）。`provider/credentials.ts` 明明有缓存，但 restoreSecrets 不走它。切一次模型 = N 次 IPC，只为算个诊断用的 keyLen。
- **修法**：随方案甲施工——applyAgentConfig 重写为按会话解析时，诊断信息改走 `resolveApiKey`（有缓存）。

### D3. thinking 双写者语义不一致【提供方】

- ProviderDetail 的 thinking 改动走暂存（随「保存 Provider」落盘）；compose-store 的 setThinking 立即落盘。同一字段两种 save 语义，叠加 A4 又是一个 clobber 面。
- **修法**：方案甲拆掉 compose-store 写者③后，剩余面收窄；ProviderDetail 暂存语义保持，文档里写清。

### D4. 遗留数字 thinking 被 select 静默清成 ''【提供方】

- `ProviderDetail.tsx` select value 三元：存量值（如 "4000"）不在档位表里就显示「自动」，一旦 onChange 就写成 ''。历史预算静默丢失（小账）。

### D5. 创作坞几乎没有组件行为测试【创作坞】

- 现有覆盖只有：`tests/compose-store.test.ts`（store 层，还把 A2 当正确行为固化）、`tests/stage4-compose-dock.test.ts`（插件注册）、`tests/paper-v3a.test.ts`（ime 谓词）。
- **↑历史、斜杠、模型选择展开、fill 焦点链、每会话显示一致性（A1）全部无测试**——所以 B1/B5/B6 这类 bug 能一路绿到底。

### D6. 已知「待实机复验」清单仍未勾销（`docs/plans/canvas-space/stage-4-rework-checklist.md:133-148`）【创作坞】

- P0-1 全放确认 + 关窗崩溃、P1-1 自动选中三道闸、P1-2 目次带/书脊聚焦落点、P3-1 非全屏布局——均「代码面已修、实机未复验」，与「全身上下都是毛病」的体感直接相关。建议按清单真机过一遍再勾销。

---

# 第二部分 · 方案甲定案（已拍板）

> 语义一句话：**全局 = 新卷/未改卷的实时默认；会话 = 只存自己的覆盖；运行与显示都按会话解析。**

## 一、定案语义（已闭环，无悬而未决点）

1. **会话级生效**：每个会话有自己的 providerName / model / thinking，发送时实际使用该会话自己的配置，而不是全局单 provider。
2. **全局设置 = 默认值**：全局 `activeProvider` + provider 的 model/thinking 只作为「新卷出生 / 未改过卷」的实时默认。
3. **未改过的卷跟随全局**：没有自己的覆盖时，显示和运行时都实时解析全局默认；不冻结快照。
4. **改过的卷不跟随全局**：一旦在某卷显式改了模型/思考，该卷使用自己的覆盖值；之后全局默认怎么变都不影响它。
5. **会话改动不写全局**：在创作坞改某卷的模型/思考，一行都不碰全局设置。
6. **持久化**：会话的覆盖值随卷落盘，重启后仍在（否则「会话级」重启即破功）。

## 二、实施落点（已核实代码缝）

### 1. 有效配置解析（核心）

```
effective(sessionId) = 会话覆盖 prefs ?? 全局 active provider
```

- `src-ui/src/state/compose-store.ts`：`ensurePrefs` 去掉「首次触碰就快照冻结」语义；prefs 只在用户显式改动某卷时才落条目。
- 展示侧（`ComposerDock.tsx:154-185`）：`prefs` 缺省时回落 `snapshotFromGlobal()`，不写盘。

### 2. 工厂带 sessionId

`AgentFactory` 现在是 `() => Promise<OwnedAgentHandle | null>`，建句柄时用全局 active（`workspace.ts:951-958`）。

- 扩展为 `(sessionId: number) => ...`（或等效传参）。
- 三个调用点：
  - `src-ui/src/ui/chat-session.ts:321-324` `ensureSessionAgent`（知道 sid）
  - `src-ui/src/ui/chat-session.ts:450-453` `createNewSession`（新卷 = 全局默认）
  - `src-ui/src/ui/chat-session.ts:946` `loadSessionFromDisk`（知道 sid）
- 建句柄时按该会话 effective 配置传 `provider`（`createLiveProvider(会话providerName)`）、`pricing`、`contextWindow`。

### 3. 热切换只打目标会话

- `compose-store.setModel/setThinking` 改动后：解析该会话 effective 配置 → `agentSessionState.getAgent(storeId, sid)?.setProvider(...)` + `setThinking` + `setContextWindow`，**不再 `forEachAgent` 全量轰炸**。
- `workspace.ts:604-657` `applyAgentConfig`：
  - `model-switched` / `thinking-changed` 改为「按会话」语义；
  - `settings-saved` 改为逐会话重解析（`agentSessionState.forEachAgent` 需带上 sessionId，或新增 `entries()`）。

### 4. 持久化（甲必做）

- `SessionSnapshotData` 增加 `compose` / `prefs` 字段（同 `paper` 模式）：
  - 写盘：`src-ui/src/ui/chat-session.ts:640-668` `writeSessionSnapshot` 链路，`saveActiveSession` / `saveSessionById` 捕获 `getComposeStore(...).getPrefs(sid)`。
  - 读盘：`readVolumeData` 恢复时回填 compose-store（`loadSessionFromDisk` / 恢复路径）。
- 合卷时 `removePrefs` 已存在（`chat-session.ts:403`），保留。

### 5. compose-store 写语义反转（A2 自动消）

- `setModel`：不再写 `activeProvider`、不再 `updateProvider(s, providerName, { model })`（`compose-store.ts:87-107` 那两处是 A1/A2 的根）。
- `setThinking`：不再写全局活跃 provider（`compose-store.ts:109-121`）。
- 只写会话覆盖条目 + 通知该会话句柄热切换。

### 6. 组件显示

- `ComposerDock.tsx`：prefs 缺省时显示全局默认（实时），不再等 `ensurePrefs` 落快照。

## 三、测试改动

- 重写 `tests/compose-store.test.ts`：
  - `setModel` / `setThinking` 不再断言「落全局活跃 provider」（原 `:103-110` 是错误行为的固化）。
  - 新增：会话覆盖隔离、未改卷回落全局、改过卷不跟随全局。
- 新增：`effective(sessionId)` 解析单测。
- 新增：会话 prefs 随卷落盘/读盘往返测试。
- 既有草稿/ime/插件注册测试保持不动。

## 四、与提供方层修复的交叉影响（合并稿新增）

- **A4 clobber**：方案甲 §二.5 拆掉 compose-store 全局写者③ → clobber 面收窄为写者①（保存管线）②（测试连接）；B4 不修则②仍在，建议同批处理。
- **B2/B3 选择面守卫**：并入方案甲 §二.6 组件显示工作——compact 列表只列已配置 provider（未配置厂商不出现），无 Key 厂商显著标注；跨协议限制（B1 附带）在此时一并拍板（列出不选 or 允许切协议）。
- **D2 IPC 风暴**：applyAgentConfig 重写为按会话解析时，诊断信息改走 `resolveApiKey`（有内存缓存），不再全量 restoreSecrets。
- **D1 崩溃兜底**：工厂按会话解析 provider 名时必然触碰 `getActiveProvider` 附近逻辑，顺手加空表兜底。
- **风险同原案**：provider 是「按名 live 适配器」（`createLiveProvider`），会话级无需重量级实例，主要工作是「解析入口从全局改成按会话」；`defaultPricing` / `_effectiveContextWindow`（`workspace.ts:638/707-710`）要按会话 model 计算；子 Agent / code_execution 继承父句柄 provider，随会话作用域自然成立；B4（后台运行无指示）不在本次范围。

## 五、修复建议路线（合并版）

1. **方案甲施工**（A1/A2/A3 根治 + 持久化 + 工厂 sessionId + 测试重写）——唯一已拍板的语义改动，其余 bug 修复不得与其冲突；
2. **纯 bug 批**（不涉产品决策）：B1（compact 打开置空 query）、B5（历史导航）、B6（focus 回调 + 9 处死链接活）、B7/C1（运行态感知一组）；
3. **选择面守卫批**（并入或紧随方案甲）：B2（未配置厂商不可选）、B3（无 Key 标注）、B4（测试连接最小落盘面）、C5（失败面标注）；
4. **设置面板小账批**：A4 残余写者、D3/D4；
5. **测试与实机**：D5 组件行为测试补齐 + D6 返工清单逐条实机复验。

## 六、验收口径

- 卷 A 切 anthropic/Y → 切回卷 B：B 显示并实际使用自己的配置；A 的改动不影响 B/全局设置。
- 未改过的卷在设置页改全局默认后，实时跟随。
- 改过的卷在设置页改全局默认后，保持自己的值。
- 重启后各卷的会话级配置仍在。
- 创作坞选不出未配置厂商的模型（B2）；选中无 Key 厂商有明确提示（B3）。
- 门禁：`vitest` + `build` + `verify:convergence` + `biome ci` 全绿。

---

## 附录 · 条目映射（原报告 → 合并稿）

| 原条目 | 合并稿条目 |
|---|---|
| 创作坞体检 A1 / A2 | A1 / A2（共同命中） |
| 创作坞体检 B1 / B2 / B3 / B4 | B1 / B5 / B6（爆炸半径扩大）/ B7 |
| 创作坞体检 C1 / C2 / C3 / C4 | C1 / C2 / C3 / C4 |
| 创作坞体检 D1 / D2 | D5 / D6 |
| 提供方审计 A1 / A2 / A3.1+A3.2 / A3.3 | A1 / A2 / A3 / 并入 A2 |
| 提供方审计 B1 / B2 / C1 / C2 / C3 | A4 / B4 / B2 / B3 / C5 |
| 提供方审计 D1 / D2 / D3 / D4 | D1 / D2 / D3 / D4 |

---

# 第三部分 · 修复落账（2026-08-26 施工，门禁全绿）

> 施工范围：方案甲整批 + 纯 bug 批（B1/B2/B5/B6/B7）+ 选择面守卫（B3）+ 设置面板小账（B4/D1/D4）+ 交互批（C1/C2/C3/C4）。
> 门禁实测：vitest 全量 180 文件 1762 passed / 4 skipped · `npm run build`（tsc+vite）✓ · `npm run verify:convergence`（NODE_ENV=test）exit 0 · `npx biome ci .` 0 error。
> 注：convergence 必须带 `$env:NODE_ENV='test'` 跑（Cowork 进程链注入 production 的既有环境坑，非本次改动引入）。

| 条目 | 状态 | 落点 / 修法 |
|---|---|---|
| A1 假 per-session | ✅ 已修 | 方案甲整批：compose-store 覆盖制（prefs 只存显式改动过的卷；`resolveEffective` = 覆盖 ?? 全局实时解析）；`setModel/setThinking` 不再写全局 settings，信号带 sessionId；`applyAgentConfig` 会话级分支只热切换目标会话句柄（`getAgent(storeId, sid)`）；`settings-saved` 走 `forEachAgentEntry` 逐会话重解析（覆盖卷保持自己的值、未改卷裸 live 跟随全局）；`AgentFactory` 签名带 sessionId，工厂按会话 effective 装配 provider/pricing/contextWindow |
| A2 thinking 写错行 | ✅ 随 A1 消除 | `setThinking` 只写会话覆盖；测试 `tests/compose-store.test.ts` 重写（原 :103-110 错误行为固化已拔除） |
| A3 三条发散路径 | ✅ 随 A1 消除 | 显示走 `resolveEffective`（实时），运行走工厂/热切换同源解析——显示与实际同源，发散面消失 |
| A4 localStorage clobber | 🟡 收窄 | 写者③（compose-store 全局写）已拆；剩余写者①（保存管线）②（测试连接）中②已修（B4）——三写者剩一 |
| B1 打开不列全 | ✅ 已修 | compact 触发器打开置空 query（原预填当前模型 id 把 results 锁进搜索分支）；测试新增「已选模型时打开 = 空查询全表」断言 |
| B2 搜到未配置厂商写错行 | ✅ 已修 | compact 结果面（含搜索分支）只列已配置 provider 的模型（`configured.has(m.vendor)` 过滤）；测试断言未配置厂商不出现 |
| B3 无 Key 静默可切 | ✅ 已修 | compact 分组头异步解析 Key（`resolveApiKey` 缓存），无 Key 厂商标注「未配置 Key」（CSS 徽标）；选择仍放行（fail-loud 语义保留），但预警可见 |
| B4 测试连接全量提交 | ✅ 已修 | `onPersistSettings` → `onPersistProbe(name, probe)`：面板态只更新 lastTest 展示；磁盘走「读盘-改 lastTest-写回」最小面，暂存改动不再随探针落盘 |
| B5 历史导航死状态 | ✅ 已修 | `navigateHistory` 纯函数（tests/composer-history-nav.test.ts 7 用例）；↑ 回退/↓ 前进/越出最新恢复草稿（draftText 槽）；手输退出浏览复位 idx |
| B6 焦点死链 | ✅ 已修 | ComposerDock mount 时 `core.registerComposer({focus/selectEnd})`，卸载注销——chat-core 内 9 处 `_composer?.focus()` 全部接活（含斜杠 fill 焦点回归、exec 停止后焦点回归） |
| B7 后台运行无指示 | ✅ 已修 | ComposerDock 订阅全部会话 exec（不只活跃卷）；后台有卷运行显示「⟳ 后台 N 卷运行中 + 停止」（stop = 逐卷 removeExec 级联中止）；CSS 新增 `.pp-bg-running/.pp-bg-stop` |
| C1 插话无提示 | ✅ 已修 | chat-core 插入路径补 notice「已插入进行中的回合（Agent 运行中，消息将在下轮生效）」 |
| C2 本地态跨卷残留 | ✅ 已修 | activeSessionId 变化 → localNotice/settingsOpen 复位 |
| C3 斜杠无键盘导航 | ✅ 已修 | ↑↓ 选（active 高亮 + 左缘朱砂指示）/Enter 执行/Esc 关（去斜杠触发词）；placeholder 改「↑↓ 取历史」 |
| C4 每击键 loadSettings | ✅ 已修 | 显示走「初值 + onSettingsSaved 订阅触发重读」（settingsVersion 合成触发器），打字热路径零 localStorage 读 |
| D1 getActiveProvider 空表崩 | ✅ 已修 | 双兜底：loadSettings 对空 providers 数组回落 DEFAULTS.providers；getActiveProvider 终极兜底 DEFAULTS.providers[0] |
| D4 legacy thinking 静默清空 | ✅ 已修 | select 对存量遗留值（数字预算/未知档）显式加「自定义 (N)」option，不再隐形「自动」+onChange 清空 |
| D2 热切换 IPC 风暴 | ✅ 已收窄（2026-08-26 夜追加） | `applyAgentConfig` 统一改 `loadSettings()`（同步读，providers/activeProvider/model 都在 localStorage）+ 诊断 Key 状态走 `resolveApiKey`（provider/credentials.ts 内存缓存，命中零 IPC）——热切换路径不再逐个 provider `credential_get`；request 期真实凭据仍由 live provider 按名现解析（fail-loud 语义不变） |
| D3 thinking 双写者 | ✅ 收窄 | compose-store 写者拆除后只剩 ProviderDetail 暂存通道（单写者语义自洽） |
| D5 组件测试缺口 | ✅ 补齐（2026-08-26 夜追加） | 新增 `tests/composer-dock-keyboard.test.tsx`（5 用例）：↑↓ 历史浏览（进入存草稿/↑ 回退/↓ 前进/越过最新恢复草稿/手输退出浏览/空历史不越界）+ 斜杠面板键盘导航（↑↓ 高亮/Enter 执行/Esc 关去触发词） |
| C5 目录无失败面 | ✅ 已修（2026-08-26 夜追加） | 根因：`fetchJsonWithTimeout` 对非 ok/网络/超时一律返回 null → `fetchModels` 永不 reject，失败被静默当成「无模型」（调用面 `.catch(() => {})` 永不触发）。修复：openai/anthropic `fetchModels` 失败上抛；catalog 记 per-provider 失败面（`recordDynamicFetchResult`/`getDynamicFetchFailure`，成功清标记）；compact 分组头「目录获取失败」标注（`.ms-group-fail` 虚线徽标，区别于 B3 无 Key 实线）；last-good 保留——已合并动态模型不因失败清掉（对应 DSH groups 面） |
| D6 实机复验清单 | ⬜ 未动 | stage-4-rework-checklist 的待复验项仍在（P0-1 崩溃/P1-1 三道闸/P1-2 落点/P3-1 布局）+ 本次修复的实机验收（见下） |

### 在册小账收尾（2026-08-26 夜追加施工，门禁全绿）

> 收掉 baton17 §2.2 三件代码面在册小账（实机验收仍不在本次范围）。
> 门禁实测：全量 vitest 181 文件 1771 passed / 4 skipped · `npm run build` ✓ · `npm run verify:convergence`（NODE_ENV=test）exit 0 · `npx biome ci .` 0 error。
> 追加改动文件：`src/workspace.ts`（D2 IPC 收窄 + C5 后台拉取记失败）、`src/provider/catalog.ts`（失败面 Map + 访问器）、`src/provider/openai.ts`/`src/provider/anthropic.ts`（fetchModels 失败上抛）、`src/provider/types.ts`（fetchModels 契约注释）、`src/app/panels/settings/ProviderPage.tsx`（手动刷新记失败）、`src/app/panels/ModelSelector.tsx` + `PaperPanel.css`（分组头失败标注）、测试：`tests/composer-dock-keyboard.test.tsx`（新增 5）、`tests/model-selector-compact.test.tsx`（+1）、`tests/provider-catalog.test.ts`（+3）。

**本次修复的实机验收清单**（用户过一遍才算勾销）：
1. 卷 A 切 anthropic 模型 → 切回卷 B：B 显示并实际用自己的配置（A 的改动不影响 B/全局设置）；
2. 未改过的卷：设置页改全局默认后实时跟随；改过的卷保持自己的值；
3. 重启后各卷会话级配置仍在（compose 字段随卷落盘）；
4. 创作坞模型下拉打开即列全部已配置厂商（不再只有 1 条），未配置厂商不出现，无 Key 厂商有标注；
5. 设置页测试连接后点取消 → 暂存的 baseUrl 等改动确实未落盘；
6. ↑↓ 历史浏览可用、越过最新恢复草稿；斜杠命令后焦点回输入框；
7. 后台卷运行时创作坞出现「后台 N 卷运行中 + 停止」。

**改动文件清单**（本次施工）：
- `src/state/compose-store.ts`（方案甲重写：覆盖制）
- `src/state/agent-config-store.ts`（信号带 sessionId）
- `src/provider/live.ts`（会话级 model/thinking 覆盖，setThinking 不再 no-op）
- `src/agent/agent-session-state.ts`（AgentFactory 带 sessionId；forEachAgentEntry）
- `src/workspace.ts`（applyAgentConfig 按会话热切换；工厂按会话装配；_contextWindowFor）
- `src/shell/rows/persistence.ts`（sessionId 透传）
- `src/ui/chat-session.ts`（工厂三调用点传 sid；compose 随卷落盘/恢复）
- `src/app/chat/chat-core.ts`（setAgentFactory 签名；C1 notice）
- `src/app/panels/ComposerDock.tsx`（effective 显示/B5/B6/B7/C2/C3/C4）
- `src/app/panels/ModelSelector.tsx`（B1/B2/B3）
- `src/app/panels/SettingsPanel.tsx` + `src/app/panels/settings/ProviderPage.tsx` + `ProviderDetail.tsx`（B4/D4）
- `src/settings.ts`（D1 兜底）
- `src/app/panels/PaperPanel.css`（B7/C3/B3 样式）
- 测试：`tests/compose-store.test.ts`（重写）、`tests/composer-history-nav.test.ts`（新增）、`tests/model-selector-compact.test.tsx`（扩展）、`tests/composer-dock-rework.test.tsx`、`tests/composition-preset-assembly.test.ts`、`tests/persistence-signal-routing.test.ts`、`tests/provider-hotswap.test.ts`（适配方案甲新形态）
