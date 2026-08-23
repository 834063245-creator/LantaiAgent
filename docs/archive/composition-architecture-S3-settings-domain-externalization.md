# S3 设计件 — settings 面板域第一方行化

> 立项依据：计划 README「S3 = 把 settings 面板域迁成第一方插件」· 触发条件已满足（纸壳交互欠账 C8-C12 落定，2026-08-22）。
> 本设计件是 S3 的唯一裁决记录；与本文冲突的旧 plan/handoff 以本文为准。
> 边界依据：`docs/adr/composition-boundaries.md` · patch 语义必读：`docs/composition/README.md`。

## 0. 范围与非目标

**迁**（迁入 settings 域插件行）：SettingsPanel 组件挂载 · `toggle-settings` AppAction · panel-def 常量行。

**不迁**（workspace 级关注点，留壳行不动）：settings.ts 持久化模块、agent-config-store 订阅、workspace.ts 保存钩子。

**非目标**：不动 settings.ts / agent-config-store / workspace.ts（原范围裁决）；不扩 PanelContribution 形状（§2.1）；不实现 config 通道（§2.4.1）；不迁 SettingsPanel 的 import 面（§2.4——全仓唯一 import 在 panel-def.ts，迁走后归零）；不迁 CSS（§3.1）；不动 dock-store 初始表（§3.2）；不迁外部插件 loader（§2.6）。

## 1. 现状事实（2026-08-22 调研钉死）

- 消费闭环只接了一半：面板贡献消费完整（panelDefs() 合流 + panelDefsTick + DockPanel 重挂载）；命令贡献只进 CommandPalette，`runAction` 快捷键分发面（`app/actions.ts`）不读贡献——**ctrl+, 走的是 actions 注册表，不是 CommandPalette**。
- `PANEL_DEFS` 常量面只剩 settings 一行（paper 面板 V3b 已走贡献）。
- toggle-settings / toggle-paper 两个 AppAction 都注册在壳行 `shell/rows/actions.ts`（`registerActions`）。
- ctrl+, 在 `useGlobalKeys.ts` 经 `runAction('toggle-settings')` 分发。
- `PanelContribution` 形状与 `PanelDef` 逐字段对齐（id/side/title/icon/askAgent/unmountOnClose/component），settings 行五字段全静态，零形状扩展即迁。
- 叠层无 DOM 序耦合：settings z-index 400/401 vs paper 280，显式分层，装载序变化无视觉涟漪。
- paper 域当年漏了半步：toggle-paper 动作还在壳行（面板是贡献、动作是壳行注册）。
- S2 设计件 §2.9 把「通用 config 通道」延期到「S3 settings 域落地时一并加」；但 settings 域行全是纯注册型（无 config 旋钮诉求），按 S2 立的「不为凑消费者发明假旋钮」纪律继续延期。
- 路径前缀差异：CommandPalette 折算面用 `'plugin/' + c.id`（定宽前缀）；pluginToolRows 折算面用 `'plugin/' + c.id`（同定宽前缀）；两折算面共用 `plugin/` 前缀但分属不同消费面（palette 动作清单 / 工具行表），互不寻址。
- `runAction` 缺席时静默忽略（`app/actions.ts` 31-33 行「启动早期安全」语义）。

## 1.1 S3 落地后的组合层贡献全景

S3 完工时，五 service 的第一方消费面为：

| 域 | 行 | 贡献通道 | 贡献源 |
|---|---|---|---|
| panels | `settings` | ctx.panels | settingsPlugin（S3 新增） |
| panels | `paper` | ctx.panels | paperPlugin（V3b 既有） |
| commands | `settings/toggle` | ctx.commands | settingsPlugin（S3 新增） |
| tools | 0 行 | — | 无第一方 settings 工具（settings 域无模型工具面） |
| providers | 0 行 | — | S1 留注册表现状（设计件裁定不接线） |
| renderers | 0 行 | — | settings 域无块渲染器 |

## 2. 裁决点

### 2.1 裁决点一：tab 型面板贡献是否需要扩展 PanelContribution

**裁决：不扩展。** PanelContribution 与 PanelDef 逐字段对齐是既有契约（services.ts 头注「字段对齐既有消费面」）；settings 行的 side:null / title / icon / unmountOnClose / component 五字段全静态。tab 结构完全在 SettingsPanel 组件内部（activeTab state），对贡献面不可见、无需可见。引入新字段违反「不为没有消费者的形态买单」。

### 2.2 裁决点二：plugin/<id> 行寻址语义（命令贡献 id）

**裁决：命令贡献 id 用 `settings/toggle`，palette 折算 id 为 `plugin/settings/toggle`；AppAction id 仍用 `toggle-settings`。**

三层 id 各司其职：

| 层 | id | 生命周期 |
|---|---|---|
| 贡献 id（ctx.commands） | `settings/toggle` | 稳定寻址，`<域>/<动作>` 惯例对齐 shell 行 id `hologram/shell-<block>` |
| 折算 id（palette 内部） | `plugin/settings/toggle` | CommandPalette.tsx:33 既定前缀规则，不新增语义 |
| AppAction id | `toggle-settings` | 字节级不变（useGlobalKeys 字面量 + 测试对拍钉住） |

关键约束：**action id 稳定性优先于命名美学**。ctrl+, 分发链上每一层 id 都是字节契约（useGlobalKeys 字面量 `runAction('toggle-settings')` → getAction('toggle-settings')）；改 id 等于动快捷键，超出 S3 范围。pattern: AppAction id 冻结，贡献 id 遵循新惯例，折算层负责桥接。

**另裁决：toggle-paper 同批迁。** paper 域当年漏了半步（面板已贡献、动作还在壳行）；S3 是「一个域的样板量级」，同一职责的两半分居两处是样板工程的坏先例。同批迁入 paperPlugin——动作 run 体相同（togglePanel('paper')），kB 增量可忽略，样板完整性收口。

### 2.3 裁决点三：runAction 回退链（快捷键分发面读贡献）

**裁决：回退链 = getAction('toggle-settings') ?? 贡献 'settings/toggle' 经折算执行。**

现状 ctrl+, 的链路：useGlobalKeys 字面量 → runAction → getAction('toggle-settings')。迁移后壳行不再注册 toggle-settings，字面量将 miss。设计：

```
runAction(id) 的解析序（app/actions.ts 扩展，非 useGlobalKeys 改动）：
  1. registry.get(id)               — 静态注册面（残存壳行动作：open / esc-layer）
  0.5 plugin/<贡献 id> 翻译层        — 'toggle-settings' → 贡献 'settings/toggle'（翻译表）
  2. registry.get('plugin/settings/toggle') — palette 折算面同一折算逻辑
```

实现落点：`app/actions.ts` 的 runAction 内加贡献翻译层——静态表 `ACTION_CONTRIBUTION_ALIASES: Record<string, string> = { 'toggle-settings': 'settings/toggle', 'toggle-paper': 'paper/toggle' }`。runAction('toggle-settings') → miss → 查别名表得贡献 id → 经 activeCommandContributions() 折算执行。零 useGlobalKeys 改动、零快捷键语义变化。

**为什么不改 useGlobalKeys 直接调贡献**：那是把「快捷键→动作」的分发职责搬进快捷键层，违反 P1 分层（处理函数注入、React 侧只认 action id）；别名表方案改动面最小（一个文件）且向后兼容（静态注册仍在先查）。

### 2.4 裁决点四：SettingsPanel 组件引用迁移（import 面）

**裁决：文件物理位置不动，import 面零变化。** 全仓对 SettingsPanel 的 import 只有 1 处（panel-def.ts:11，已钉死）。迁移后这唯一一处 import 随常量行一起消失，import 落点改为插件文件（settings-plugin.ts import + 贡献 def）。组件本体与 settings/ 子组件树（ProviderPage 等）零改动。

### 2.4.1 为什么 config 通道继续延期（S2 §2.9 的再审）

S2 立的纪律：「先开通道只剩两种坏结局——静默 no-op（违反错误不静默）或为凑消费者发明假旋钮（违反最小 diff）。S3 第一个带 config 的域行落地时一并加。」再审：settings 域行（面板 + 命令）全是纯注册型，无任何 config 旋钮诉求；强加 config 通道是为凑消费者发明假旋钮的教科书案例。**裁决：config 通道继续延期**，延期至第一个真实带配置诉求的域行出现。S2 纪律原文成为跨阶段约束，不是一次性豁免。

### 2.5 裁决点五：插件文件落位与代码样例

**裁决：新文件 `src/plugins/settings-plugin.ts`（settings 域无独立目录诉求——面板在 app/panels、持久化在 settings.ts，插件文件是纯装配件）。**

结构对齐 paperPlugin（paper-plugin.ts 范本）：

```ts
// src/plugins/settings-plugin.ts（样例——icon 按旧 def 逐字保留 'settings'）
export const settingsPlugin = {
  name: 'hologram/settings-domain',
  inject: ['panels', 'commands'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.panels.register({ id: 'settings', side: null, title: '设置', icon: 'settings', unmountOnClose: true, component: SettingsPanel }), 'settings-panel');
    ctx.effect(() => ctx.commands.register({ id: 'settings/toggle', label: '设置…', group: '设置', shortcut: 'ctrl ,', action: { type: 'local', handler: () => useDockStore.getState().togglePanel('settings') } }), 'settings-command');
  },
};
```

细节裁定：

- **插件名** `hologram/settings-domain`（对齐 paperPlugin 的 `hologram/paper-shell` 命名惯例——域插件名）。
- **icon 字段**：旧 def 用 'settings'，icons.ts 里 'settings' 键存在且 SettingsPanel 头部在用（iconHtml('settings', 14)），逐字保留 'settings' 不变。
- **CommandContribution.shortcut 字段**：CommandPalette 折算面把 shortcut 显示为 kbd 提示（"ctrl ,"），不承担绑定职责——绑定仍由 useGlobalKeys 全局层持有。shortcut 字段填 'ctrl ,' 作显示值。**这条与 CommandContribution 契约一致，不是新语义。**
- **动作执行体**：旧壳行动作 run 体 `useDockStore.getState().togglePanel('settings')` 原样搬入贡献 handler（CommandPalette 折算面已按 local 型处理）。
- **loader 表序**：BUILTIN_PLUGINS 追加 settingsPlugin 到表尾（compositionServicesPlugin → rendererServicePlugin → paperPlugin → settingsPlugin）。装载序即合流序：settings 面板将出现在 paper 面板之后（panelDefs() 返回序）。叠层无 DOM 序耦合（§1 事实），无视觉涟漪。
- **图标渲染差异说明**：palette 折算面 icon: undefined（CommandPalette.tsx:39）——settings 命令在 palette 里无图标，与旧壳行动作 icon: 'settings' 相比是**可见退化**，但 CommandPalette.tsx:39 是既有折算面约定（所有命令贡献都无图标），S3 不扩展折算面（最小 diff 纪律），如实记录为已知限制。

### 2.6 裁决点六：loader.ts 是否需要从「装BUILTIN_PLUGINS 表」升格为「发现式」

**裁决：维持表驱动。** 表驱动 + 编译期 bundle 内是 WO-S0B 既定架构（第一方插件 = 编译期资产，非运行时发现）。发现式 loader 那条线只服务外部插件（磁盘 manifest 通道）。S3 的 settingsPlugin 只是给表加一行，架构不动。

## 3. 施工序列（批次划分）

### 3.1 批次 B1：折算基础设施（app/actions.ts 别名翻译层）

**改动面**：`app/actions.ts` 单文件。

- 新增 `ACTION_CONTRIBUTION_ALIASES: Record<string, string>`（'toggle-settings' → 'settings/toggle'，'toggle-paper' → 'paper/toggle'）。
- runAction miss 后查别名表 → 经 activeCommandContributions() 折算执行（local 型 handler 调用）。
- **批内自验**：新增单测（tests/s3-settings-domain.test.ts 骨架）——别名表存在性 + miss 路径不炸。
- **不留残键**：runAction 静默语义（「启动早期安全」）不变——别名 miss 也静默（对齐既有「未注册时静默忽略」纪律）。

### 3.2 批次 B2：settingsPlugin 落地（迁面板 + 命令贡献）

**改动面**：新文件 `src/plugins/settings-plugin.ts` + `plugins/loader.ts` 表尾追加一行 + `app/panels/panel-def.ts` 删 settings 常量行 + `shell/rows/actions.ts` 删 toggle-settings/toggle-paper 两行。

**动线**（对齐 V3b paper 迁移先例：先加贡献、后删常量、测试钉迁移证据）：

1. 新建 settings-plugin.ts（面板 + 命令双贡献，inject 声明两 service）。
2. loader.ts BUILTIN_PLUGINS 表尾追加 settingsPlugin。
3. panel-def.ts：PANEL_DEFS 删除 settings 行（常量面清空）；import SettingsPanel 从 panel-def 移除（头注更新：S3 起常量面为空，全量面板走贡献）。
4. shell/rows/actions.ts：删除 toggle-settings 与 toggle-paper 两行（动作迁至对应域插件；open/esc-layer 留守）。
5. **批内自验**：B1 骨架扩为全量测试（tests/s3-settings-domain.test.ts）：
   - 面板贡献三件套（注册/dispose/合流）——对齐 composition-consumption-wiring.test.ts 的 probe 用例形态；
   - 命令贡献折算（id/label/handler 执行）；
   - runAction('toggle-settings') 全链路（别名翻译 → 贡献 handler → dock-store 状态翻转）；
   - 常量面清空对拍（PANEL_DEFS.length === 0）；
   - 壳行 actions 源码断言更新（toggle-settings 字面量迁址后的不变式对拍）。
6. **门禁**：`npm run build && npx vitest run && npx biome check <改动文件>`；convergence 零漂移预期（纯 UI 装配层，不触 agent 工具面）——若有漂移则停下排查，不得强推 baseline 变更。

### 3.3 批次 B3：文档与工程收尾

**改动面**：docs + CLAUDE.md/AGENTS.md 手册段。

1. `docs/plans/composition-architecture/README.md`：S3 状态 Done + 一句话记实（settings 域迁成第一方插件：面板/命令双贡献 + runAction 别名翻译层）。
2. `docs/plans/composition-architecture/HISTORY.md`：S3 段落（与 S0-S2/S4 同款式，含裁决点纪要）。
3. `docs/plans/README.md`：composition-architecture 行改「S0-S4 全竣工 + S3」→「全段竣工」。
4. CLAUDE.md / AGENTS.md：组合层段补一句「S3 起 settings 面板域经第一方插件贡献（panels+commands 双通道），runAction 经 actions.ts 别名层翻译贡献 id」。
4b. `docs/composition/README.md` 四域表：commands 域示例行补 `settings/toggle`（第一方行化先例）。
4c. `docs/plugins/README.md`：第一方插件表更新（paper + settings 两域行化先例）。
5. 记录一份 S3 收官纪要落 docs/plans/composition-architecture/HISTORY.md（真机验证欠账如实记录——见 §3.4）。
5b. `src-ui/src/app/panels/panel-def.ts` 头注已随 B2 更新；`app/actions.ts` 头注补别名层说明（B1 已写）。
6. 归档：设计件随段竣工移入 docs/archive/（归档纪律：竣工即归档）。
7. **门禁**：`npm run build && npx vitest run`（文档批无代码门禁）。

### 3.4 真机验证清单（B2 完工后、B3 归档前）

B2 是代码竣工，B3 是文档收尾。两者之间插真机验证环节：

1. `npm run dev` 启动真机 → 面板唤起三径全验：ctrl+, 快捷键 / 命令面板搜索「设置」/ dock 轨道图标（side:null 无轨道图标，验证点改为 palette + 快捷键双径 + 设置面板内容渲染完整）。
2. 呉起路径语义：开→关→重开（unmountOnClose 语义：重开从 localStorage 重读设置）。
3. **别名翻译层端到端**：ctrl+, → settings 面板开；再按 ctrl+, → 关（runAction miss → 别名 → 贡献 handler → dock-store 翻转）。
4. paper 域对拍：ctrl+P → 纸面板开合正常（toggle-paper 同批迁移无回归）。
4b. 命令面板：Ctrl+K 搜「设置」执行（palette 贡献折算面）+ kbd 提示显示正常。
4c. 保存管道冒烟：设置面板内改语言 zh→en→zh 往返（Commit/save 落盘链路经 notifyAgentConfigChanged 正常）。
4d. 旧动作留存对拍：命令面板「逐层关闭」(esc-layer)、「绑定目录…」(open) 可用（壳行留守动作无回归）。
5. 真机截图取证（对齐 V5 拆除后的真机验证惯例）。
6. **真机验证需用户在场**（涉及视觉判断），B3 文档批在验证通过后进行——若用户不在场，B3 换序到下次会话，不阻塞 B1/B2 代码交付。

## 4. 验证与门禁总表

| 批次 | 门禁命令 | 红线 |
|---|---|---|
| B1 | build + vitest run + biome check 改动文件 | 别名表双键齐全；miss 静默语义不变 |
| B2 | build + vitest run + biome check 改动文件 | PANEL_DEFS 清空对拍；convergence 零漂移；壳行两动作行删除 |
| B3 | build + vitest run（文档批） | README/HISTORY/手册段同步；归档完成 |

## 5. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| B2 删壳行动作后 ctrl+, 失灵（别名层缺陷） | 低 | B1 先行铺别名层并单测钉住；B2 动线「先加贡献后删注册」保换序安全 |
| convergence 漂移 | 低 | 纯 UI 装配层，不触 agent 工具面/prompt 段；漂移即停 |
| 测试对拍漂移（既有断言「常量面只剩 settings」过期） | 中 | B2 同批更新 composition-panel-registry.test.ts 与 composition-consumption-wiring.test.ts 的常量面断言（V5→S3 断言演进：settings 从常量面移入贡献面） |
| palette 折算面 icon 缺失退化 | 确定 | 已知限制如实记录（§2.5），不扩折算面 |
| SettingsPanel import 断裂 | 零 | 裁决 §2.4：组件文件不动，全仓唯一 import 随常量行同批消失，import 面零变化 |
| 壳行 actions.ts 头注与实现漂移 | 低 | B2 同批更新头注（V5 注释段追加 S3 迁移注记） |

## 6. 与既有约定的对齐清单

- V3b paper 迁移先例：先加贡献、后删常量、测试钉证据——B2 动线完整复用。
- S2「不为凑消费者发明假旋钮」纪律：config 通道继续延期（§2.4.1）。
- S2 壳行/插件两通道分工：「有 ctx 生命周期诉求的单元走插件通道」——settings 面板+命令有 disposer 诉求，走插件通道，判据成立。
- 宪法「错误不静默」：别名 miss 静默对齐 runAction 既有「启动早期安全」语义——不是错误吞没，是启动时序安全垫，两条纪律不冲突。
- 节约纪律：B1/B2/B3 均为最小 diff 批次；无新增依赖、无新 CSS 方案、无新状态层。

## 7. 开放问题（不在 S3 范围，记入工程备忘）

1. palette 折算面 icon 通道扩展（所有命令贡献都无图标——第一方插件命令想要图标需扩 CommandContribution.icon 字段 + 折算面透传）。
2. runAction 别名表 ACTION_CONTRIBUTION_ALIASES 的治理：随更多域行化，别名表会增长；届时可考虑迁移到更系统的贡献注册形态。S3 只放两条目。
2b. useGlobalKeys 的 toggle-paper/toggle-settings 字面量是否随域行化迁走（快捷键绑定跟随域插件？）——S3 不动（全局快捷键层是壳层关注点），记入备忘。
3. config 通道第一消费者出现时的落地形态（§2.4.1 延期触发条件）。
