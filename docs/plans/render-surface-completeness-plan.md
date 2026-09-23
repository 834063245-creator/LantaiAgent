# 渲染面补全（查看器全谱 + Mermaid 代码块）· 施工单

> 立项 2026-09-23 · 状态：**已拍板（§2）· 施工中（P1 开工）**
> **2026-09-23 开工前实测修订**（逐条证据见 §10）：D3 改「重依赖走宿主桥」、B2 改 hljs 优先、
> B6 落点改应用侧、补新增依赖清单、门禁顺序改 build → vitest。修订缘由 = 三条与代码现状冲突的假设。
> **2026-09-23 批次重排**（用户要求整合）：15 批 → **3 包 + 收尾**（见 §4.0）——按机制分包，
> 包内并行铺查看器、门禁每包一次。
> 现状真源：`src-ui/src/plugins/builtin/renderers/components.tsx`（`MEDIA_MIME` / `MEDIA_IMAGE_EXTS` / `MEDIA_VIDEO_EXTS` / `MediaBody` / `useMediaData`）
> 契约真源：`src-ui/src/composition/renderer-service.tsx`（`ctx.renderers` 通道 · `BlockRendererContribution` · `resolveAssetBlock` 降级链）
> 资产真源：`src-ui/src/agent/asset-kinds.ts`（`file` kind：`presentations: ['media']`，`streamable: 'atomic'`）
> 触发原话：「查看器这一块我还是想尽量的补全」→「全体都有，整个落施工计划，有多少我就干多少」
> **已排除**：块的交互回传（`emit` / `track` / `data` 三通道）——用户 2026-09-23 明确搁置，不在本单。

## 0. 一句话

**把 `media` 这一个表现原语从「图片 + 视频」扩成一条按扩展名路由的查看器注册面，
查看器逐批注册进去，`file` kind 的契约不变、`asset-kinds` 的语义面不动。**

本单**不含次等项**：§4 全部批次都是正式 feature，只有实施顺序先后，没有候补分级。

## 1. 现状与缺口（实证）

### 1.1 现在有什么

| 层 | 现状 | 真源 |
|---|---|---|
| 文体渲染器 | 11 件（`builtin/user` · `markdown` · `reasoning` · `notice` · `diff` · `plan` · `tool` · `code` · `toolgroup` · `subagent` · `turn-error`） | `app/paper/builtin-renderers.tsx` 尾部表 |
| 资产表现原语 | 13 件（`grid` `chart` `metric` `media` `graph` `tree` `html` `form` `board` `timeline` `citation` `chem` `interactive`） | `plugins/builtin/renderers/components.tsx` 的 `AssetRendererKind` |
| 兜底 | `builtin/*` → `JsonBody`（未知 kind 不裸奔） | `composition/renderer-service.tsx` |
| `media` 原语实际能力 | **图片 7 种 + 视频 4 种**，其余一律落「文件壳」（只显扩展名与路径） | `MEDIA_MIME` 11 条 + `MediaBody` 的三分支 |
| 媒体取字节 | `rendererRpc('fs_cap', { action: 'read_base64', file_path, is_agent: false })` → base64 → `data:` URI | `useMediaData` |
| 放大 | `rendererOverlay` portal 浮层 + Escape / 点遮罩关闭 | `MediaBody` 的 `previewBody` |
| 代码渲染 | **已在主 bundle**：`app/paper/builtin-renderers.tsx` 静态引 highlight.js（围栏码块 `MdCodeBlock`，已按纸面墨阶主题化）；Monaco 只以**类型**出现在 `ui/lsp-client.ts`，全仓**无运行时装载路径** | `builtin-renderers.tsx:19`、`ui/lsp-client.ts:20` |
| Office 能力 | `office` 域工具（12 动作）**只认 OOXML**：`.docx/.xlsx/.pptx`；用户路径可达的口 = `process_cap{action:'office_exec', is_agent:false}`（动词白名单含 view/get/query） | `examples/office-cli/SKILL.md` 第 3 行、`process_cap.rs:66` |
| 系统级打开 | `desktop` 域是 UIA 控件控制（18 动作），**无**「默认程序打开」；`shell` 域只有 run/output/wait/kill（**没有 `start`**）；全仓仅 `oauth.rs` 开 URL、`composition.rs` 用 explorer 开目录 | `docs/agents/model-tool-contract.md`、`process_cap.rs:49` |

### 1.2 缺口（按类型）

**缺**：音频（mp3/wav/flac/m4a/aac/opus）· PDF · Office（docx/xlsx/pptx）· 独立代码查看器 ·
表格数据（csv/tsv）· 结构化数据（json/jsonl/yaml/toml/xml）· 压缩包（zip/tar/gz）·
3D（glb/gltf/obj/stl）· 字体（ttf/otf/woff/woff2）· 电子书（epub）· 笔记本（ipynb）·
化学（mol/sdf/pdb）· 地理（geojson/kml）· 字幕（srt/vtt）· 邮件（eml）· 二进制 hex ·
Markdown 目录视图 · 旧版 Office 的**出口**（不做内嵌解析，见 §2 D5）

**层二缺一项**：` ```mermaid ` 代码块不渲染成图。以**代码块渲染器**形态落地，
不新增资产 kind（避免与 `chart` kind 抢入口、逼模型二选一）。

**依赖缺口（2026-09-23 核对 `src-ui/package.json`）**：`pdfjs-dist` · `mermaid` · 归档读取（zip）·
`toml` / `csv` 解析器**都不在依赖内**，属本单新增；`three` / `smiles-drawer` / `katex` / `yaml` /
`echarts` / `highlight.js` / `dompurify` / `monaco-editor` 已在。**加依赖 = 加体积，各批的「新增依赖」栏是硬约束**。

### 1.3 不构成缺口（口径差异，不补）

Hana 的 19 种流内卡（`wait` / `workflow` / `cron` / `install_confirm` / `tool_grant` /
`computer_app_approval` / `card_event` / `coordinator_grant_event` / `mcp_app_card` …）是**消息流范式**
下的工具专属投影；兰台以「11 文体块 + `toolgroup` 折叠 + `code` / `subagent` 专属形态」承接，
分类法不同，不按数量对齐。

## 2. 定案（已拍板 2026-09-23）

| # | 问题 | 定案 | 说明 |
|---|---|---|---|
| **D1** | 查看器扩展方式 | **B · 新建按扩展名路由的查看器注册面** | 与 `assetKinds` 同构（id + 认领表 + 降级链）。直接扩 `MediaBody` 会在两批内变成巨型组件，且第三方无法加格式。**通道化（`ctx.viewers`）不在本单**——先做模块级注册面，接口按通道形状预留 |
| **D2** | 本批做几个容器 | **流内块 + 浮层放大**（沿用现有两态） | 钉到纸 / 右侧面板各有独立交互课题，另行立项。查看器组件本体写成一次、四容器共用，接口留 `mode` 位 |
| **D3** | 大依赖策略 | **注册面在产物热更 · 重依赖本体经宿主桥走应用 bundle 分片**（2026-09-23 修订） | 原案「全部动态 `import()` 懒加载」在产物域**做不到**：`build-builtin-plugins.mjs:232` 对动态裸 import 直接 `process.exit(1)`，且 esbuild `bundle:true` 无 `splitting`（:178）⇒ `import('pdfjs')` 只会**内联**进产物（今日 `renderers/entry.js` 已 2.0 MB）。改法：轻查看器（自绘/零依赖）留产物内热更；重依赖 viewer（pdf/3d/epub/mermaid/monaco）**本体放应用 bundle** 由 vite 分片，经 renderer-host 桥按需取。判据不变：不进入口 chunk、不在启动路径上 |
| **D4** | 全部批次的性质 | **一律正式 feature，统一编号，无候补分级** | 只有实施顺序先后。每批独立可验收，测试全绿再动下一批 |
| **D5** | 旧 Office（doc/xls/ppt） | **不做内嵌解析，做「移交系统」** | 四条依据见 §2.1。形态 = 文件壳 + 类型标记 + 通用「用系统程序打开」按钮 |

### 2.1 D5 的依据

1. **唯一的一等 Office 出口吃不了它**——OfficeCLI 只认 OOXML，旧格式是 OLE 二进制，两套东西；
2. **前端这条路只通一条**——`.xls` 有 SheetJS 能读，`.doc` 没有像样的 JS 库（mammoth 只管 docx），`.ppt` 根本没有。引一套依赖只解决三分之一；
3. **出现频率极低**——agent 产出的一律是 OOXML，旧格式只在翻历史存量时出现，收益撑不住依赖；
4. **机器上通常装着 Office / WPS**——交给系统默认程序打开，零依赖且体验更好。

附带收益：「用系统程序打开」做成**通用**按钮（所有查看器公共壳都带），顺带解决「想用 Excel 打开 csv 而不是看表格视图」这类偏好场景。

**代价（诚实栏）**：需要新宿主能力位 `openWithSystem(path)` ⇒ 触发 `host-surface.baseline.json` 漂移 + **须重建 exe**。故 B5 单列成批，不混进其它批。

## 3. 架构（D1 取 B 后的形状）

### 3.1 查看器契约

新建 `src-ui/src/plugins/builtin/renderers/viewer-registry.ts`（与 `asset-kinds.ts` 同构）：

```ts
export interface ViewerDef {
  /** 机器名（如 'audio' / 'pdf' / 'code'） */
  id: string;
  /** 认领的扩展名（小写无点；装载期归一，重名扩展名**装载期拒绝**） */
  exts: readonly string[];
  /** 需要写进 src 的 MIME（图片/视频/音频用）；缺省 = 该查看器自持字节 */
  mimes?: Readonly<Record<string, string>>;
  /** 要不要读文件字节；false = 只看路径与元数据（如归档列名） */
  needsBytes: boolean;
  /** 字节上限（超出 → 截断或拒绝，**不静默**） */
  maxBytes?: number;
  /** 轻查看器：组件本体在产物内（零依赖 / 自绘 / 复用既有原语） */
  component?: ComponentType<ViewerProps>;
  /** 重依赖查看器：本体在应用 bundle，经宿主桥 `loadViewer(id)` 取（B2 批引入，见 §3.2） */
  heavy?: string;
}

export interface ViewerProps {
  block: SourcedBlock;
  filePath?: string;
  /** needsBytes 且未超限时给：媒体走 data URI，文本走原始字符串 */
  bytes?: { kind: 'data-uri'; value: string } | { kind: 'text'; value: string };
  mode: 'stream' | 'overlay' | 'pinned' | 'panel';
  onOpenOverlay?: () => void;
}
```

**降级链**（对齐 `resolveAssetBlock` 的既有纪律，**注册面缺失不再等价于「给你看 JSON」**）：

```
ext 命中查看器 → 用它
   ↳ 懒加载失败 / 字节超限 / 渲染抛错 → 文件壳 + 一行可读错误（带窗：说清哪个文件、哪一步）
ext 未命中 → 通用文件壳（现行为，零变化）
```

**报错带窗**：未知扩展名报「已支持的扩展名清单」；查看器失败报「查看器 id + 失败步骤」。错误即导航，不静默降级。

### 3.2 落点

| 项 | 落点 |
|---|---|
| 查看器注册面 | `src-ui/src/plugins/builtin/renderers/viewer-registry.ts`（新） |
| 轻查看器（产物域） | `src-ui/src/plugins/builtin/renderers/viewers/`（新目录，一件一文件）——零依赖 / 自绘 / 复用既有原语 |
| 重依赖查看器（应用域） | `src-ui/src/app/paper/viewers/`（vite 真分片）+ 宿主桥键 `loadViewer(id)`（`plugins/loader.ts` 注入；B2 批引入 ⇒ 该批起需重建 exe） |
| `MediaBody` 改造 | 同文件内改为**宿主**：`ext → viewerRegistry.resolve(ext)` → 命中走查看器、未命中走现文件壳；`MEDIA_MIME` 表迁入各查看器的 `mimes` |
| 公共壳 | `.pp-viewer`（标题行 + 内容区 + 失败态）；**工具条本批不渲染**（空工具条行会引入高度漂移），B5 加按钮时与高度模型同批落 |
| 静态测高 | 查看器若改块高 ⇒ 同批改 `paper/measure.ts` 的 `viewerBodyH` 镜像 + `paper/type-tokens.ts` 的 `ASSET_TOKENS.viewer`（token 真源），一致性由对拍钉住 |
| 样式 | `PaperPanel.css` 新增 `.pp-viewer*` 段（墨/纸/线全走 token，无裸色值） |
| 分片判据 | 大依赖只出现在**应用 bundle 的分片**（入口 chunk 不含 pdfjs/mermaid/three/monaco）；产物内不做动态 import |

## 4. 批次

### 4.0 三包重排（2026-09-23 用户要求整合：15 批 → 3 包 + 收尾）

**重排理由**：B1/B2 实测显示，单个查看器的实现成本很小（一件一文件 + 一条注册 + 一组用例），
而**工序成本**（每次全量门禁 ≈ build 45s + vitest ~190s + biome + doc-check）与**共享缝成本**
（注册面 / 宿主 / 样式 / 测高 / 依赖通道）才是大头。故按**机制**而非按格式分包：
同一包内共享一次依赖/通道/门禁，包内条目可并行铺（各自独立文件，互不依赖）。

| 包 | 内容（原批次） | 依赖与部署 | 门禁 |
|---|---|---|---|
| **P1 · 轻查看器总装** | 数据面 B7 · 归档与 hex B8 · 字体 B10 · 科研 B12 · 字幕与邮件 B13（+ 兜底认领：未知扩展名不再落文件壳） | **零新依赖**；产物热更，**不重建 exe** | 包内逐件 focused vitest → 包末一次全量门禁 |
| **P2 · 宿主面扩容 + 重依赖三件套** | 宿主桥 `loadViewer` 通道（D3 修订件）· PDF B3 · Mermaid B6 · 3D B9 · **并落 B5 的 `openWithSystem` 能力位** · **顺带：未知扩展名的体积预检**（P1 实测发现——兜底查看器接未知档，二进制分支只能整份 `read_base64`；`fs_cap` 加一个 stat/尺寸预检动作即可在读取前拦下大文件，同属宿主面变更，一次 exe 重建带上） | 新增 `pdfjs-dist` / `mermaid`（`three` 已在）；**须重建 exe** | 全量门禁 + `gen:host-surface` + 桌面打包验证 |
| **P3 · 承接面 + 收尾** | Office 读取 B4（走 `process_cap office_exec`）· 旧 Office 出口壳 · epub 与 ipynb B11 · Markdown 独立查看 B14（经 P2 的 `loadViewer` 复用应用侧 markdown 渲染器，不塞第二份解析）· 文档面 B15 | 零新依赖；产物热更 | 全量门禁 + `doc-check` + 竣工归档 |

**包内提交纪律**：包内每 3-5 件一条 commit（保持可 bisect），包末全量门禁全绿后才算该包竣工；
原 B1-B15 的分项表保留在下方，作为各包的**逐件清单**（内容不变，只是分组与顺序改由包决定）。

### 4.1 逐件清单（原文保留）

> 全部为正式 feature；顺序由所属包决定（P1 → P2 → P3）。

### 4.2 P2 详设：宿主桥 `loadViewer` + 重依赖三件套（2026-09-23 立）

**为什么需要通道**：产物域禁动态裸 import（D3 修订）⇒ 重依赖（pdfjs / mermaid / three）只能随
**应用 bundle** 编译，而查看器注册面在产物里（热更）。两者之间加一个「按 id 取重查看器」的宿主桥键。

**桥面**（三处同形，同 host 桥既有纪律）：

```
产物侧（renderers/viewer-registry.ts 的 ViewerDef）  heavy?: string        ← 声明用哪个重查看器
宿主桥（renderer-host.ts / renderer-host.aliased.ts）loadViewer(id)         ← 产物域经 window.__lantai_plugin_host__
桥实现（plugins/loader.ts 注入）                      loadViewer: loadHeavyViewer
应用侧（app/paper/viewers/index.ts）                  loadHeavyViewer(id)   ← 白名单 + 动态 import（vite 真分片）
```

- 重查看器收 `ViewerProps`（与轻查看器同形），故宿主渲染路径**只有取组件那一步不同**：
  `heavy` ⇒ `await loadViewer(id)`（取件失败 → 文件壳 + 可读错误，**不静默**）；`component` ⇒ 直取。
- 加桥键 = **动宿主面** ⇒ 该批 `npm run gen:host-surface` 重生成 baseline + **重建 exe**（B5 同批）。
- 分片判据：入口 chunk 不含 pdfjs / mermaid / three（构建产物断言，见 §5 全批共同）。

**P2 条目**：B3 PDF（pdfjs-dist；流内首页缩略 + 页数，浮层翻页/缩放/文本层）· B6 Mermaid
（应用侧围栏认领 + 失败回落代码块 + 墨阶主题）· B9 3D（three + GLTFLoader/DRACO/KTX2 + 轨道控制 +
线框切换；流内首帧静态、浮层可交互）· B5 通用出口（`openWithSystem` 能力位 + 公共壳工具条按钮，
旧 Office 三格式借此出壳）· 顺带 `fs_cap` 尺寸预检（P1 发现的未知档整份读风险）。

**P2 落地口径两处修订（2026-09-23 施工中定）**：

1. **B5 做成 `fs_cap` 的两个 action，不新开能力位命令**：`stat`（尺寸预检）+ `open_with_system`
   （ShellExecuteW，**只开用户通道**——`is_agent=true` 口内即拒）。理由：路径解析与权限语义本来
   就收在 fs 口，新开命令只是多一层注册面；**副作用是 `host-surface.baseline.json` 零漂移**
   （基线记的是插件宿主 mod 面，不是能力口 action 表）——原计划的「baseline 同批重生成」不再需要，
   但 **exe 仍须重建**（Rust 有新代码）。
2. **系统打开出口落题名行右端（绝对定位），不做独立工具条**：`.pp-viewer-head` + `.pp-viewer-open-system`
   绝对定位 ⇒ **不进高度流水**（与组合芯片同一条落位纪律），故本批对所有查看器的静态测高**零改动**
   （原计划「工具条」会引入一致的高度漂移与一串测高测试改动，收益不值）。能力位缺席（旧 exe 换新
   产物）时按钮本会话收起 + 首次失败出可读错误行（容缺、不静默）。

**P2 验收**：全量门禁 + `gen:host-surface` + **重建 exe** + 真机（§8 第 3/5/6 项：PDF 翻页与选中、
系统打开、Mermaid 出图与坏语法回落）。

### 4.3 P3 详设：承接面 + 收尾（2026-09-23 立）

**落点分工**（判据同 D3：能用产物内自绘/既有依赖的留产物热更；要用**应用侧**渲染器的走 `heavy` 通道）：

| 件 | 形态 | 要点 |
|---|---|---|
| Office 读（B4） | **轻**（产物侧 `viewers/office.tsx`） | 走 `process_cap{action:'office_exec', is_agent:false}`（**不能调 `office` 域工具**——那是 agent 面 + 目标文件门禁）；docx → 富文本块序列 · xlsx → 复用 `grid` 的**表体**（多 sheet 页签）· pptx → 逐页文本；只读，无写入口 |
| 旧 Office 出口（B5 余项） | **轻**（`viewers/legacy-office.tsx`） | 不解析：文件壳 + 类型标记（「Word 97-2003 文档」等）+ 一行「旧格式无法内嵌预览」；系统打开按钮由壳统一提供（P2 已落） |
| epub（B11） | **轻**（`viewers/epub.tsx`） | 复用 zip 中央目录解析 + `DecompressionStream('deflate-raw')`（WebView2 原生）+ `META-INF/container.xml` → OPF → spine；章节文本渲染 + 目录导航 |
| ipynb（B11） | **重**（`app/paper/viewers/ipynb.tsx`） | 单元格序列（markdown / code / output）；markdown 单元格要**复用应用侧 markdown 渲染器** ⇒ 走 heavy 通道（产物域拿不到它） |
| Markdown 独立查看（B14） | **重**（`app/paper/viewers/markdown-doc.tsx`） | 同上：复用应用侧 `MarkdownBody` + 左侧标题树（锚点跳转）；**不塞第二份 markdown 解析** |
| 文档面（B15） | — | 本单登记、README 状态、facts 零漂移核对、竣工即归档 + HISTORY |

**P3 验收**：全量门禁 + `doc-check`；真机（§8 第 4/8 项：docx/xlsx/pptx 出内容且不触发写权限、epub/ipynb/mol/geojson/srt/eml 各能打开）。

### P3 施工记录（2026-09-23）

**五件承接面查看器**（两轻三重，登记由主 Agent 统一落）：

| 件 | 形态 | 要点与如实标注 |
|---|---|---|
| **Office**（B4） | 轻（`viewers/office.tsx`，15 例） | 走 `process_cap{action:'office_exec', is_agent:false}`，argv 形状抄 `agent/tools/office.ts`（`['view', f, 'annotated'|'text']`，targets 恒 `write:false`，不发 `--json`）；docx → 正文块序列 · xlsx → `GridBody` 多表页签（切页签只重渲不重读）· pptx → 逐页文本。**只读**（测试逐次断言 argv[0] ∈ 读动词面）。未支持：pptx 出图（写动词）· 批注/修订 · 公式求值结果 · 内嵌图片 · 32K 输出截断/单表 1000 行/逐页 300 页上限（都有可见读数） |
| **旧 Office 出口**（B5 余项） | 轻（`legacy-office.tsx`，7 例） | 不解析：文件壳 + 类型标记 + 「旧格式无法内嵌预览」；系统打开按钮由壳统一提供（P2） |
| **epub**（B11） | 轻（`epub.tsx`，21 例） | 自绘 zip（EOCD+中央目录+本地头）+ `DecompressionStream('deflate-raw')` + `container.xml` → OPF → spine → 逐章 XHTML；左目录 + 右正文双上限盒。**method 8 是真跑**（本机 Node 暴露 `deflate-raw`）+ 另加一条「环境无 DecompressionStream」的可读降级用例。未支持：DRM/加密封装 · 内嵌 CSS/图片/字体 · 脚注跳转 · nav/NCX 层级目录（目录 = spine 平铺） |
| **ipynb**（B11） | 重（`app/paper/viewers/ipynb.tsx`，22 例） | markdown 单元格复用应用侧渲染器（`heavy` 通道）；code 单元格用 hljs（已在应用 bundle，零新增依赖），墨色沿用 `.pp-md-code` 作用域（不写第三份配色）；ANSI 剥除复用 `paper/tool-text`。未支持：widget · HTML 输出不注入 · 图片只报 MIME/字节数 · attachments · 无执行入口 |
| **Markdown 独立查看**（B14） | 重（`app/paper/viewers/markdown-doc.tsx`，14 例） | 复用 `MarkdownBody` + 标题树（按标题行切段 + section ref → `scrollIntoView`，**未改应用侧渲染器**）；容器宽 < 640px 折叠目录。未支持：树只收 `#`–`###` · 超 8000 行截断 + 吸顶横幅 · 无编辑入口 |

**整合期拆掉的两处结构病**：
1. **`components ↔ viewers/index` 的环**：office 按施工单复用 `GridBody`（`import { GridBody } from '../components'`）⇒ 模块顶层 `registerBuiltinViewers()` 在环里撞 `BUILTIN_VIEWERS` 的 TDZ（Cannot access before initialization，测试域与**产物域**同时炸）。修法：注册挪到**装配点**（`assetRendererComponents()`，幂等——已注册 id 跳过）；「防装配双跑」改由「外来重名仍装载期拒绝」承担（测试同步改写）。教训记此：**注册面不得在模块顶层跑**，一旦允许产物内互相 import，环是常态。
2. `GridBody` 原本没 `export`（施工单措辞有误）——office 批补的 `export` 保留（组件体零改动）。

**P3 门禁**：`npm run build` ✓ · `npx vitest run` **395 文件 / 4234 例全绿** · `npx biome ci .` exit 0 · `npm run doc-check` ✓。
**officecli 端到端**（子代理临时 scratch 测试，跑完即删）：真 docx/xlsx/pptx 经真 officecli 解析断言全中；坏文件/缺失文件各出带原话的可读错误。

### P2 施工记录（2026-09-23）

**通道（本包的结构件）**：

| 面 | 落点 |
|---|---|
| 取件通道 | 产物侧 `ViewerDef.heavy = '<id>'`（与 `component` **二选一**，装载期拒绝双份/双无）→ 宿主渲染前 `loadViewer(id)` |
| 桥三处同形 | `renderer-host.ts`（真：直连应用侧 `loadHeavyViewer`）· `renderer-host.aliased.ts`（产物域：读 `window.__lantai_plugin_host__.loadViewer`）· `plugins/loader.ts`（注入） |
| 应用侧装载面 | **新** `app/paper/viewers/index.ts`：`import.meta.glob('./*.tsx')` —— **目录即白名单**，每个文件一个 vite 真分片；未注册 id / 无 default ⇒ 抛错（宿主转「文件壳 + 可读错误」） |
| 登记（产物侧） | `viewers/pdf.ts` · `viewers/model3d.ts`：只声明认领 + MIME + `maxBytes`（32 MiB）+ `heavy`，本体在应用侧 |

**B5 · 系统出口 + 尺寸预检**（两处口径修订见 §4.2）：

| 面 | 落点 |
|---|---|
| Rust | `fs_cap` 两个新 action：`stat`（只给 `{path,size,is_dir}`）· `open_with_system`（`ShellExecuteW`，**agent 侧口内即拒**） |
| 宿主 | `useFileSize` **先 stat 后读**：预检落定前不读、超限档**根本不读**（大文件不进 IPC）；预检缺席（旧 exe）⇒ 回落读后判据（容缺） |
| 出口 UI | `.pp-viewer-head` + `.pp-viewer-open-system`（题名行右端**绝对定位**、不进高度流水 ⇒ 全浏览器的静态测高零改动）；失败出可读错误行，「未知 action」时本会话收起按钮 |

**新增依赖**：`pdfjs-dist@6.3.289` · `mermaid@12`（`three` 已在）。

**分片判据（实测，`npm run build`）**：`pdf-zjYMagsG.js` 537 KB + `pdf.worker.min.mjs` 1.3 MB ·
`three-DB74AqZ-.js` 567 KB · `mermaid.core-3Qc9MIER.js` 671 KB · `model3d-BnuMLESx.js` 86 KB
——**入口 chunk 只 +8 KB**（5 115.50 → 5 123.68 KB）⇒ 重依赖确未进启动路径 ✓。

**Mermaid 接线（我这份）**：`app/paper/builtin-renderers.tsx` 的 `MdCodeBlock` 只在 `el.lang === 'mermaid'`
时转交 `MermaidBlock`（失败由它出「图渲染失败：<原因>」并把原代码块**原样放回**）；测试见
`tests/paper-code-highlight.test.ts` 的新 describe（轮询到状态落定后断言两条路都合规）。

**壳层门禁**：`cargo check` ✓；`cargo test` **509 过 / 1 挂**——挂的是
`utils::bg_jobs::tests::spawn_bg_with_uses_given_job_id`（10s 等待超时），**单跑 2.1s 即过**，
系三路并行测试压满机器所致（CONVENTIONS §3「待机红线是超时不是逻辑」同款），与本包改动无关。

**三件应用侧重查看器**（并行铺，主 Agent 统一登记与接线）：

| 件 | 落点 | 要点与如实标注 |
|---|---|---|
| **PDF**（B3） | `app/paper/viewers/pdf.tsx` + `.css`（12 例） | 走 `pdfjs-dist/legacy/build/pdf.mjs`——**非 legacy 版在 Node 24/jsdom 里 import 即抛**（初始化算 md5 用了 ES2026 的 `toHex`，legacy 自带 polyfill，老 WebView2 同理更安全）；worker 经 `?url` 出独立资源（构建实证 `pdf.worker.min-*.mjs` 1.3 MB）。流内首页缩略 + 页数、浮层翻页/缩放/文本层（近似落位）。**未支持**：cmaps/standard_fonts/wasm 不打包（非内嵌 CJK 字体档文字可能缺失、JPEG2000 图可能画不出）· 加密档无密码框 · 注释层/表单/签名不渲染 · 一次一页 |
| **3D**（B9） | `app/paper/viewers/model3d.tsx` + `.css`（13 例） | GLTFLoader/OBJLoader/STLLoader 走 `parse`（data URI → ArrayBuffer，不走 `loader.load(url)`）；流内静态首帧、浮层轨道控制 + 线框切换；读数（格式/三角面/顶点/包围盒）与 GPU 无关 ⇒ 无 WebGL 时读数照显 + 可读提示；three 资源成对 dispose。**未支持**：DRACO/KTX2/meshopt 具名报错（不接解码器）· glTF 动画/外部 URI 资源/`.mtl` 贴图 |
| **Mermaid**（B6） | `app/paper/mermaid-block.tsx` + `.css`（13 例） | 接线在我这侧（`MdCodeBlock` 认 `el.lang === 'mermaid'`）；**真解析**（jsdom 只需补 `getBBox` 量尺桩）；主题现读纸面墨阶 token（**墨阶不可读 ⇒ 不出图**，绝不回落 mermaid 默认配色）；pending 出回落体（不空白、不跳高）；失败出「图渲染失败：<原因>」+ 原代码块。落点从 `viewers/` 挪到 `paper/`——`viewers/` 是重查看器白名单目录（`import.meta.glob` 取件、props 必须 `ViewerProps`），围栏渲染器不是文件查看器；`tests/viewer-registry.test.ts` 加断言钉住白名单只含 `['model3d','pdf']` |

**P2 门禁**：`npm run build` ✓（**5m10s**，含三路并行占机）· `npx vitest run` **390 文件 / 4152 例全绿** ·
`npx biome ci .` exit 0 · `npm run doc-check` ✓ · `host-surface.baseline.json` **零漂移**（口径见 §4.2 第 1 条）。
`npm run doc-sync` 现为红，**原因不在本包**：`docs/facts.generated.md` 漂的是 `engine_contract_version`
（他窗在途改 `engine/src/contract.rs`，7 → 9），我未夹带该重生成。

**exe 重建（本包部署面要求，已跑）**：`cmd /c build.cmd`（= 前端构建 + `cargo tauri build`）exit 0 ——
`target/release/lantai.exe` **61 390 029 字节**（20:08）+ `兰台_1.0.1_x64_zh-CN.msi` 167 MB + NSIS setup；
壳层 Rust 新代码（`fs_cap stat` / `open_with_system`）已进这份 exe ⇒ §8 第 3/5/6 项真机验收可用它跑。

### B1 · 查看器注册面骨架 + 音频

| 项 | 落点 |
|---|---|
| 注册面 | `viewer-registry.ts`：`ViewerRegistry` 类 + 模块级单例 + `register` / `resolve(ext)` / `supportedExts()`；重名扩展名装载期 `throw`（同 `assetKinds` 纪律） |
| 宿主改造 | `MediaBody` → 查表分发；未命中走原文件壳（**行为零变化**） |
| 音频查看器 | `viewers/audio.tsx`：`<audio controls>` + 文件名 + 时长读数；认领 mp3/wav/flac/m4a/aac/opus/oga |
| 公共壳 | `.pp-viewer` 标题行（物类签 + 题名）+ 内容区；图片/视频一并迁入（**行为等价、高度零漂移**——壳的数值与原 `.pp-media` 同源） |
| 新增依赖 | **零**（音频走原生 `<audio>`） |
| 测高镜像 | `ASSET_TOKENS.viewer`（padV/labelSize/labelMarginB/audioBoxH）+ `ASSET_DERIVED` + `measure.ts` 的 `viewerBodyH`；音频**固定盒高**（chem boxH 先例），静态镜像精确 |
| 判据 | 新增 `tests/viewer-registry.test.ts`；扩 `tests/asset-media-load.test.tsx`；音频 ext 表 registry ↔ measure 对拍 |
| 附带改动 | `scripts/build-builtin-plugins.mjs` 的宿主桥重定向**放宽为末段匹配**——原正则只认同目录形态 `./renderer-host`，`viewers/` 子目录里的 import 漏过重定向 ⇒ 真 `host.ts` 进产物图、在 `app/overlay.tsx` 上炸 jsx-runtime 解析（B1 首构即红，见 §10 第 7 条）。构建期改动，产物字节变（热更即可），**不动宿主面** |

**这批是整条线的地基**，跑通后每加一种格式都是「一个文件 + 一条注册 + 一组用例」。

### B2 · 代码查看器（只读高亮；hljs 优先 — 2026-09-23 修订）

| 项 | 落点 |
|---|---|
| 查看器 | `viewers/code.tsx`：**highlight.js 高亮**（主 bundle 已有且已按纸面墨阶主题化）+ CSS 行号列；浏览器原生 `Ctrl+F` 直接可用 |
| 同色 | 高亮判据与墨阶复用 `app/paper/builtin-renderers.tsx` 的 `highlightCode` / `.pp-md-code`（流内代码块与查看器同色） |
| 认领 | 文本类扩展名表（ts/tsx/js/jsx/rs/py/go/java/c/cpp/h/css/html/sql/sh/ps1…）+ `text/*` MIME 兜底 |
| 新增依赖 | **零**（hljs 已在主 bundle） |
| 大文件 | `maxBytes` 上限；超出 → 只读前 N 行 + 显式「已截断（原 M 行）」横幅 |
| 不做 | 只读 Monaco：`ui/lsp-client.ts:20` 只有 `import type`，**仓库无既有装载路径**，引入 = 第一次装 Monaco（worker + `MonacoEnvironment` + 分片）。只有「折叠 / 多光标 / 超大文件虚拟滚动」真成刚需时另立小单 |

### B3 · PDF 查看器

| 项 | 落点 |
|---|---|
| 新增依赖 | **`pdfjs-dist`**（大 ⇒ 走应用 bundle 分片 = `heavy`；产物域装不下，见 D3）⇒ 该批**需重建 exe** |
| 查看器 | `viewers/pdf.tsx`：翻页 + 缩放 + 文本层可选中 + 页数读数 |
| 容器 | 流内给**首页缩略 + 页数**，点开进浮层看全篇（对齐既有「点击放大」语义） |
| 安全 | pdfjs 自带解析沙箱；不注入任何 HTML |
| 大文件 | 页数上限 + 单页渲染上限；超出显式标注 |

### B4 · Office 查看器（OOXML，走 OfficeCLI）

| 项 | 落点 |
|---|---|
| 承接 | **走既有 OfficeCLI 读**（`view` / `get` / `query`），不引 `mammoth` / `exceljs`（避免第二套解析真源） |
| 走哪条口 | renderer 是**用户路径** ⇒ 只能走 `process_cap{action:'office_exec', is_agent:false}`（**不能调 `office` 域工具**：那是 agent 面 + 目标文件门禁）。officecli 每次调用自成一次 open/save（无常驻）⇒ xlsx 多 sheet 在**一次**调用里取全，不逐 sheet 起进程 |
| 新增依赖 | **零**（officecli 随包） |
| 查看器 | `viewers/office.tsx`：docx → 富文本块序列；xlsx → 复用 `grid` 原语逐表渲染（含 sheet 页签）；pptx → 逐页文本 + 可走 `screenshot` 出图 |
| 认领 | docx / xlsx / pptx |
| 只读 | 查看器**只读**，不提供写入口（写走 `office(action, …)`，权限面不混淆） |

### B5 · 「用系统程序打开」通用出口 + 旧 Office 出口

| 项 | 落点 |
|---|---|
| 新能力位 | `openWithSystem(path)`（Rust 侧 ShellExecute）——**动宿主面**。实测无既有可用口：`process_cap` 8 个 action 无 `start`，`oauth.rs:166` 只开 URL |
| 公共壳 | 工具条加「用系统程序打开」按钮，全部查看器共享 |
| 旧 Office 出口 | `viewers/legacy-office.tsx`：不解析，出文件壳 + 类型标记（「Word 97-2003 文档」等）+ 一行「旧格式无法内嵌预览，已提供系统打开」 |
| 认领 | doc / xls / ppt |
| 部署 | **须重建 exe**；`host-surface.baseline.json` 同批重生成（`tests/host-surface-seal.test.ts` 是考官） |

### B6 · Mermaid 代码块渲染（层二；落点在应用侧 — 2026-09-23 修订）

| 项 | 落点 |
|---|---|
| 落点 | **不新增 kind**。围栏认领在 `app/paper/builtin-renderers.tsx` 的 `MdCodeBlock`（**随应用编译，不是可禁用产物**——见 `composition/renderer-service.tsx:13` 归属纪律）⇒ 该批**需重建 exe** |
| 渲染器 | `src-ui/src/app/paper/viewers/mermaid-block.tsx`：vite 动态 import `mermaid`，出 SVG（真分片，不在入口 chunk） |
| 新增依赖 | **`mermaid`**（体积大 ⇒ 必须走应用 bundle 分片；产物域禁动态 import，见 D3） |
| 降级 | 解析失败 → **回落到原代码块**（可读源码 + 一行「图渲染失败：<原因>」），不吞错、不空白 |
| 触发面 | 只在模型显式写 ` ```mermaid ` 围栏时触发 ⇒ 与 `show_asset(chart)` 零竞争 |
| 主题 | 跟随纸面墨阶（`--ink-*` 三级），不用 mermaid 默认配色 |

### B7 · 数据面查看器

| 查看器 | 认领 | 落点 |
|---|---|---|
| 表格数据 | csv / tsv | 复用 `grid` 原语（表头冻结 + 行数读数 + 大文件截断） |
| 结构化树 | json / jsonl / yaml / toml / xml | 折叠树（键值 + 类型 + 深度限位）；jsonl 逐行独立根 |

**新增依赖**：`yaml` 已在；csv 走自绘（RFC4180 子集：引号转义 + 换行）、xml 走 WebView2 原生 `DOMParser`、jsonl 零依赖；**toml 需小解析器**（自绘或 `smol-toml`，开工时按体积定）。

### B8 · 归档列表与十六进制

| 查看器 | 认领 | 落点 |
|---|---|---|
| 归档列表 | zip / tar / gz / 7z | **只列目录**（名 + 大小 + 压缩比），不解压、不落盘 |
| 十六进制 | 未知二进制（非文本、非上述任一） | hex 视图（偏移 + 十六进制 + ASCII 列），分页读取 |

**新增依赖**：zip 只读目录 = EOCD + 中央目录自绘（**不解压**，比引库更小）；gz 走 WebView2 原生 `DecompressionStream`；**7z 需引库** ⇒ 若做 7z 则该批进应用 bundle（重建 exe）。

### B9 · 3D 模型

| 项 | 落点 |
|---|---|
| 查看器 | `viewers/model3d.tsx`：three.js 懒加载，`GLTFLoader` / `DRACOLoader` / `KTX2Loader` 已在依赖内 |
| 交互 | 轨道控制器（转 / 缩 / 平移）+ 线框切换 + 尺寸读数 |
| 认领 | glb / gltf / obj / stl |

### B10 · 字体预览

| 项 | 落点 |
|---|---|
| 查看器 | `viewers/font.tsx`：字形样本（常用字表 + 自定义输入行），`@font-face` 动态注入 |
| 认领 | ttf / otf / woff / woff2 |

### B11 · 电子书与笔记本

| 查看器 | 认领 | 落点 |
|---|---|---|
| 电子书 | epub | 章节导航 + 正文（复用 markdown 体渲染） |
| 笔记本 | ipynb | 单元格序列（markdown / code / output 三段），输出按类型分发 |

**新增依赖**：epub = zip + OPF + XHTML ⇒ 复用 B8 的自绘 zip 读取（不引 epubjs）；ipynb 是 JSON，零依赖。

### B12 · 科研面

| 查看器 | 认领 | 落点 |
|---|---|---|
| 化学结构 | mol / sdf / pdb | 复用 `chem` 原语（`smiles-drawer` 已在依赖内） |
| 地理数据 | geojson / kml | 简图（外边界 + 要素点），不做投影完整实现 |

### B13 · 字幕与邮件

| 查看器 | 认领 | 落点 |
|---|---|---|
| 字幕 | srt / vtt | 时间轴表（序号 + 起止 + 文本），带时长读数 |
| 邮件 | eml | 头字段 + 正文 + 附件列表（附件本身走各自查看器） |

### B14 · Markdown 独立查看

| 项 | 落点 |
|---|---|
| 查看器 | `viewers/markdown-doc.tsx`：复用 `markdown` 体渲染 + 左侧目录（标题树 + 锚点跳转） |

### B15 · 文档面与门禁收尾

- `docs/plans/README.md` 活跃线表加本单（**2026-09-23 立项即登记**——`doc-check` 的 orphans 查在案：未登记的 plans 正文 = 门禁红）；
  竣工后按「竣工即归档」进 `docs/archive/` 并补 `HISTORY.md`。
- 生成物：本单**不动**模型可见工具面 / 组合层契约（B5 例外，见 §7）⇒ `gen:doc-facts` 预期零漂移；有漂移以重跑为准。
- 若 B1 的注册面被采纳为长期形态，**另立**「查看器通道化（`ctx.viewers`）」小单——本单不碰 `composition/**`。

## 5. 判据（测试清单）

| 文件 | 用例 |
|---|---|
| `tests/viewer-registry.test.ts`（新，B1） | 重名扩展名装载期 throw；`resolve(ext)` 命中/未命中；`supportedExts()` 与各 `ViewerDef.exts` 并集一致；disposer 幂等 + 陈旧性守卫 |
| `tests/asset-media-load.test.tsx`（扩，B1） | 图片/视频迁入公共壳后**行为等价**（既有用例全绿）；音频 ext 命中音频查看器；未知 ext 走文件壳且文案不变；`fs_cap read_base64` 失败态可读 |
| `tests/viewer-code.test.tsx`（新，B2） | 认领表覆盖；超 `maxBytes` 截断 + 横幅；高亮与流内代码块同源（`.pp-md-code` 判据）；入口 chunk 无新增依赖 |
| `tests/viewer-pdf.test.tsx`（新，B3） | fixture 页数读数；翻页；解析失败 → 文件壳 + 带窗错误；入口 chunk 不含 pdfjs |
| `tests/viewer-office.test.tsx`（新，B4） | 走 `office` 域读（**断言不直接 import mammoth/exceljs**）；xlsx 多 sheet 页签；只读（无写入口） |
| `tests/viewer-open-system.test.tsx`（新，B5） | 按钮存在且调用能力位；旧 Office 三格式命中 legacy 查看器；无能力位时按钮不出（容缺） |
| `tests/mermaid-block.test.tsx`（新，B6） | 合法图出 SVG；语法错误**回落代码块**且带原因；主题取墨阶变量（无裸色值）；入口 chunk 不含 mermaid |
| `tests/viewer-data.test.tsx`（新，B7） | csv/tsv 进 `grid`；json/yaml 树折叠；超限截断标注 |
| `tests/viewer-archive-hex.test.tsx`（新，B8） | zip 只列名不落盘；二进制出 hex 分页 |
| `tests/viewer-misc.test.tsx`（新，B9-B14） | 3D / 字体 / epub / ipynb / chem / geo / srt / eml / markdown 目录各自最小用例 |
| `tests/paper-visual-decisions.test.ts`（扩） | `.pp-viewer*` 段不出现裸色值（同 `asset-ink-tiers` 纪律） |
| 全批共同 | **入口 chunk 守卫**：大依赖（pdfjs / mermaid / three / monaco）不在入口 chunk（构建产物断言，对齐 bundle 退役教训）。⚠️ 断言需 `dist/` 在场——仓库先例 `tests/face-deps-seal.test.ts:71` 是「dist 在场才跑」，与门禁顺序冲突 ⇒ 本单写死 **build → vitest**；守卫在缺 dist 时**报错**而非静默跳过 |

## 6. 门禁（不过不 commit）

```
cd src-ui && npm run build          # 先构建（入口 chunk 守卫要 dist 在场）
cd src-ui && npx vitest run
cd src-ui && npx biome ci .        # 0/0 保持
cd src-ui && npm run doc-check     # 文档面（本单动了 docs/plans）
```

**逐批例外（2026-09-23 修订）**：
- **B5**（新能力位）⇒ 追加 `npm run gen:host-surface` + 重生成 baseline + **重建 exe**；
- **B3 / B6 / B9**（重依赖走应用 bundle）⇒ 产物热更换不到它们，**需重建 exe**（注册面与轻查看器仍热更）；
- **B1 / B4 / B7 / B8 / B10-B14**：只换产物热更（各批「新增依赖」栏为零时才成立）。
**不需要**：`verify:convergence`（不动 `agent/**` 与 `composition/**`、不动工具契约）；`cargo test`（除 B5）。

## 7. 部署面（诚实栏）

- **产物域**（注册面 + 轻查看器 + `PaperPanel.css`）⇒ **只换产物热更**：B1 / B4 / B7 / B8 / B10-B14（未引库者）。
- **应用 bundle**（重依赖本体）⇒ **须重建 exe**：B3（pdfjs）/ B6（mermaid）/ B9（three）/ B8（若做 7z）/ B2（若上 Monaco）。
  理由见 D3——产物域禁动态裸 import（`build-builtin-plugins.mjs:232`），重依赖只能随应用编译分片。
- `src-ui/src/plugins/host-surface.baseline.json` **预期零漂移**（`tests/host-surface-seal.test.ts` 是考官）；B1 不加桥键 ⇒ 零漂移。
- **B5 例外**：新增 `openWithSystem` 能力位 ⇒ baseline 同批重生成 + **须重建 exe**。
- 大依赖以**应用 bundle 的分片**形态出现：随包携带但不在启动路径上；产物内不做动态 import（管线禁止）。

## 8. 真机验收（owner：用户）

1. **音频**：给一个 mp3，流内出播放器，能播、能拖进度、时长对；
2. **代码**：给一个 .ts 和 .rs，语法高亮对、行号在、大文件截断横幅诚实；
3. **PDF**：给一份多页 PDF，流内是首页缩略 + 页数，点开浮层能翻页、能选中文本；
4. **Office**：docx 出正文、xlsx 出多 sheet 表格、pptx 出逐页文本，且**不触发写权限**；
5. **系统打开**：任给一个文件点按钮，系统默认程序起来；旧 Office 三格式出文件壳而非报错；
6. **Mermaid**：让 agent 写一段 ` ```mermaid `，纸上出图；故意写错语法，**回落到代码块并说清原因**；
7. **数据 / 归档 / hex**：csv 进表格、json 出折叠树；zip 只列名不落盘；二进制出 hex；
8. **3D / 字体 / 其余**：.glb 能转能缩放；.ttf 出字形样本；epub / ipynb / mol / geojson / srt / eml 各能打开；
9. **入口 chunk 无回归**：启动速度与今日可感一致（大依赖确未进启动路径）；
10. **失败面**：任意查看器故意喂坏文件，出的是**可读错误**，不是空白、不是 JSON 兜底。

## 9. 不做（本单排除）

- **块的交互回传**（`emit` / `track` / `data`）——用户 2026-09-23 明确搁置，另行立项；
- **查看器通道化**（`ctx.viewers` 贡献通道）——B1 只做模块级注册面，通道化另立小单；
- **钉到纸 / 右侧面板两个容器**——接口留 `mode` 位，容器落地另行立项（D2）；
- **查看器内的写入口**（编辑 / 保存）——查看器只读；写走 `fs` / `office` 域工具，权限面不混淆；
- **旧 Office 的内嵌解析**——D5，只做系统打开出口；
- **远程文件查看**（URL 资源）——本单只认本地路径；
- **第二套 Office 解析真源**——一律走 `office` 域，不引 `mammoth` / `exceljs`；
- **产物域内的动态 import 懒加载**——管线明文禁止（`build-builtin-plugins.mjs:232`），重依赖一律走应用 bundle 分片（D3 修订）。

## 10. 修订依据（2026-09-23 开工前实测）

| # | 原案假设 | 实测 | 影响 |
|---|---|---|---|
| 1 | 产物内可 `import()` 懒加载大依赖 | `build-builtin-plugins.mjs:232-236` 遇动态裸 import 即 `exit(1)`；esbuild `bundle:true` 无 `splitting`（:178-201）⇒ 懒加载只会内联。今日 `dist-plugins/builtin/hologram/renderers/entry.js` = 2.0 MB | D3 修订；B3/B6/B9 的依赖改走应用 bundle |
| 2 | `ui/lsp-client.ts` 有 Monaco 装载路径可复用 | 该文件只有 `import type`（:20）；全仓无运行时 Monaco 装载（另一命中是测试桩） | B2 改 hljs 优先（主 bundle 已有 + 已主题化，`builtin-renderers.tsx:19/237`） |
| 3 | B6 落点在可热更产物内 | markdown 围栏分支在 `app/paper/builtin-renderers.tsx`（**随应用编译**，`renderer-service.tsx:13`） | B6 落点改应用侧 + 该批重建 exe |
| 4 | `shell` 域有 `start` 可借 | shell 域只有 run/output/wait/kill（`domains.ts:262-275`）；`process_cap` 8 action 无 start（`process_cap.rs:49`） | B5 新能力位判断**成立**（结论未变，依据更正） |
| 5 | B4 直接「走 `office` 域读」 | renderer 是用户路径，调不了 agent 域工具；可走 `process_cap{action:'office_exec', is_agent:false}`（`process_cap.rs:66` 动词白名单） | B4 补「走哪条口」行 |
| 6 | 门禁「vitest → build」 | 入口 chunk 守卫需 `dist/`；先例 `tests/face-deps-seal.test.ts:71` 是条件跑 = 会静默跳过 | 门禁顺序改 **build → vitest** |
| 7 | 产物内可有子目录（`viewers/`） | 构建脚本的宿主桥重定向只认同目录形态 `./<hostModule>`（`build-builtin-plugins.mjs:146`）：子目录里的 `../renderer-host` 漏过重定向 ⇒ 解析到真 `host.ts` ⇒ 把 `app/overlay.tsx` 拖进产物图并在那里炸 `jsx-runtime`（B1 首次构建即红） | 重定向放宽为「**末段**是 host 名的任意相对形态」，仍按 importer 是否在本产物目录内收口（其余 34 个产物不受影响） |

> `doc-check` 的 orphans 查在开工前实测为红（本单未被任何文档引用）——已同批登记进 `docs/plans/README.md`。

## 11. 施工记录

### B1 · 查看器注册面骨架 + 音频（2026-09-23 落地）

| 面 | 落点 |
|---|---|
| 注册面 | `plugins/builtin/renderers/viewer-registry.ts`（`ViewerDef` / `ViewerProps` / `ViewerRegistry` + 单例；重名 id、跨查看器重名 ext、空认领、`needsBytes` 缺 MIME、非正 `maxBytes` 一律**装载期 throw**） |
| 出厂查看器 | `plugins/builtin/renderers/viewers/{image,video,audio}.tsx` + `index.ts`（模块装载期注册一次）；图片/视频自 `MediaBody` **原样迁入**，MIME 表随之迁入各查看器 |
| 宿主 | `components.tsx` 的 `MediaBody` = 查表分发 + 公共壳 `.pp-viewer`（题签行 + 题名行 + 内容区）+ 降级链（未命中/无路径 → 文件壳；读取失败 → 可读错误；超 `maxBytes` → 错误 + 文件壳；渲染抛错 → `ViewerBoundary` 兜住 + 文件壳） |
| 音频 | 原生 `<audio controls>` + 诚实时长读数（metadata 未就绪 = 「时长未知」，不假装 0:00）；`maxBytes` 16 MiB |
| 测高 | `ASSET_TOKENS.viewer`（padV/labelSize/labelMarginB/audioBoxH/metaSize）+ `ASSET_DERIVED.viewer*` + `measure.ts` 的 `viewerBodyH`；`media` 组只剩 `imgMaxH`/`rowSize`（壳数字搬家，不重复） |
| 构建期 | 宿主桥重定向放宽为末段匹配（见 §10 第 7 条） |

**判据实测**：`tests/viewer-registry.test.ts`（15 例：装载期纪律 / disposer 陈旧守卫 / 出厂表齐备 / measure 镜像对拍）；
`tests/asset-media-load.test.tsx` **原四条逐字未改且全绿**（= 图片/视频迁入查看器面行为零漂移的对拍证据）+ 新增四条；
`tests/viewer-artifact-load.test.tsx`（**产物域**：磁盘通道装载 → 注册行 → 音频块真渲染，钉住别名桥与子目录查看器）；
`tests/paper-visual-decisions.test.ts` 加查看器壳段（不裸色 + 壳件走 token）。

**门禁**：`npm run build` ✓（产物自包含闸过）；`npx vitest run` **378 文件 / 3992 例全绿**；
`npx biome ci .` exit 0（改动文件 0/0）；`npm run doc-check` ✓。
**体积**：`dist-plugins/.../renderers/entry.js` 2 006 951 → **2 014 661** 字节（+7.7 KB，零新依赖）；`host-surface.baseline.json` **零漂移**（未动宿主面）。
**真机待办**（§8 第 1 项）：给一个 mp3，验流内播放器能播、能拖进度、时长读数对。

### B2 · 代码/文本查看器（hljs 路线，2026-09-23 落地）

| 面 | 落点 |
|---|---|
| 分类真源 | **新** `paper/viewer-exts.ts`（宿主层单一真源：图片/视频/音频/代码四类的扩展名表 + `viewerClassOf`）——B1 的「measure 镜像表 + 对拍」因此退休（B2 代码类一次 ~50 个扩展名，镜像成本超过收益）。两侧各自 import（同 `paper/plate-sign.ts` 先例） |
| 注册面扩展 | `ViewerDef` 增 `bytesKind?: 'data-uri' \| 'text'` + `readLines?`；装载期校验：text ⇒ `needsBytes` 必真、`readLines` 正整数、不要求 `mimes`；非 text 带 `readLines` ⇒ throw |
| 文本读取 | 宿主新 `useTextData`：`fs_cap read` + **行窗口** `limit = readLines + 1`（不整份进 IPC——大响应白屏先例）；响应无 `content` 键（图片结局）或非 JSON ⇒ 可读错误行 |
| 查看器 | `viewers/code.tsx`：hljs（`lib/common` + 补注册 10 语言）+ 行号列（CSS sticky）+ `max-height` 内部滚动 + **吸顶截断横幅** |
| 截断语义 | 宿主多读 1 行 = 「文件更长」判据；查看器显示前 2000 行 ⇒ 横幅「已截断：只显示前 2000 行（文件更长）」。**总行数在行窗口读取下不可得**（要它得整份进 IPC）——文案不假装知道 |
| 体积闸 | code 查看器 `maxBytes = 2 MiB`（按窗口**字符数**近似，文案写「约」）；超出 ⇒ 可读错误 + 文件壳，不静默截断 |
| 墨阶 | `PaperPanel.css` 的 `.hljs-*` 映射改为「`.pp-md-code` / `.pp-viewer-code` **成对选择器组**」——流内围栏码与查看器同一份配色（单一真源，测试钉成对性） |
| 桥扩展 | `rendererHooks` 增 `useMemo`（高亮记忆化；运行期本就注入 React 本体，仅补类型面） |
| 认领留白 | json/jsonl/yaml/toml/xml/csv/tsv（B7）· md（B14）· ipynb（B11）· srt/vtt/eml（B13）**本批不抢占**（扩展名路由唯一，先认领者胜）；测试钉住这些 ext 仍未被认领 |

**判据实测**：`tests/viewer-code.test.tsx`（13 例：认领覆盖 / 留白 ext / 行窗口参数 / 行号对齐 / 高亮层 / 无语言则原文 / 2001 行截断横幅 / 恰好 2000 行不误报 / 空文件 / 非文本响应 / 非 JSON 响应 / 体积闸 / 测高三档）；
`tests/viewer-registry.test.ts` 20 例（+4 条文本契约装载期纪律；镜像对拍换成「认领表 = 宿主层分类表」同源查）；
`tests/viewer-artifact-load.test.tsx` 2 例（**产物域**音频 + 代码：hljs 内联真出 span、行窗口真走 read 口）。

**门禁**：`npm run build` ✓；`npx vitest run` **379 文件 / 4013 例全绿**；`npx biome ci .` exit 0；`npm run doc-check` ✓。
**体积（诚实栏）**：产物 `renderers/entry.js` 2 014 661 → **2 441 085** 字节（**+426 KB = hljs 内联**——hljs 是轻依赖、判据见 D3；若日后启动开销有感，可改走宿主桥分片，代价是该批要重建 exe）；
应用入口 chunk 5 047.11 → **5 061.84** KB（+14.7 KB：bundle 兜底行同源，内含 5 个应用侧此前没有的 hljs 语言模块）；`host-surface.baseline.json` 零漂移。
**顺带发现（不在本批修）**：产物域六个 `host.aliased.ts` 的 `jsx/jsxs` 桥用 `createElement(type, props)` 传数组 children ⇒ React 对**静态多子元素**也报 key 警告（全仓产物域的既有噪声，非功能缺陷、非本批引入）。

**真机待办**（§8 第 2 项）：给一个 .ts 与一个 .rs，验语法高亮对、行号在、大文件截断横幅诚实。

### P1 · 轻查看器总装（2026-09-23 施工中）

**共享缝**（本包新增的接口面，均由主 Agent 落）：

| 面 | 落点 |
|---|---|
| 分类表扩档 | `paper/viewer-exts.ts` 增 8 类（table / tree / archive / font / chem / geo / subtitle / mail）——认领与测高仍是同一张表 |
| 兜底认领 | `ViewerDef.catchAll`：**至多一个**，接「谁都没认领」那一档（`resolve` 未命中 → `catchAll()`）；装载期拒绝第二个、拒绝 `needsBytes:false` |
| 字节形态第三档 | `bytesKind:'auto'`：**先文本行窗口（有界）→ 文本读失败才走 `read_base64`**。兜底查看器用——未知扩展名大多是文本，整份 base64 在 100MB 级文件上有白屏先例那类 IPC 风险；真二进制的根治（尺寸预检）挂 P2 |
| 盒高档 | `ASSET_TOKENS.viewer.boxH`（320）+ `VIEWER_BOX_CLASSES`：8 个新类共用一档上限，`viewerBodyH` 按类给值（保守 + RO 收敛） |
| 壳件 | `.pp-viewer-box`（上限盒 + 内部滚动）/ `.pp-viewer-note`（吸顶提示）/ `.pp-viewer-empty`；查看器自带样式落 `viewers/<id>.css` |
| 产物 CSS 通道 | renderers 产物开 **`face: true`** + `injectFaceArtifactCss()`——否则 `viewers/*.css` 会被抽成 `entry.css` 但**永不注入**（H2 那颗「改了没生效且静默」的雷形态）；产物已实证产出 `renderers/entry.css` |
| 审计面 | `tests/paper-token-audit.test.ts` 的 token 悬空查与裸色值查**扩到 `viewers/*.css`** |

**主 Agent 三件**：`viewers/table.tsx`（csv/tsv：RFC4180 子集 + 表头冻结 + 行数读数 + 截断横幅；**不复用 grid 组件本体**——原语自带题签行与虚拟滚动，与本壳题签行重复、且改热原语的风险高于收益；样式走同一组 `--pp-asset-grid-*` token）· `viewers/archive.tsx`（zip EOCD+中央目录 / tar 头链 / gz 头与 ISIZE；**只列目录、不解压、不落盘**；`maxBytes` 8 MiB——中央目录在包尾只能整份读；**7z 不做**，需引库 = P2 级）· `viewers/hex.tsx`（兜底：文本嗅探 ↔ hex 分页；`bytesKind:'auto'` + 256 KiB 闸）。

**并行铺六件**（子代理工作流，各自一件一文件一测试；注册行由主 Agent 统一加）：`tree`（json/jsonl/yaml/toml/xml）· `font`（ttf/otf/woff/woff2）· `subtitle`（srt/vtt）· `mail`（eml）· `chem`（mol/sdf/pdb）· `geo`（geojson/kml）。

**P1 竣工实证**（2026-09-23）：

- **查看器面**：13 个 def（12 个带认领表 + `hex` 兜底）= image / video / audio / code / table / tree / archive / font / subtitle / mail / chem / geo / hex。
- **测试**：新增/扩写 9 个测试文件（`viewer-light` 9 · `viewer-tree` 12 · `viewer-chem` 13 · `viewer-geo` 14 · `viewer-font` 8 · `viewer-subtitle` 12 · `viewer-mail` 14 · `viewer-registry` 24 · `viewer-artifact-load` 3）+ 两条既有守卫扩面（`paper-token-audit` 扫 `viewers/*.css`、`asset-media-load` 的未知档语义改写）。
- **门禁**：`npm run build` ✓（产物自包含闸过 + 产出 `renderers/entry.css`）；`npx vitest run` **386 文件 / 4102 例全绿**；`npx biome ci .` exit 0；`npm run doc-check` ✓；`host-surface.baseline.json` 零漂移（P1 不动宿主面）。
- **体积（诚实栏）**：产物 `renderers/entry.js` 2 441 085 → **2 738 518** 字节（+297 KB：`yaml` 随 tree 查看器内联一份）；`entry.css` 2 886 → **10 581**；应用入口 chunk 5 061.84 → **5 115.50** KB（+53.7 KB：bundle 兜底行同源，查看器源码随应用编译）。
- **P1 拆掉/发现的三处**：① 未知扩展名整份 `read_base64` 的 IPC 风险 → `bytesKind:'auto'`（先文本行窗口）；② renderers 产物缺 `face: true` ⇒ 查看器 CSS 会抽成 `entry.css` 却**永不注入**（H2 雷形态）→ 已开 face 通道；③ 本包自写 CSS 里 `border-bottom: <宽度> solid var(--rule-soft)` 把整条简写再拼装 = 展开后非法声明（线画不出来）⇒ 已被既有 `tests/css-rule-shorthand.test.ts` 当场抓住并改正为 `--rule-soft-ink` 颜色位。
- **如实标注的简化**（各查看器头注同款）：csv/tsv **不复用 `grid` 组件本体**（样式同 token）；归档只列目录不解压、**7z 不做**（需引库 → P2 级）、`maxBytes` 8 MiB（中央目录在包尾只能整份读）；chem **只解析 V2000**（V3000 明确报错）且无化学感知——`smiles-drawer` 实测**吃不了 molfile**（PEG SMILES 文法，喂 V2000 在标题词即断），故自绘 2D（PDB 走 x/y 投影、CONECT 一律单键）；geo 走等距圆柱投影（读数行自陈「非地图投影」，洞只画轮廓）；mail 只显示第一个 `text/plain`（其余仅 N/M 提示）、嵌套 multipart ≤3 层；subtitle 坏块计数不静默；TOML 自绘解析器的未支持特性逐行如实挂出（不静默塞进上一张表）；font 在无 `document.fonts` 的环境只出文件信息 + 提示，不拿回退字体冒充字形。
