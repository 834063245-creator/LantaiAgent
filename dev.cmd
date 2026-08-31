@echo off
REM 兰台（Lantai）dev wrapper — 一条命令进入开发热更模式。
REM
REM 与 build.cmd 同样的 TEMP 重定向（D:\tmp）：Rust proc-macro 服务端缓存
REM 不占 C 盘；每次冷编译也留 ~50MB 在 %TEMP%。
REM
REM 行为：cargo tauri dev 会自动先跑 tauri.conf.json 的 beforeDevCommand
REM （npm --prefix src-ui run dev → Vite dev server @ 127.0.0.1:1420），
REM 然后起 Rust 壳 + 打开开发窗口。
REM
REM 开发窗口 = 热更新：改前端代码保存即生效（HMR，秒级），无需重打包。
REM Rust 侧改动会触发自动重编译重启（分钟级，属正常）。
REM 差异与常见问题见 docs/dev-workflow.md。
set TEMP=D:\tmp
set TMP=D:\tmp
cargo tauri dev %*