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

cargo tauri build %*
