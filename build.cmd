@echo off
REM 兰台（Lantai）build wrapper — redirects TEMP to D:\tmp so Rust's proc-macro
REM server caches don't eat C: drive space. Each build leaves ~50 MB in %TEMP%.
set TEMP=D:\tmp
set TMP=D:\tmp
cargo tauri build %*
