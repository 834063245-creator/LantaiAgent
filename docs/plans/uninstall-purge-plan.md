# 卸载残留清理（uninstall purge）

> 立项 2026-09-26（用户报）· **代码已落地并本机 E2E 通过（2026-09-26）；余真机勾选验收**
> 真源：`src-tauri/src/purge.rs`（目录清单唯一一份）· 挂接点：`src-tauri/nsis/installer-hooks.nsh`
> Windows 自 2026-09-26 起**只发 NSIS**（用户拍板，见下「MSI 侧的真相」）

## 要裁什么

用户报：**卸载之后没卸干净，残留 `.lantai` / `.hologram` 文件夹**，希望卸载时能有一个勾选项、
勾了就完全卸载不留残余。

实测残留（本机，2026-09-26）：

| 残留物 | 体量 | 谁写的 | 当时的卸载器管不管 |
|---|---|---|---|
| `%USERPROFILE%\.lantai` | 64 MB | 兰台用户级数据（plugins / plugins-data / skills / global_memory / providers.yml / mcp.json / 老会话备份 / `tools/officecli`） | **不管** |
| `%USERPROFILE%\.hologram` | 142 MB | 2026-08-23 改名**之前**的老位（引擎二进制 51 MB + 语法仓库 + 老 composition/plugins） | **不管** |
| `%LOCALAPPDATA%\com.lantai.app` | 383 MB | WebView2 `EBWebView` + `credentials.enc`（DPAPI 里的 API Key） | NSIS 勾选框管（MSI 谁都没管） |
| `%APPDATA%\com.lantai.app` | 小 | 窗口状态 | 同上 |
| `%LOCALAPPDATA%\com.hologram.app` | 137 MB | 更早 identifier 的遗留 | **不管** |

关键事实：**NSIS 上游模板本来就带勾选框**——`target/release/nsis/x64/installer.nsi` 的
`un.ConfirmShow` 画的 `$(deleteAppData)` 复选框（缺省不勾），勾选后模板自己只删
`$APPDATA\${BUNDLEID}` 与 `$LOCALAPPDATA\${BUNDLEID}`。**用户抱怨的正是它没覆盖的部分**，
而模板另留了 `NSIS_HOOK_PREUNINSTALL` / `POSTUNINSTALL` 两个官方挂接点。

## 裁定（Agent 自裁，§0.5）

1. **目录清单只有一份，放在应用里**（`src-tauri/src/purge.rs`）：安装器只负责「何时问、何时调」，
   一行都不复述路径。以后新增用户级数据目录只改 Rust，清理自动跟上。
2. **NSIS 走上游勾选框，不 vendor 模板**：`nsis/installer-hooks.nsh` 在
   `$DeleteAppDataCheckboxState = 1 且 $UpdateMode <> 1` 时调 `lantai.exe --purge-user-data --yes`
   （勾选框即用户同意，不再二次询问）。
3. **另留显式同意开关 `/PURGE-DATA`**：静默卸载（`/S`）下勾选框页根本不出现，脚本化完全卸载走
   `uninstall.exe /S /PURGE-DATA`（也是本批 E2E 的抓手）。同一钩子的 POSTUNINSTALL 顺带补齐
   上游只在「勾选分支」里做的注册表收尾（`Software\lantai\兰台` 的 InstallLocation 等），
   否则脚本路径会留下一个指回已删目录的键。
4. **工作区里的 `{项目}/.lantai` 与 `{项目}/.hologram` 不动**——那是用户自己目录里的数据，
   卸载软件不该碰用户的项目文件夹。清理只覆盖用户级（主目录 + AppData）。
5. **`--purge-user-data` 只走安装器路径**：`main()` 在任何初始化之前分流，命中即清理并退出
   （进入初始化会边删边写，用户看到的还是「没卸干净」）。不给 UI 暴露「一键清空数据」。
6. **MSI 渠道停发**（用户 2026-09-26 拍板「只发 NSIS」，见下）：`tauri.windows.conf.json` 写
   `bundle.targets: ["nsis"]`，base 配置里的 `wix` 段与 `fragmentPaths` 同批删除
   （`wix/cleanup.wxs` 已删），反向守卫测试钉住「别再加回来」。

## 默认值与安全

- 勾选框**缺省不勾**；静默/被动卸载（`/S`、`/P`）页面不出现 ⇒ 勾选态恒为 0 ⇒
  **应用内自动更新的那条卸载路径永不删数据**（钩子里另有 `$UpdateMode` 双保险）。
- `Target::new` 的名字闸：只接受绝对路径 + 名为 `.lantai` / `.hologram` / `com.*`。
  即便根算错也删不到 `C:\Windows`、`C:\Users`（单测钉住，含 `C:\` 与相对路径）。
- 只读位：老 `.hologram/grammars/repos/*/.git/objects/**` 与 WebView2 的 `EBWebView` 带只读属性，
  直接 `remove_dir_all` 会 Access denied 留整棵子树；删不动时清只读位再删一次。
- **失败必须可见**：弹框逐条列残留 + `%TEMP%\lantai-uninstall-purge.log`（NDJSON 逐目录一行）
  + NSIS 细节栏退出码（0 干净 / 2 有残留）。

## MSI 侧的真相（2026-09-26 实测，改写了本批范围）

**`wix/cleanup.wxs` 那个 fragment 从第一版起就没进过任何一版 MSI。** 反编译三版已发布的
安装包（`兰台_1.0.0` / `1.0.3` / `1.0.4`，`dark.exe`）后，CustomAction 表里只有 `main.wxs` 自带的
四条，既没有本仓 fragment 的 `CleanupUserDataPrompt`、`InstallExecuteSequence` 里也没有对应行
⇒ **MSI 用户此前的卸载没有任何清理动作**（连 `%LOCALAPPDATA%\com.lantai.app` 都不删，
那段 base64 PowerShell 弹窗一次也没弹过）。

根因不是「Tauri 少传了 wixobj」：

- 手工把 `main.wixobj + cleanup.wixobj` 一起交给 `light.exe` 重链 → CA 照样不入表；
- 最小复现（Product + Fragment 两个文件，CA 与序列都写在 Fragment 里）→ MSI 里只有 File 行、
  没有 CustomAction 行。

**结论：WiX v3 的 sequence / CustomAction 是 Product 级元素，写在 Fragment 里会被 light 丢掉**
（与上游 issue [tauri#5970](https://github.com/tauri-apps/tauri/issues/5970) 同源，2023 开、至今 open）。
Tauri 文档里 fragment 能带的只有被 `componentRefs` 之类引用到的
`ComponentGroup` / `Component` / `Feature` / `Merge`；MSI 的组件机制又删不了「内容不可预知的
数据目录」（`RemoveFile` 不递归）。**所以 MSI 侧唯一真路 = 整份 `wix.template`。**

**本批裁定：不 vendor 那份模板**（与 tauri-cli 版本强耦合的生成式化石，升一次 CLI 就要人肉对账，
漂了没有守护能拦），改为如实写边界 + 删掉假通路。

**用户裁定（2026-09-26）＝「只发 NSIS，去掉 MSI」**（三选一里选它：① 只发 NSIS ② 保留 MSI 现状 +
手动命令 ③ vendor 模板）。落地 = `src-tauri/tauri.windows.conf.json` 的 `bundle.targets: ["nsis"]`
（放平台文件里，避免波及 Linux/macOS 的桌面构建）+ base 配置的 `wix` 段删除。
**对旧 MSI 用户的后果（如实记）**：他们下一次「应用内更新」或手动装 `.exe` 时，NSIS 安装器会
自己接管旧 WiX 安装（模板里的 `wix_loop` 会先跑 MSI 的卸载器）——也就是说迁移会自然发生，
只是**旧 MSI 用户在更新前**若想彻底清理，仍需手跑一次 `lantai.exe --purge-user-data`。

<details>
<summary>若日后要做 MSI 同款：配方（待用户裁定后再动手）</summary>

1. 取该 tauri-cli 版本对应的模板 `crates/tauri-cli/src/bundle/windows/msi/main.wxs`
   （或从本机 `target/release/wix/x64/main.wxs` 反向确认变量名）；
2. 放进 `src-tauri/wix/main.wxs`，在 `<Product>` 内追加：

```xml
<CustomAction Id="PurgeUserData" Impersonate="yes" Execute="deferred" Return="ignore"
              Directory="INSTALLDIR" ExeCommand='"[INSTALLDIR]lantai.exe" --purge-user-data' />
<InstallExecuteSequence>
  <Custom Action="PurgeUserData" Before="RemoveFiles"><![CDATA[REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND UILevel >= 4]]></Custom>
</InstallExecuteSequence>
```

3. `bundle.windows.wix.template = "wix/main.wxs"`，并在 `tauri.conf.json` 头部注明模板的上游版本；
   升 tauri-cli 时必须重新对账（这是本方案的主要代价）。

</details>

## 验证

| 面 | 怎么做 | 结果 |
|---|---|---|
| 单测 | `cargo test -p lantai --bin lantai`：清单真源 · 名字闸 · 真删与邻居不误伤（含只读件）· 幂等 · 参数解析 · 契约守卫（钩子挂上 + 勾选框条件 + `/PURGE-DATA` + `$UpdateMode`）· **反向守卫**（`wix/cleanup.wxs` 与 `fragmentPaths` 不得复活） | ✅ 520 passed（2026-09-26） |
| 安装器 | 本地重建 NSIS（`languages: ["SimpChinese"]` ⇒ 勾选框与卸载流程全中文）；核对 `target/release/nsis/x64/installer.nsi` 里钩子 `!include` 在第 28 行、`SimpChinese.nsh` 里 `deleteAppData` = 「删除应用程序数据」 | ✅ 构建通过，`兰台_1.0.3_x64-setup.exe` |
| 渠道 | `cargo tauri build`（不带 `--bundles`）按新配置跑：核对只产出 NSIS、MSI 不再出现；`wix` 段与 `wix/cleanup.wxs` 均已从配置/仓库移除 | ✅ 只产出 `兰台_1.0.3_x64-setup.exe`（2026-09-27 00:19:51），candle/light 两步不再出现；随后对这份成品重跑 E2E-② 仍 `FAILURES = 0` |
| E2E-① | 临时根播种假数据（含只读件 + 同前缀邻居）→ 真跑 `lantai.exe --purge-user-data --yes` | ✅ exit 0；`removed=5 missing=3 failed=0`；邻居与 `.lantai-old` 保留；日志在场 |
| E2E-② | 全程沙箱（`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 重定向到临时树 ⇒ NSIS 的 shell 文件夹随之派生）：`setup.exe /S` → `uninstall.exe /S /PURGE-DATA` | ✅ 安装目录 + `.lantai` + `.hologram` + 两个 AppData 目录全清；注册表两项无残留；**真机 `~/.lantai`（67 109 064 B）与 `%LOCALAPPDATA%\com.lantai.app`（403 360 607 B）字节数前后一致** |
| 真机 | 装 → 卸载时**勾选**「删除应用程序数据」→ 核对主目录与两个 AppData 根全空（未勾选时应一个字节都不删）——owner：用户 | ⏳ |

## 遗留边界（如实记）

- 卸载器只删**这一个用户**的数据（`Impersonate="yes"` / `FindProcessCurrentUser`）——多用户机器上
  其他账户的残留不在范围（与上游模板同边界）。
- 若用户先手删了安装目录里的 `lantai.exe`，钩子调不动清理（DetailPrint 会说明）——数据留在原位，
  这是安全方向。
- 工作区级数据（`{项目}/.lantai`）永不随卸载删除，需用户自己清（README 已写明）。
- 旧 `.msi` 安装（2026-09-26 起不再提供）没有清理通路：那批用户要先跑
  `lantai.exe --purge-user-data` 才能连数据一起清；装新版 `.exe` 时安装器会自动接管旧 MSI 安装。
