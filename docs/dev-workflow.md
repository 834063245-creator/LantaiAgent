# 开发热更工作流（dev 模式）

> 制定 2026-08-30 · 落地 first-party-hot-reload-plan P0
> 增补四（2026-08-31）：dev 模式对用户不可用（环境所限）——生产包热重载
> 为唯一热更路径，见文末「生产包热重载（增补四后的主路径）」。
> 一句话：改前端代码 → 保存 → 秒级看到效果，无需重新打包。

## 为什么之前「改代码要重打包」

兰台是 Tauri 桌面应用：生产包把前端编译进安装产物，改代码必须重新
`cargo tauri build`（分钟级）。但项目一直具备 Vite dev server 的 HMR
（热模块替换）能力——`tauri.conf.json` 配了 `devUrl: http://127.0.0.1:1420`
+ `beforeDevCommand: cargo build -p hologram-engine && npm run dev`（引擎
增量构建先行——壳不依赖引擎 crate，缺引擎二进制时应用瘫，2026-09-09
事故立法）。只是日常跑生产包，感受不到。

## 怎么进 dev 模式

```
dev.cmd
```

一条命令（Windows，Git Bash / cmd / PowerShell 均可）：
1. 先增量构建引擎二进制（`target/debug/`；已新鲜时秒级）；
2. 再自动起 Vite dev server（HMR 就绪）；
3. 再编译并启动 Rust 壳 + 打开开发窗口。

> 首次冷启动 Rust 编译要几分钟（与 build 相同）；编译完成后窗口即开。
> 窗口标题栏会连接到 `127.0.0.1:1420` 的 dev server。

## 生效语义

| 改动 | 生效方式 | 速度 |
|---|---|---|
| 前端代码（组件/逻辑，`src-ui/src/**`；**dev 模式**） | Vite：`.ts/.tsx` **必然整页 reload**（本仓零 `import.meta.hot` accept 边界、未装 `@vitejs/plugin-react` ⇒ 没有模块级热替换；不是偶发 fallback）；`.css` 走 css-update 换 `<link>`，不 reload | 秒级（丢页面内状态） |
| 插件源码（**生产包路径**，日常主路径） | 见文末「生产包热更」：`watch:builtin-plugins` 一条命令 → 保存即自动重建 + 镜像 + 应用内自动重载 | 秒级 |
| Rust 壳代码（`src-tauri/**`） | `cargo tauri dev` 自动重编译重启 | 分钟级 |
| 引擎代码（`engine/**`） | 需重启 dev 进程（关闭窗口后重跑 `dev.cmd`） | 分钟级 |
| 组合配置（`~/.lantai/composition/roster.patch.yml`） | 1-2 秒自动热加载（composition_watcher） | 秒级 |

## 与生产包的差异（如实声明）

- **前端始终是 dev 构建**：模块未压缩、未做 tree-shaking 的最终形态。
  性能和体积不代表生产。
- **前端代码路径不同**：开发窗口从 dev server 拉 HTML/JS；生产包从
  `dist/` 读取。个别环境相关行为（如资源路径）可能不同。
- **发版前必须重跑生产构建**：`build.cmd`（内部 = `cargo tauri build`，
  会先跑完整前端构建 + tsc 类型检查 + 引擎 release 二进制构建）。dev 模式通过 ≠ 生产可发布。

## 常见问题

- **改了 React 组件但窗口没反应**：dev 下 `.ts/.tsx` 改动是**整页刷新**（本仓没有
  HMR accept 边界，也没有 Fast Refresh 插件），页面会重载一次并重跑整条 boot 链；
  若完全没变化，检查终端里 Vite 输出有没有报错（红字）。
- **Rust 改动自动重启后窗口丢失**：正常——Rust 进程重启，窗口重建，
  前端状态（聊天记录等）是持久化的，重进即可。
- **端口被占**：`strictPort: true`——1420 被别的进程占用时 Vite 直接
  报错退出。关掉占用程序后重跑。
- **看错误日志**：Vite 错误在跑 `dev.cmd` 的终端里；Rust 日志在终端；
  应用内错误看状态栏日志（展开可查）。

## 验收清单

- [ ] `dev.cmd` 一条命令进开发窗口（无需手工起 Vite）
- [ ] 改 `src-ui/src/app/**` 或 `src-ui/src/composition/**` 等前端文件，
      保存后窗口内行为即时更新，无重编译
- [ ] 生产包可用 `build.cmd` 正常发布（dev 不替代发布门禁）

## 生产包热更（增补四后的主路径；2026-09-20 起自动）

dev 模式不可用时的迭代环——`kind='feature'` 的**全部出厂产物**（UI 面 canvas-nav / paper-shell /
settings-domain / compose-dock 等、工具域、prompt/capability 段贡献、供应商 + agent-loop-service +
资产渲染器；**计数与逐条清单见 `docs/facts.generated.md` + 名册 `plugins/builtin-roster.json`**）都是
**内置插件产物**。链是**三段**，2026-09-17 / 09-20 两次实机「热重载没生效」（landmine H1 / H4）
都是中间某段被手工漏掉且**静默**；现在三段里两段自动、一段一条命令常驻：

```
npm run --prefix src-ui watch:builtin-plugins     # ① 起一次，常驻（保存即重建 + 镜像）
…改 src-ui/src/plugins/builtin/<dir>/**  并保存…   # ② 自动：重建产物 + 逐文件 SHA256 镜像进 exe 资源根
                                                   # ③ 自动：应用侧 ~1s 内重载该插件（状态栏出回执）
```

> **实机实测（2026-09-20，真机 CDP 探针）**：给 `canvas-nav/session-sidebar.css` 加一条
> `:root{--lantai-hmr-probe:…}` 规则保存 → **1.35s 后**该规则已在运行中的窗口里生效
> （savedAt `06:58:13.696Z` → detectedAt `06:58:15.046Z`），同时通道收到
> `canvas-nav/entry.js?v=…` 的新模块请求、该产品 CSS link 换新版本、其余四个面纹丝不动。
> 删掉该规则保存 → 同样自动回落。**全程零点击、零重启。**

| 环节 | 谁做 | 曾经的断点（已拆） |
|---|---|---|
| 源码 → 产物 | `build-builtin-plugins.mjs`（esbuild，秒级出到 `src-ui/dist-plugins/builtin/hologram/<dir>/`） | — |
| 产物 → **exe 侧资源根** `target/<profile>/_up_/src-ui/dist-plugins/` | 同一脚本**自动镜像**（逐文件 SHA256；产物侧多余文件一并清除） | **H1**：运行中的 exe 只认资源根——只跑构建不镜像 = 重载旧文件，**无报错、无回执**（实机两次栽在这里） |
| 资源根 → 运行中的插件 | 应用侧 `plugins/product-watch.ts` 盯产物根的 `_rev.json`（构建期写的内容指纹表）→ 变更即 `activateExternalPlugin` | **H4**：入口 import URL 曾无版本号 ⇒ ES module 模块图回旧模块（改 TS 必须重启才生效；CSS 那条 H3 已带版本号 ⇒ 症状是「经常」不生效） |

细节与例外：

- **watch 常驻时不要跑全量构建**：`npm run build` / `cargo tauri build` 会清空产物根，
  与常驻 watch 争同一棵树（实测 `rmSync ENOTEMPTY` 直接把 `cargo tauri build` 的
  beforeBuildCommand 炸掉，报错与根因毫无关系）。脚本已加互斥闸：检测到活着的
  watch 进程即**具名拒绝**并提示先 Ctrl+C 停它（崩溃残留的死锁自动忽略清除）。
- **手工兜底照旧可用**：`npm run --prefix src-ui build:builtin-plugins`（一次性构建 + 镜像）；
  应用内 设置 → 插件 → 对应插件「重新加载」（与自动重载同一条 `activateExternalPlugin` 路径）。
- **对拍/体检**：`npm run --prefix src-ui check:builtin-plugins`——逐文件比构建根 ↔ 资源根，
  有漂移即 exit 1（**不许靠时间戳判断**）。
- **资源根从哪来**：`cargo tauri build` / `cargo tauri dev` 按 `tauri.conf.json` 的 resources
  映射把 `../src-ui/dist-plugins` 拷到 `target/<profile>/_up_/src-ui/dist-plugins/`（两条路等价）；
  从未跑过它们时没有资源根 → 镜像跳过并告警。装到 Program Files 的兰台另有自己的资源根
  （同步不到，改产物请用仓库里的 exe）。
- **`--no-sync`** 只构建不镜像（罕见场合：先攒一批再一起镜像）。
- **自动重载的边界**：用户**禁用**的插件不自动重载（`plugin-prefs` 是唯一权威）；窗口隐藏时不轮询；
  `_rev.json` 缺失（旧产物包 / 第三方部署）⇒ 自动重载退化停用（一条日志），手工「重新加载」照常；
  **dev 源码域不参与**（dev 下出厂产物走源码路径，从产物通道重载会与源码域贡献撞 id ⇒ 装载器具名拒绝）。
  在跑的 Agent 回合不会被重载打断——工具/段贡献是**装配期快照**，重载只影响下一次装配。
- **生效时机**：面板/命令即时；工具/prompt/capability 贡献在**下次 Agent 装配**生效（已开的卷是
  装配期快照，不被中断——特性非缺陷）。
- **产物形态**：工具域/段贡献是薄重导出产物（插件对象真源在各 `builtin/index.ts`），UI 五面是完整
  源码产物——两者都改完即热更。兜底：产物缺失/损坏 → 装载失败可见（设置面板显示错误详情）；
  重启应用同样生效（boot 时按装载序装载）。
- **加/退役内置插件 = 只改 `src-ui/src/plugins/builtin-roster.json` 一处**（2026-09-06 单一真源）：
  build 规格 / factory-products 装载序 / first-party-manifest feature 段 / 产物 manifest 全部从名册
  派生；Rust 资产通道已无白名单（用户根缺失无条件回退内置根）。守卫测试 `builtin-roster.test.ts`
  钉死名册 ↔ 磁盘目录 / 源码对象一致性。

### 仍然必须重建 exe 的三条边界（landmine H2/H3 残留，别当没修）

1. **删 CSS 规则不算数**：首帧那份应用 CSS（壳 bundle）里留着插件 CSS 的旧拷贝，产物 link 只能
   **覆盖**不能抹除 ⇒ 改值/加规则即刻生效，**删掉**一条规则仍要重建 exe。绕法：把规则改成中性
   声明（如 `display: revert`）而不是删。
2. **tokens / 壳 CSS**（`src-ui/src/app/**` 的 `tokens.css`、`foundation.css`…）属壳域。
3. **`src-ui/src/plugins/loader.ts` 等壳域文件**同理（H3 的 CSS 版本号、H4 的 JS 版本号、
   自动重载的接线都在壳域）——改它们的那一批必须重建一次 exe。

> 一句话记忆：**改插件（JS 或 CSS）= `watch:builtin-plugins` 常驻 + 保存，秒级自动生效；
> 删规则、碰 tokens/壳 CSS、碰壳域文件 = `cargo tauri build --no-bundle`**
> （先关掉正在跑的兰台——exe 被占用会 os error 32）。

## 发版（2026-09-26 起：本机构建 + 本机分发）

权威流程与硬约束写在 `CLAUDE.md`「发版」一节（命令直接抄那里）。本节的职责是**记录为什么是这样**，以及出问题时的对照表。

### 为什么国内分发改成本机

2026-09-26 实测得出结论：**美国 runner → 国内主机传大文件不可用**。

| 观察 | 数据 |
|---|---|
| GitHub 的美国 runner → GitCode 传 161MB | **29 KB/s**，四次重试完全一致（curl 速度闸在 121s 处主动中止，只送出 3.6MB） |
| 同类项目（openhanako）7 月从同一 runner 传 458MB | 成功（单文件超时只给 10 分钟）⇒ 说明**平台行为已变**，不是我们配置错 |
| 本机（国内）→ 同一批服务 | 国内链路，几 MB/s |
| 本机直连 GitHub 的 release 资产域 | HTTP 000（SSL 失败）⇒ 「下载到本地再传」也不通 |

⇒ 结论：**产物只在一个地方生成（本机，那里也有私钥），也从一个地方发出（本机）**，跨境这一跳彻底不存在。
CI 保留为 GitHub 侧的正式发布（海外用户 + 备份），用同一把新密钥签名，两边可以并存。

### 每步的期望输出（判断成功与否）

**① 提版本号** → 打印改动的 9 个文件；建议随后 `git add -A && git commit -m "chore(release): …"`。

**② 带签名构建** → 结尾打印 `Finished 2 bundles at:` 并列出 msi / nsis 路径。
顺手确认签名产物存在：`dir target\release\bundle\nsis\*.sig`（必须有 `<安装包名>.sig`）。

**③ 发版脚本** → 依次打印：检查产物 → 创建/复用 GitCode 发行版 → 上传（含**均速**）→ 公开可达 + 首 1KB 逐字节一致 → 生成清单 → 推 Gitee → 轮询等 CDN（Gitee raw 有 60s 缓存，脚本最多等 5 分钟）→ 完成。
**看「均速」那一行**：几 MB/s 是正常的；如果只有几十 KB/s，说明本机链路也有问题（贴出来）。

### 报错对照表

| 现象 | 原因 / 处理 |
|---|---|
| `缺少环境变量 GITCODE_ACCESS_TOKEN` | 令牌只在**设置它的那个 shell** 有效，换窗口要重设（或设成用户级环境变量） |
| `NSIS 安装包 没有配套的 .sig` | 用了 `build.cmd`。按报错里给的正确命令重来 |
| `GitCode … → HTTP 401` | 令牌无效或权限不够（要勾**发行版写**） |
| `git push` 失败 | Gitee SSH 掉了：`ssh -T git@gitee.com` 验证 |
| `清单 5 分钟内未生效` | Gitee raw 的 CDN 慢。**附件已经传好了**，直接重跑第 ③ 步（幂等，会跳过已上传的） |
| 想要 MSI 用户也能更新 | 第 ③ 步加 `--with-msi`（多传约 160MB）；默认只发 NSIS，MSI 装的客户端会回落到 `windows-x86_64` 条目 |

### 两条不能违反的顺序纪律（脚本已实现，改脚本时别破坏）

1. **清单最后才可见**：Tauri 的 updater 在第一个「成功解析」的端点就 `break`，清单先于安装包可见 = 客户端拿到指针却下不到包。
2. **清单缺失时必须保持 404**：故意放一份 `version: 0.0.0` 的占位清单会**遮住** GitHub 兜底——用户静默地「永远已是最新」。宁可 404（updater 会继续试下一个端点）。

### 发完之后

- **首次换密钥那一版**（v1.0.4）必须让用户**手动重装一次**（他们客户端里嵌的是旧公钥），之后自动更新才恢复。
- 自检地址：`https://gitee.com/jingwen-bing/lantai-agent/raw/updater-manifest/latest.json`（浏览器直接打开，能看到 JSON 即生效；60 秒内）。