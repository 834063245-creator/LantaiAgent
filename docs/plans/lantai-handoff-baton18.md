# 兰台交接棒 18 —— 在册小账收尾：D2 IPC 收窄 / C5 目录失败面 / D5 组件测试

> 2026-08-26 夜会话（续第 17 棒）· 下一窗口从本文件起读
> 上棒：lantai-handoff-baton17.md（第 17 棒：联合体检方案甲施工落账）
> 范围：只收 baton17 §2.2 三件代码面在册小账；实机验收仍留给用户，不在本次范围。

## 0. 本棒干了什么

收掉联合体检报告（`composer-provider-audit.md`）修复落账里剩的三件代码面小账：

1. **D2 热切换 IPC 风暴 ✅**（`src/workspace.ts`）：`applyAgentConfig` 顶部统一
   `loadSettingsWithSecrets()`（每个 model-switched/settings-saved 信号逐个 provider
   `credential_get`，切一次模型 = N 次 IPC，只为算诊断 keyLen）→ 改 `loadSettings()`
   （providers/activeProvider/model 都在 localStorage，同步读零 IPC）+ 诊断 Key 状态走
   `resolveApiKey`（`provider/credentials.ts` 内存缓存，命中零 IPC）。request 期真实
   凭据仍由 live provider 按名现解析，fail-loud 语义不变。
2. **C5 目录无失败面 ✅**：根因 = `fetchJsonWithTimeout` 对非 ok/网络/超时一律返回
   null → `fetchModels` 永不 reject，失败被静默当成「无模型」（`.catch(() => {})`
   永不触发，用户完全无感）。修复：
   - openai/anthropic `fetchModels` 失败上抛（不再伪装空数组）；
   - catalog 加 per-provider 失败面：`recordDynamicFetchResult(ok, err)` /
     `getDynamicFetchFailure(name)`（成功清标记；键控进程级状态，同 `_dynamicModels`
     归属，CONVENTIONS §1.10 第 3 类）；
   - 两个调用面（workspace 后台自动拉取 / ProviderPage 手动刷新）都记结果；
   - compact 选择器分组头「目录获取失败」标注（`.ms-group-fail` 虚线徽标，区别于
     B3 无 Key 实线）；
   - last-good 保留：已合并动态模型不因失败清掉（对应 DSH groups 面）。
3. **D5 组件级测试缺口 ✅**：新增 `tests/composer-dock-keyboard.test.tsx`（5 用例）——
   ↑↓ 历史浏览（进入存草稿/回退/前进/越过恢复草稿/手输退出浏览/空历史不越界）+ 斜杠
   面板键盘导航（↑↓ 高亮/Enter 执行/Esc 关去触发词）。

落账：audit 修复落账三行状态更新 + 追加「在册小账收尾」节 + 本 baton + plans/README 现状。

## 0.1 本棒验证记录

- 全量 vitest：**181 文件 1771 passed / 4 skipped / 0 failed**（基线 1762 + 9：
  composer-dock-keyboard 新增 5 + model-selector-compact +1 + provider-catalog +3）。
- `npm run build`（tsc+vite）✓；`npm run verify:convergence`（`$env:NODE_ENV='test'`）
  exit 0；`npx biome ci .` 0 error（改动文件 `biome check --write` 后归零）。
- provider-hotswap 静态断言（applyAgentConfig 会话级/全局面）仍绿——D2 改动未破坏
  方案甲热切换语义。

## 1. 本机环境坑

沿袭 baton17 §1（1-15 全部有效），本棒无新增。

## 2. 剩余工作（工作序）

1. **实机验收（最优先，用户跑）**：体检验收七项（composer-provider-audit.md 修复落账节
   「本次修复的实机验收清单」）+ Stage-4 返工清单 P0-P4 + Stage-3 四项 + 分层四项 +
   session-unify 四项。**本次在册小账的实机感受点**：无 Key/网络坏掉的 provider 在
   创作坞模型下拉分组头应看到「目录获取失败」（虚线徽标），同时静态目录 + 上次成功
   拉到的动态模型仍在。
2. **Stage-5 草案待审**（stage-5.md）：开工依赖 = 返工清单 + 体检验收实机勾销。
3. **挂起项不变**：C12 dsh-compat（等 DSH 外部信号）；v11 分析引擎 plan（用户拍板）；
   repo 改名 GitHub 侧（用户操作）。

## 3. C5 语义要点（接手必读）

- **失败面三件套**：`recordDynamicFetchResult(name, ok, err?)` 写、`getDynamicFetchFailure`
  （undefined = 无失败）读、compact 分组头 `.ms-group-fail` 显示。**成功即清标记**——
  不要保留旧失败，用户修好网络后重拉即恢复。
- **last-good 不因失败清**：`mergeDynamicModels` 只在成功路径调用；失败只记失败面，
  不清 `_dynamicModels`。静态目录 + last-good 是兜底，失败标注是「目录动态部分不可
  信」的提示，不是「模型不可用」。
- **fetchModels 契约变更**：传输失败上抛（`types.ts` 注释已更新）；成功但端点无 data
  = 返回 `[]`（不是失败）。`live.ts` 无 Key → `[]`（不算失败，B3 无 Key 标注单独管）。
- **测试纪律**：改 catalog/ModelSelector/ProviderPage 失败面 → 必跑 provider-catalog.test
  （C5 三用例）、model-selector-compact.test（C5 标注用例）。
