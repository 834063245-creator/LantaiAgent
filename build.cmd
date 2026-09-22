@echo off
REM 兰台（Lantai）build wrapper — redirects TEMP to D:\tmp so Rust's proc-macro
REM server caches don't eat C: drive space. Each build leaves ~50 MB in %TEMP%.
set TEMP=D:\tmp
set TMP=D:\tmp

REM 随包件取件：office 域工具的后端二进制（officecli，约 32 MB，不入 git）。
REM 已落位且哈希相符时零网络直接通过；缺件则下载；哈希不符则拒绝——
REM 绝不把缺后端/错后端的安装包发出去（用户侧会表现为 office 工具一调就报找不到文件）。
node scripts\fetch-officecli.mjs
if errorlevel 1 (
  echo [build] officecli 取件失败，终止打包。
  exit /b 1
)

REM --config 覆盖：本地构建**不生成 updater 签名产物**。
REM   · 为什么：tauri.conf.json 的 bundle.createUpdaterArtifacts 恒为 true（发版／CI 需要
REM     .sig + latest.json，否则应用内更新静默失效）；而本机没有签名私钥密码，本地构建
REM     若走 true 会直接失败。所以本地这一侧显式覆盖为 false，两边各取所需。
REM   · 文件名刻意不叫 tauri.<平台>.conf.json——那种形态会被 tauri **自动合并**，
REM     一旦如此就会把 false 带回发版态（2026-08-25 那个 bug 的翻版）。
REM   · 要本地产出带签名的安装包：先设好 TAURI_SIGNING_PRIVATE_KEY 与
REM     TAURI_SIGNING_PRIVATE_KEY_PASSWORD，再直接跑
REM     `cargo tauri build`（不带本覆盖）。
cargo tauri build --config src-tauri/no-updater.local.json %*
