; 兰台 NSIS 安装/卸载钩子 —— 由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 挂上。
;
; 背景（2026-09-26 用户报「卸载残留 .lantai / .hologram」）：
; 卸载确认页的「删除应用程序数据」勾选框（上游模板 un.ConfirmShow 画的 $(deleteAppData)）
; 只清 %APPDATA%/%LOCALAPPDATA%\<identifier>；用户主目录下的 .lantai（会话/设置/插件/
; 技能/全局记忆）与 .hologram（2026-08-23 改名之前的老位，含引擎二进制与语法仓库）无人管。
;
; 钩子只负责「什么时候问、什么时候调」，**目录清单不复述**——交给应用自己
; （真源 src-tauri/src/purge.rs），与 MSI 那条路共用同一实现：
;   · 必须在 PREUNINSTALL：POSTUNINSTALL 时 $INSTDIR\lantai.exe 已经被删掉了；
;   · 先跑一次「兰台是否在运行」检查（与模板紧随其后的那次同源；进程在跑时部分文件
;     删不掉，正是「没删干净」的另一种成因）；
;   · 同意删除数据的两个来源：GUI 勾选框（$DeleteAppDataCheckboxState）或命令行
;     `/PURGE-DATA`（无人值守 /S 时勾选框页根本不出现，脚本用这个显式声明同意）；
;   · $UpdateMode <> 1：应用内自动更新走的也是这段卸载，更新绝不能碰数据；
;   · 三者皆无（勾选框缺省不勾、静默卸载不带开关）⇒ 一个字节都不删。

; 命令行同意位（声明在顶层作用域：NSIS 的 Var 不能在 section/function 里声明）
Var LantaiPurgeData

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $LantaiPurgeData 0
  ${GetOptions} $CMDLINE "/PURGE-DATA" $R0
  ${IfNot} ${Errors}
    StrCpy $LantaiPurgeData 1
  ${EndIf}

  ${If} $UpdateMode <> 1
    ${If} $DeleteAppDataCheckboxState = 1
    ${OrIf} $LantaiPurgeData = 1
      !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
      DetailPrint "正在删除用户数据（.lantai / .hologram / AppData）..."
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --purge-user-data --yes' $0
      ${If} ${Errors}
        DetailPrint "用户数据未清理：无法启动 $INSTDIR\${MAINBINARYNAME}.exe"
      ${ElseIf} $0 <> 0
        DetailPrint "用户数据有残留（退出码 $0，明细见 %TEMP%\lantai-uninstall-purge.log）"
      ${Else}
        DetailPrint "用户数据已删除"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; 注册表侧的收尾（脚本化 /PURGE-DATA 路径）。
; 上游模板把「清安装位置登记（Software\lantai\兰台）」放在**勾选框那一段**里，
; 所以 GUI 勾选会清、命令行同意不会清 —— 残留一个指回已删目录的 InstallLocation
; 是同一族「没卸干净」（还会误导下次安装的「沿用上次目录」）。
; 放在 POSTUNINSTALL：模板清快捷方式时要读这个键下的开始菜单文件夹名，早删会把
; 快捷方式留在开始菜单里。
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ${If} $DeleteAppDataCheckboxState = 1
    ${OrIf} $LantaiPurgeData = 1
      DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
      DeleteRegKey /ifempty SHCTX "${MANUKEY}"
      DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
      DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
      DeleteRegKey /ifempty HKCU "${MANUKEY}"
    ${EndIf}
  ${EndIf}
!macroend
