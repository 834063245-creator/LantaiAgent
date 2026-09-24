# 渲染面整合归家设计（批 8：纸面块渲染器 + 重查看器白名单 + 类型环）

> 状态：**已落（2026-09-25，8a/8b/8c/8d 四笔各自门禁全绿；落地数字见账本 §6.4 末段）**；账本
> [`plugin-extraction-inventory.md`](plugin-extraction-inventory.md) §6.4 是它的侦察记录（含逐条 file:line）。
> 依据裁定：§4-1 **A**（实现搬进新产物 `paper-renderers/`，该产物标**不可禁用**）；
> §4-2 自裁条（重依赖留 bundle 的例外写进 `docs/plugins/README.md` §3）；
> §4-8 自裁条（`viewer-exts` + 5 个 `paper/*` 件随 §4-1 联动重判 —— 本件即那次重判）。

## 1. 范围（账本登记项 + 实测行数）

| 账本处 | 项 | 行数 | 去向 |
|---|---|---|---|
| §2.4 | 会话流块渲染器 11 kind + `'*'` 兜底 `app/paper/builtin-renderers.tsx` | 1,020 | 新产物 `paper-renderers/` |
| §2.4 | mermaid 围栏渲染器 `app/paper/mermaid-block.tsx` + css | 312 + 48 | 认领逻辑随包；**组件本体留应用 bundle**（硬点 2） |
| §2.4 | ipynb 查看器 `app/paper/viewers/ipynb.tsx` + css | 516 + 148 | `renderers/` 产物内联（撤 `heavy`） |
| §2.4 | markdown 独立查看器 `app/paper/viewers/markdown-doc.tsx` + css | 263 + 147 | 同上 |
| §2.4 | 查看器装载面 `app/paper/viewers/index.ts` | 46 | 白名单收窄到 pdf / model3d |
| §4-8 | `paper/markdown.ts` · `tool-text.ts` · `marks.ts` | 613 + 704 + 45 | 随包（消费者只有渲染面，实测） |
| §4-8 | `paper/fold.ts` · `translate.ts` | 223 + 646 | **留内核**（paper-shell 产物经 faceDeps 桥用） |
| §4-2 | 类型环：5 个内核查看器文件引产物 `viewer-registry` | — | 类型契约上收内核 |

## 2. 三条设计判据（本批的取舍留痕）

1. **产物自包含优先于代码复用**：产物域禁静态/动态裸 import（构建闸），且产物之间**不得互相相对
   import**（实测：`plugins/builtin` 下零跨包 import）。跨产物共享一律走「**内核登记表 + 产物登记实现**」
   接缝（批 6/7 既定模式），不发明第三条路。
2. **重依赖留应用 bundle，但只留组件本体**：mermaid / pdfjs / three 这类真重依赖由 vite 分片；
   产物侧只保留「认领 + 降级 + 取件」逻辑。取件面 = faceDeps 桥（既有 `rendererLoadViewer` 先例）。
3. **不可禁用 = 机制而非约定**：新产物在名册标 `required: true` ⇒ 三处同时生效——① 设置页不出禁用开关
   （显示「常驻 · 不可禁用」）；② loader 两条禁用路径（plugin-prefs / plugins.json）对该产物直接跳过；
   ③ 启动期装配断层对账不用它为「被禁用」开脱（缺它 = error 记录）。

## 3. 子批切分（每批独立可交付、门禁全绿再下一批）

### 8a 类型环解结（白名单前置，零行为变更）

- 新内核契约 `src/paper/viewer-contract.ts`：把 `ViewerBytes` / `ViewerMode` / `ViewerProps` /
  `ViewerDef` / `normalizeExt` 从产物 `renderers/viewer-registry.ts` **原样上收**（纯类型 + 一个纯函数）。
- 产物 `viewer-registry.ts` 改为 `from '../../../../paper/viewer-contract'` 取用并**原样 re-export**
  （产物内部 20 个 viewer 的 import 面零改动）；`ViewerRegistry` 类与单例 `viewerRegistry` 留产物。
- 内核 5 处改指契约面：`app/paper/viewers/{index,ipynb,markdown-doc,pdf,model3d}.tsx`
  （`model3d.tsx:69` 的**值** import `normalizeExt` 一并改指）。
- 新守卫 `tests/kernel-product-import-guard.test.ts`：内核（`src/**` 去掉 `plugins/builtin/**`，
  白名单 = 三条 `first-party-*.ts` 通道表 + `host-modules.ts`）**不得 import 产物源码**；
  当前该守卫在 viewer 面为红 ⇒ 8a 修好它才绿（把病灶变成机器判据）。

### 8b 纸面块渲染器随包 + 新产物 `paper-renderers`（不可禁用）

- `git mv`：`app/paper/builtin-renderers.tsx` → `plugins/builtin/paper-renderers/renderers.tsx`；
  `paper/markdown.ts` · `paper/tool-text.ts` · `paper/marks.ts` → 同包（`git mv` 保历史）。
- 包内 `host.ts` / `host.aliased.ts` 桥：`memo` / `Fragment`（react 面扩桥）· `katex` ·
  `Overlay` · `useShellStore` · `previewUrlFor` / `readAttachmentBase64` · `MermaidBlock`（硬点 2）·
  `fold` / `translate`（留内核的两件）· 契约面类型（`BlockRendererProps` / `BlockRendererContribution` /
  `PlanApprovalResponse` / `ChatImageRef` / `MdBlock` 一族）。
- 注册点从内核移到产物 `index.tsx` 的 apply（`inject: ['renderers']`，沿用 `renderers/index.tsx` 的
  **双走查前缀**：bundle 域 `builtin/<kind>`、产物域 `plugin/hologram/paper-renderers/<kind>`）；
  内核 `rendererServicePlugin` 回归**纯通道**（只 `new RenderersService(ctx)`，零出厂行）。
- `required: true` 机制（判据 3 的三处 + 名册/清单/守卫计数同步）。
- katex CSS 归属：留在壳首帧白名单（`main.ts:25`），产物侧只内联 katex JS（记进 §4-2 文档契约）。

### 8c ipynb / markdown-doc 撤 heavy（内联进 `renderers` 产物）

- 新内核接缝 `src/paper/markdown-body-seam.ts`：`registerMarkdownBody` / `activeMarkdownBody`
  （**内核登记表 + 产物登记实现**，判据 1）；`paper-renderers` 在 apply 期登记 `MarkdownBody`。
- `renderers` 产物经自身 host 桥取该访问器（faceDeps 加键），两个查看器本体 + CSS 从
  `app/paper/viewers/` 迁进 `plugins/builtin/renderers/viewers/`（替换同名 stub，`heavy` 声明删除）；
  hljs 在 `renderers` 包内收成一份（`viewers/hljs.ts`），应用 bundle 的 hljs 归零（硬点 4）。
- `app/paper/viewers/` 只剩 `pdf.tsx` + `model3d.tsx`（+ 各自 css）⇒
  `tests/viewer-registry.test.ts:237-246` 的双向全等自动对齐。

### 8d 文档契约化 + 收尾

- `docs/plugins/README.md` §3：写「重依赖才留应用 bundle」的例外与判据（§4-2 自裁条兑现）。
- 账本 §2.4 / §2.5 / §5 / §6 更新；faceDeps 指纹重生成；真机 exe 重建 + CDP（新产物 entry.js 在场、
  键数对拍、`required` 产物在设置页无禁用开关）。

## 4. 每批验收（与批 6/7 同规格）

`vitest` 全量 · `build` + `build:builtin-plugins`（产物自包含）· `biome ci` 0/0 ·
`verify:convergence` 双轨（**基线零改动是硬指标**——渲染面不进工具表序）· `doc-sync` + `doc-check` ·
faceDeps 指纹重生成 · 真机 exe 重建 + CDP。

## 5. 已知风险与对策

| 风险 | 对策 |
|---|---|
| `paper-visual-decisions.test.ts:44-49` 拼接两文件源码 | 8b 同 commit 改常量（M2 迁移先例照抄） |
| `paper-v3b.test.ts` 钉 11 kind 精确序 + `builtin/` 前缀 | 双走查前缀保证测试域仍是 `builtin/<kind>`；序随数组原样搬 |
| 产物 CSS 覆盖守卫（`product-source-not-in-bundle` ②③） | 迁 CSS 时同批改 `main.ts` 首帧白名单与 paper-shell 的类名归属，逐条跑该守卫 |
| `renderer-host` 桥缺 `memo` / `Fragment` / `katex` | 8b 扩桥并同步 `host.aliased`（face.json 指纹随批重生成） |
| 产物体积（hljs 426 KB 先例） | 8c 后逐产物记字节数进账本；体积暴涨即按「重依赖例外」重判 |
| scaffold 环（`components ⇄ viewers/index` TDZ 先例） | 新接缝的登记一律在 **apply 期**，不在模块顶层 |
