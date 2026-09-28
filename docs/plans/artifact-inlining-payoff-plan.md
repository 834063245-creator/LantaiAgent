# 产物内联销账（artifact-inlining-payoff）施工单

> **状态：代码全落地（2026-09-28）；余 W4 真机验收在办**（Agent 起不了 GUI——见 §4-W4，判据与
> 真机步骤照旧）。施工单留 `docs/plans/` 而非归档，供后续「产物域」批取架构上下文。
>
> ## ✅ W0–W3 已竣工——账清零
>
> 39 产物构建**零 ⚠ 行**、`stateful-kernel-modules.json` 的 `modules` 为空。逐条取证
> （输入集数字 / 桥面 / 指纹）见 **`docs/landmine-map.md` 第十五批 A4**；单一权威源的叙述与
> 纪律见 `docs/plugins/README.md`「产物模块图账本」。
>
> **三处与本文原案不同的裁定**（留痕，事后可翻案）：
> 1. **「两个全局件」实际是三个**——`contribution-helpers.ts`（15 个产物共用）与
>    `react-bridge.cjs` / `face-css.ts` 同性质（跨产物的构建件，不属于任何单一产物）。
> 2. **全局池取消，`shared` 改为「实际输入集 − 上述三个」**——原 `globalInputs` 那 23 条
>    是「多产物共用」的池化写法；池化让**逐插件声明面失真**（同一模块被 A 用、B 声明，
>    A 白拿），门禁也就管不住「谁真的内联了什么」。改逐插件自足后，构建门禁每次都在核账；
>    顺带暴露并删掉一批化石声明（`paper/group.ts` / `virtualize.ts` / `selection.ts`
>    三件连内核文件都已不在）。
> 3. **W2/W3 实为同一条根因**（传递闭包 `bridge → rpc-contract → logger` + `settings`），
>    且各自只被**一处**值引用（`ProviderPage.tsx` / `ComposerDock.tsx`）——合为一笔交付
>    （分笔反而会造出两个「构建红着」的中间态）。本单纯前端 + 构建脚本，**未动 `src-tauri/**`**。
>
> 承接 = `landmine-map.md` 第十五批 A4（门禁已落、toast 已销账）
> 执行者：下个窗口。**开工前先读**：`landmine-map.md` 第十五批（三种内联形态 + 家族结论）· [`../plugins/README.md`](../plugins/README.md)（宿主桥纪律）· 本单 §1/§2。
> 一句话：把「带模块级状态的内核模块被内联进产物」逐条销账——**有身份的走宿主桥，无身份的留在名册 `shared`**。

## 0. 为什么值得修

产物不是隔离带，是同一进程里的**第二份模块图**：`import` 一个内核模块，esbuild 会把它**复制**进产物（连模块级状态一起）。于是「生产者写 A、消费者读 B」——toast 那条就是这么死的（唯一渲染器读副本 ⇒ 打包态一条都不弹，而开发/测试域单实例，4374 个用例全绿也照不出来）。判据与三种形态见 landmine 第十五批。

## 1. 已落地（**不要重做**）

| 门禁 | 落点 | 作用 |
|---|---|---|
| 源码级 | `scripts/lib/artifact-dynamic-imports.mjs` + `scripts/build-builtin-plugins.mjs` + `src-ui/tests/artifact-self-contained.test.ts` | 值位置的**相对动态 import** 一律拒建（注释 / `typeof import()` / 类型查询豁免） |
| 模块图级 | `build-builtin-plugins.mjs` 的 `outsideInputs` / `allowedInputsFor` | 产物输入集里出现插件目录外的项目内源码 → 构建失败；带状态者构建时点名 |
| 面键级 | `host-surface.baseline.json` + `face.json` | 桥出口三处不同步 → tsc / esbuild / 指纹三道红（改面后 `npm run gen:host-surface`） |

**已销账先例**：`state/toast-store`（commit `b7a73a3c`）——`ToastHost.tsx` 改走 `./host` 后，paper-shell 输入 **168 → 73**，连带清掉 `bridge` / `rpc-contract` / `logger` / `obs` 四个副本。**账怎么记、怎么验证，照它做。**

## 2. ⚠ W0（第一件，必做）：账本合一

现在是**两本账**，别在第二本上继续盖：

| 账本 | 位置 | 性质 | 消费方 |
|---|---|---|---|
| **名册 `shared`**（旧，权威） | `src-ui/src/plugins/builtin-roster.json` 每条 `shared: [...]`；schema 注释见 `builtin-roster.ts`（「**有意留内核的共享面**……登记它 = 该模块留在内核是决定，不是漏网」） | 声明式（人写、与插件同处、有类型） | `scripts/plugin-home-check.cjs`（归家三色对账）+ `tests/plugin-home-ledger.test.ts`；代码注释亦以此为据（`paper-renderers/host.ts`：「按名册 `shared` 相对 import 随包内联」） |
| `scripts/lib/artifact-input-baseline.json`（新，2026-09-28 门禁同批落的） | `scripts/lib/` | 快照式（构建门禁独占消费） | 构建脚本 |

**裁定：名册 `shared` 是唯一声明面。** 理由：单一权威源（宪法第二条）+ 与插件定义同处 + 已有消费方；我 09-28 落的那本是平行账，属负债。

**W0 四步**：
1. `build-builtin-plugins.mjs` 的「允许内联」判据改读 **`spec.shared`**（`pluginSpecs()` 已经是 `{ ...e, name }`，字段现成）+ 两个全局件：`plugins/builtin/react-bridge.cjs`、`plugins/builtin/face-css.ts`。
2. 把现状**一次性校准写回名册**：各插件 `shared ← 实际输入集 − 全局件 − 本目录`（用 §3 的枚举法拿数据）。**只搬数据，不改代码语义。**
3. 删 `artifact-input-baseline.json`；把其中的 `stateful` 名单挪进 `scripts/lib/stateful-kernel-modules.json`（跨插件共用，每条带 `reason` + `payoff`）。
4. `tests/artifact-self-contained.test.ts` 的静态断言跟着改（断言构建脚本读 `spec.shared`）。

**W0 验收**：`npm run build:builtin-plugins` 全过，且 **⚠ 行数与 W0 前逐字一致**（证明只换了账本，没动事实）；`npm run plugin-home:report` 的「灰区」不增长（`shared` 只增不减地认领，别把该拆的也认领进来）；`npx vitest run tests/plugin-home-ledger.test.ts tests/builtin-roster.test.ts tests/artifact-self-contained.test.ts` 绿。

## 3. 判据与手法（W0 之后照此销账）

**唯一判据——这东西有身份吗？**

- **无身份**（纯函数 / 只读冻结表 / 类型 / 资产）→ 内联合法：留在 `shared` ✔
- **有身份**（模块级可变状态：缓存 / store / 发号器 / 计数器 / 订阅表 / 账本）→ **必须走宿主桥**，且**不得登记 `shared`**（`shared` 的语义是「留在内核的共享面」，而共享**状态**的唯一合法实现是桥）

判定动作：`grep -nE "^(export )?(let|var) |new Map\(|new Set\(|= create\(" <模块路径>`，再看导出函数是否读写它。

**枚举现状（最快，不用写脚本）**：把某插件在账本里的清单临时清空 → `npm run build:builtin-plugins` 会**一次列出该插件全部**未登记输入（门禁停在第一个违规插件）→ 抄下来；平时构建末尾的 `⚠ 内联了**带模块级状态**的内核模块` 行即当前欠账。

**销账三步（每条）**：① 改 import 走 `./host`（缺出口按纪律补三处：`host.ts` + `host.aliased.ts` + `host-modules.ts` faceDeps）；② 从 `shared` 删该行；③ 若属 `stateful`，从 `stateful-kernel-modules.json` 删并记一行因由。
**验证必须落在结构上**（不是「跑一遍看看」）：产物里不再有该模块的定义 —— 例如 `Select-String -Path src-ui/dist-plugins/builtin/hologram/renderers/entry.js -Pattern 'blockSeq'` 命中 0 + 构建 ⚠ 行少一条。

## 4. 工作项

### W1 · `block-model` 发号器（renderers / paper-renderers）

- **现状**：`renderers/viewers/markdown-doc.tsx:31`、`renderers/viewers/ipynb.tsx:33` 直引 `../../../../paper/block-model` 的 `createBlock`；产物内自带 `var blockSeq = 0`（实测 `renderers/entry.js:72531`）。
- **影响**：`paper/block-model.ts:174` 的 `let blockSeq` 发号器分家 ⇒ 块 id（`pb{n}`）两处独立发号，而画布以 id 为键。
- **修法**：把 `createBlock`（若 `nextBlockId` 也被用则一并）挂进 renderers 的桥（`renderers/renderer-host.ts` + `renderer-host.aliased.ts` + `host-modules.ts` faceDeps；该包 `hostModule: "renderer-host"`），两个 viewer 改 `from './renderer-host'`；`paper-renderers` 同法走它自己的 `host.ts`（该包 `hostModule: "host"`）。
- **注意**：`SourcedBlock` 等**类型**可继续 type-only 直引（编译期擦除、不进输入表）——只改**值**那一处；两个包的 `shared` 里删 `paper/block-model.ts`。
- **验收**：两产物 ⚠ 行消失 + `blockSeq` 在两产物内命中 0 + 桥面指纹重录。

### W2 · `settings-domain` ← `logger` / `bridge` / `rpc-contract` / `settings`

- **现状**：⚠ 行点名四个。`settings.ts` 是**投影 + 订阅表**（有身份）；`bridge` / `rpc-contract` 带计数与插桩；`logger` 带 `logPath` + buffer（**副本未 initLogger ⇒ 该产物的这几条日志丢条**）。
- **手法**：§3 枚举法定出**传递闭包入口**（多半是某个 `provider/*` 或 `mock-data` 把它们带进来），逐个把能走桥的改走桥。
- **注意**：该包 `host.ts` 已有 `loadSettings` / `saveSettings` / `typedRpc` / `invalidateCredentialCache` 等出口——**先读 `host.ts` 再决定是否需要新增键**（新增就走三处同步 + 指纹重录）。
- **验收**：⚠ 行消失；或只剩能自证无状态者（那就从 `stateful` 删除并写明理由）。

### W3 · `compose-dock` ← `logger` / `bridge` / `rpc-contract`

同 W2（该包 `hostModule: "host"`，有 `host.ts` / `host.aliased.ts`）。

### W4 · 真机验收（Agent 起不了 GUI，留给用户）

- toast（已修 `b7a73a3c`）：打包 exe 里拖一个不支持的文件入卷 → 应弹「拖放入卷失败」。
- 若做了 W1：开一个含 notebook / markdown 文档的卷，检查画布状态文件里块 id 唯一。

## 5. 门禁（每条工作项都跑；数字会漂，以实测为准）

| 目的 | 命令 |
|---|---|
| 定点 | `cd src-ui && npx vitest run tests/artifact-self-contained.test.ts tests/host-surface-seal.test.ts tests/face-deps-seal.test.ts tests/plugin-face-bridge.test.ts tests/face-keys.test.ts tests/builtin-roster.test.ts tests/plugin-home-ledger.test.ts` |
| 改面（新增 faceDeps 键） | `npm run gen:host-surface`（**同 commit**） |
| 产物 | `npm run build:builtin-plugins`（39 产物自包含校验全过 + 镜像 debug/release） |
| 全量 | `npx vitest run` · `npm run build` · `npx biome ci .`（0/0）· `npm run doc-sync` · `npm run doc-check` |
| 归家对账 | `npm run plugin-home:report`（灰区不得增长） |
| 仅当改了 `src/agent/**` 或 `src/composition/**` | `npm run verify:convergence`（双轨） |

## 6. 不做（边界）

- 不重构宿主桥机制本身（三处同步 / face.json / 指纹流程照旧）
- 不把无状态纯函数也搬上桥（多一层间接 + 多一个版本偏斜面 + 零收益 = 纯负债）
- 不动 `src-tauri/**`（本单纯前端 + 构建脚本 + 名册/账本 JSON）
- 不改开放面契约版本（新增 faceDeps 键改的是**宿主面指纹**，走 `gen:host-surface`，不是 v55）
- 不为「看着干净」批量删 `shared` 条目——每条要么销账（改走桥）、要么留下（有理由）

## 7. 陷阱（前人踩过）

- **桥文件本来就该引内核**：`host.ts` / `host.aliased.ts` / `renderer-host*.ts` 是开发/测试域的直连面（产物域被重定向掉），别去「修」它们——我的临时扫描脚本因此误报过 177 条。
- **类型位 import 豁免是对的**：`typeof import('./host')`、`export type X = import('./host').X` 编译期擦除，不进输入表。
- 注释里写 `await import('…')` 不会被门禁拦（注释剥离），但别写。
- 改面 → `face.json` 变 → **产物必须重建 + 镜像**，否则 exe 里还是旧产物。
- **「开发/测试域全绿 ≠ 打包态正确」**：内联病灶只在打包态现形（单实例 vs 双实例）；所以验证要落在结构（输入表 / 产物字节 / ⚠ 行），别用「跑一遍看看」。
- 名册 `shared` 一旦用于门禁，**它就成了事实清单**：删条目 = 声明「本产物不再内联它」，必须同时改 import 并验证产物，否则构建立刻红（这是设计意图，不是意外）。

## 8. 交付物

- W0 一个 commit（账本合一；**行为零变更**——只换账本 + 校准数据，⚠ 行逐字一致）
- W1 / W2 / W3 各一个 commit（一颗雷一笔；message 按 CLAUDE.md 写清「用户可感知变了什么」）
- 每条销账同步更新 `landmine-map.md` 第十五批 A4 行 + `stateful-kernel-modules.json`
