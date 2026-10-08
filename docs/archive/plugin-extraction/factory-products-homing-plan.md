# 出厂产物归家 — 施工图纸（魂身合一：实现物理搬进插件包）

> 状态：**Proposed·Draft（2026-09-04 立项，未开工；等用户拍板施工批次）**
> **账在 [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md)**（2026-09-24 改判：
> 本文 §1.1 的 A 类 18 个空壳仍成立，但 D 类「合格」是误判——`llm-adapters` /
> `subagent-in-process` / `agent-loop-service` 的 provider 实现也在内核；`settings-domain`
> 属 E 类同样魂身分裂。计数与行数以总账为准）。
> 一句话：S5（plugin-bundle-retirement）把 30 个出厂插件从 bundle 编译态搬到了
> 产物装载态，但**只搬了「装载通道」，没搬「物理家园」**——18 个工具域/段产物
> 的包是转发空壳，实现还躺在 agent/、composition/ 内核深处。本图纸解决：
> **一个产物 = 一个物理目录**，目录名即归属，人眼可读，改插件 = 改包内代码。
> 附带的收尸小账（scene/ 残留、mock-data.ts 尸体、.hologram/ 数据进驻源码树）
> 一并立项，同批施工。
> 骨架决策（2026-09-04 用户拍板）：**src/ 顶层目录不重排**（拆域不拆层，历史
> 收敛稳定态，推翻重排 import 图全改收益仅观感）；plugins/ 装载链与产物分家
> （产物归 builtin/，装载链挪 plugins/kernel/）并入第 5 批收尾。

## 0. 一句话施工目标

把 18 个转发空壳产物的实现物理搬进各自的 `plugins/builtin/<name>/` 目录，
同时给「什么必须留内核」立一条刚性红线（共享平台基础 + 状态单点契约）。
搬完目录树人眼可分归属：`plugins/builtin/<name>/` 就是一个完整产品，
`agent/`、`composition/`、`paper/` 只剩平台与共享基础。

## 1. 现状确诊（2026-09-04 摸码实证）

### 1.1 31 个 builtin 产物目录的四态分类

| 类别 | 数量 | 产物 | 判定 |
|---|---|---|---|
| **A 转发空壳（欠账，本次要搬）** | 18 | agent-domain · agent-isolation-domain · ask-domain · asset-domain · browser-desktop-domain · capability-segments · cordis-domain · engine-domain · fs-domain · git-domain · memory-domain · prompt-segments · search-domain · shell-domain · skill-domain · task-domain · wait-domain · web-domain | 目录内只有 index.ts + host.ts + host.aliased.ts + manifest.json；`host.ts` 一行 re-export 内核实现，**实现本体躺在外头** |
| B 自包含迁入（合格） | 2 | fs-builtin · shell-builtin | 原 `agent/fs-provider.ts` 整体迁入，零运行时依赖，产物自包含 |
| C 类本体进包 + 活动面留内核（合格） | 1 | agent-loop-service | 类/注册表在包内 index.ts；`agent-loop-active.ts` 是内核状态单点，**留是设计** |
| D 实现进包 + 宿主依赖经桥（合格） | 4 | llm-adapters · sessions-builtin · graph-builtin · subagent-in-process | 实现主体在包内，host.ts 只桥 faceDeps（provider 工厂 / typedRpc / agentInvoke / spawnSubAgentImpl） |
| E UI 面进包 + 宿主依赖经桥（合格） | 5 | canvas-nav · compose-dock · paper-minimap · paper-shell · settings-domain | 组件 + CSS 已整体进包，host.ts 桥 store/service 单例（mods 共享真实例） |
| F 渲染器（合格） | 1 | renderers | components.tsx + index.tsx + renderer-host 桥 |

> A 类 18 个的 host.ts 转发目标（实证，逐包 grep）：
>
> | 产物 | 转发目标（实现真源） |
> |---|---|
> | agent-domain | `agent/tools/subagent`（createAgentStatusTool / createSubAgentTool） |
> | agent-isolation-domain | `agent/tools/coding`（createAgentIsolationTools） |
> | ask-domain | `agent/tools/coding`（createAskUserTools） |
> | fs-domain | `agent/tools/coding`（createFsTools） |
> | git-domain | `agent/tools/coding`（createGitTools） |
> | shell-domain | `agent/tools/coding`（createShellTools） |
> | asset-domain | `agent/tools/show-asset`（createAssetTools） |
> | browser-desktop-domain | `agent/tools/browser` |
> | cordis-domain | `agent/tools/cordis` |
> | engine-domain | 混合：桥面（z / agentInvoke / defineTool）+ 实现面（`agent/tools/hologram` loadHologramSchemas / mcpSchemaToTool）+ `composition/graph-service` graphExecute |
> | memory-domain | `agent/memory`（createMemoryTools） |
> | search-domain | `agent/tools/manifest-tools`（createSearchTools） |
> | web-domain | `agent/tools/manifest-tools`（createWebTools） |
> | skill-domain | `agent/skills`（createSkillTool） |
> | task-domain | `agent/task`（createTaskTools） |
> | wait-domain | `agent/tools/wait`（createWaitTool） |
> | prompt-segments | `composition/prompt-sections`（firstPartyPromptSections） |
> | capability-segments | `agent/blueprint`（firstPartyCapabilities） |

### 1.2 乱象根因与影响

- **根因**：S3（2026-08-23）真源产物化时选了最短路径「原处留实现、包内转发」，为保
  表序字节契约零漂移，只动了一层 import。S5 装载通道竣工后，产物形态成立，但物理
  归置的尾巴一直没扯。
- **影响**：① 目录观感 = 魂身分裂，`plugins/builtin/` 大部分是门牌号；② 读代码判断
  「这文件属于内核还是某个产物」必须追 import，路径给不了答案；③ 用户体感「仓库
  看着太乱」。
- **附带伤**：同一轮收尸小账（见 §7）：`src/scene/` 只剩 1 文件残留目录；`src/mock-data.ts`
  零引用尸体；`src/.hologram/`（hologram.db / vectors.usearch）运行时数据住在源码树。

### 1.3 关键资产与既有机制（不用造轮子）

- **宿主依赖面**：`host.ts`（开发/测试域直连真实模块）+ `host.aliased.ts`（esbuild 产物
  域经 `window.__lantai_plugin_host__.mods` 共享真实例；两域形状以 `typeof import('./host')`
  对拍）——**这套机制不动**，搬的是实现不是桥。
- **产物构建管线**：`scripts/build-builtin-plugins.mjs`（esbuild → dist-plugins/builtin/
  hologram/，face.json 提取，host → host.aliased 重定向）。搬入的实现若 import 内核共享
  基础，靠 esbuild bundle 内联（fs-builtin 先例：「零运行时依赖，类型导入擦除，产物
  自包含」）；内核单例必须继续经桥（faceDeps），不内联副本。
- **表序字节契约**：`factory-products.ts` 装配序 = 贡献注册序 = 组合解析快照/工具契约
  生成/DeepSeek 前缀缓存依赖。**归家只改 import 路径，不改表序**（factoryProducts()
  数组一字不动）。

## 2. 归家判定规则（决策点，建议定案）

| 判定 | 规则 | 实例 |
|---|---|---|
| **搬** | 该产物专属的实现（工具工厂 / schema / provider 逻辑 / 段落清单）物理进包 | createAssetTools → `plugins/builtin/asset-domain/` |
| **留（平台）** | 多产物共享的平台基础（Tool 类 / defineTool / registerFamily / 执行管道）留内核，作为平台库由包内 import | contribution-helpers.ts（已物理在 builtin 下，纯函数共享面，保持） |
| **留（状态单点）** | 内核读写、跨产物共享的活动面/注册表（agent-loop-active / host-modules faceDeps / 服务单例）留内核，包内经桥取 | agent-loop-service 现状即样板 |
| **留（桥）** | host.ts / host.aliased.ts / faceDeps 机制不动 | 全包不变 |
| **拆** | 一个文件承载多产物的（coding.ts 五域、manifest-tools.ts 双域）按域拆文件，各进各包；共享片段留内核再导出 | coding.ts → 5 份，见 §4 第二批 |

### 2.1 骨架决策（2026-09-04 用户拍板：顶层不动，plugins/ 分家）

| 判定 | 规则 | 理由 |
|---|---|---|
| **顶层不重排** | src-ui/src 顶层目录按域保留（agent/composition/paper/state/ui/app…），不按「内核/UI/状态」强行分层 | 兰台哲学 = 拆域不拆层；当前结构是 C13 sweep / eventbus 归零 / ui 拆分等十几轮收敛出的稳定态，重排 import 图全改、门禁重跑，收益仅观感 |
| **plugins/ 分家** | 装载链（loader/boot-gate/factory-products/first-party-manifest/host-modules/face-css/types/mcp-bridge）挪 `plugins/kernel/`；`plugins/` 只剩 kernel + builtin（产物之家） | 归家后 plugins/ 平级躺着两种东西，命名空间语义错位正来源于此；分家后一眼可分台子与产品 |

## 3. 施工前置（开工前必做）

1. 读 `scripts/build-builtin-plugins.mjs`，摸清产物构建面（规格表怎么列、esbuild
   bundle 模式、host 重定向、face.json 提取），对照 fs-builtin 自包含先例定「搬入实现
   的 import 纪律」。
2. 读 `plugins/builtin/host-modules.ts`，确认 faceDeps 键全集与 mods 形态（搬入实现若
   需要内核单例，走 mods 而非直连）。
3. 基线门禁先跑一遍：`vitest` + `npm run build`（含 build:builtin-plugins）+ `biome ci` +
   `verify:convergence`，确认绿基线。
4. 读 `agent/tools/coding.ts` 与 `agent/tools/manifest-tools.ts` 全貌，标出共享函数与
   各域私有函数，画拆分清单（第二批的图纸）。

## 4. 施工批次（每批门禁全绿再下一批）

| 批 | 内容 | 备注 |
|---|---|---|
| 0 | 收尸小账并行（§7） | 零风险，可单独提交 |
| 1 | 机械域五件：asset-domain · wait-domain · skill-domain · task-domain · memory-domain | 转发链最短（直连单文件），先摸熟搬法 |
| 2 | coding.ts 五域拆分：ask-domain · fs-domain · git-domain · shell-domain · agent-isolation-domain | 最大硬骨头：拆 5 文件各进各包，共享片段留内核 |
| 3 | manifest-tools 双域：search-domain · web-domain | 共享文件拆两半 |
| 4 | 余域：agent-domain · browser-desktop-domain · cordis-domain · engine-domain · prompt-segments · capability-segments | engine-domain 有桥面/实现面混合，搬迁时先厘清边界 |
| 5 | 收尾：空壳复查 + **plugins/ 内核产物分家**（装载链挪 `plugins/kernel/`，保持 import 面等价，守卫测试对拍）+ 文档同步 | §5 验收全项 |

每批动作模板：`git mv 实现文件 包内`（或拆分重写）→ 包内 index.ts 改直引 → 旧文件
删/留共享片段 → 受影响面测试跑绿 → `biome check --write` → `verify:convergence`。

## 5. 验收（搬完即证）

1. **归属可读**：`plugins/builtin/<name>/` 下即完整产品实现；git grep 确认 18 个域的
   `createXxxTools` / `firstPartyXxx` 定义全部在包内（白名单 = §2 留平台共享片段）。
2. **目录树人眼可读**：`src/` 顶层无尸体目录、无死文件、无运行时数据；
   `plugins/` 只剩 `builtin/`（产物之家）+ `kernel/`（装载链），一眼可分台子与产品。
3. **门禁全绿**：vitest（含 first-party-manifest / 表序守卫）/ build（含 build:builtin-
   plugins）/ biome 0/0 / verify:convergence 零漂移。
4. **产物形态不回归**：dev 模式（源码装载）+ 产物模式（VITE_FORCE_PRODUCT_CHANNEL=1
   强制产物通道）各跑一轮 boot，装载序与贡献行为一致。
5. **行为零漂移**：工具面 / prompt 段 / capability 面数量与 id 与搬前逐一对拍
   （守卫测试 + 快照）。

## 6. 风险矩阵

| 风险 | 概率 | 影响 | 兜底 |
|---|---|---|---|
| import 路径海量漂移 | 高 | 中 | vitest + tsc + biome 全兜；每批小步走 |
| 搬入实现含内核单例引用（store/service ），esbuild 内联副本破坏单例语义 | 中 | 高 | §2 红线：单例一律经 mods/faceDeps 桥，不随实现搬；搬前逐文件审 import 面 |
| coding.ts 拆分误伤共享函数（execute 封装等） | 中 | 中 | 施工前置 4 先画拆分清单；共享片段留内核再导出；守卫测试对拍 |
| 产物构建失败（esbuild bundle 内联崩） | 中 | 中 | 每批过 build:builtin-plugins |
| 表序字节契约漂移 | 低 | 高 | factoryProducts() 数组不动；convergence + manifest 守卫钉死 |
| 热重载面回归（dev HMR / 产物重激活） | 低 | 中 | dev + 产物双模式 boot 验收（§5.4） |

## 7. 附：收尸小账（同批施工）

| 项 | 处置 | 风险 |
|---|---|---|
| `src/scene/`（仅剩 graph-types.ts + README，C13 后残留） | graph-types.ts 并入类型层适宜位置（先查消费面），目录退役；README 归档 | 低（先 grep 消费面） |
| `src/mock-data.ts`（零引用，已实证 grep 无命中） | 直接删 | 零 |
| `src/.hologram/`（hologram.db / vectors.slots.json / vectors.usearch 运行时数据） | 挪出源码树（先查代码里路径引用，确认为运行时位后 .gitignore + 数据目录迁移） | 中（动数据路径先查引用 + 确认无进程占用） |

## 8. 工作量估计

- 主体 2-3 天（分批施工 + 每批门禁）；硬骨头集中在第二批 coding.ts 拆分与
  engine-domain 桥面/实现面厘清。
- plugins/ 内核产物分家（第 5 批并做）：约半天。
- 收尸小账 0.5 天。
- 不触碰：厂 14 内核、build-builtin-plugins.mjs 的产物规格（除非搬入实现暴露构建
  面缺口）、factory-products.ts 表序、host.aliased 对拍机制、src/ 顶层目录骨架
  （拆域不拆层，用户已拍板不重排）。