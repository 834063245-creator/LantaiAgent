# bin/ —— 二进制落位处（本目录不进仓二进制）

`manifest.json` 声明的 stdio server 命令是 **`./bin/officecli.exe`**（相对插件目录解析，
见 `src/plugins/mcp-bridge.ts` 的 `resolveCommand` / `resolvePluginRel`）。该文件**不随仓提交**
（win-x64 单文件 31.87 MB），装插件后必须把二进制放进这里。

## 装法（三选一）

```powershell
# a) 用本仓的分发安装器，直接装进插件目录的 bin/（pin 版本 + 哈希校验）
..\..\..\office-cli\install-officecli.ps1 -FromRelease -Dest .\bin

# b) 从本机已下载件装（离线/内网）
..\..\..\office-cli\install-officecli.ps1 -FromLocal D:\downloads\officecli-win-x64.exe -Dest .\bin

# c) 从别处已装好的用户工具位复制（哈希自核）
Copy-Item "$env:USERPROFILE\.lantai\tools\officecli\officecli.exe" .\bin\officecli.exe -Force
& .\bin\officecli.exe --version     # 期望 1.0.149（本仓 pin 的版本）
```

装好后 `bin/` 应含 `officecli.exe`（以及安装器写的 `VERSION` / `SHA256SUMS`）。

## 为什么二进制不进仓

31.87 MB 单文件进 git 会让 clone/历史迅速膨胀，且它是**外部产物**（Apache-2.0，上游发版节奏
与本仓无关）。分发走「安装器按 pin 版本 + 哈希校验落位」——与 `_up_/src-ui/dist-plugins/`
（出厂产物走磁盘通道）同一个思路：**产物与源码分开走**。
