# 兰台 Provider 页修复交接

日期：2026-11-21
分支：main
工作区有大量未提交改动，禁止 reset/checkout 覆盖。
下个窗口只处理剩余风险，不要重做已完成修复。

## 0. 结论

Provider 页问题来自多写入面、多真相源、缺少保存事务与配置指纹，不是单纯 CSS。

本轮已修：保存前校验、保存串行化与 revision、外部文件冲突阻断、凭据删除失败上抛、fatal last-good、删除/同名重建运行态清理。
已修：Provider 名大小写唯一、OAuth 缓存与多账号选择、探针指纹、草稿测试不落持久状态、Provider 本地状态串台、思考档位能力/会话分层。

## 1. 思考档位最终语义


1. 模型能力/档位声明：Provider → 可用模型 → 参数 → 推理档位声明。
   来源为 API 拉取 / 内置目录 / 手动覆盖 / 未声明；只描述模型支持哪些档、每档 wire 值是什么。
2. 本次会话用哪一档：创作坞 → 模型选择器 → 思考；Provider 页不保存默认思考档位。

供应商返回数组：显示档位，wire 默认按档位名原值发送。
供应商返回对象：显示档位到 API 参数值的映射。
供应商未返回：显示未声明；创作坞只给自动/关闭安全兜底，可在 Provider 页手动覆盖补声明。

当前只认 canonical：minimal / low / medium / high / xhigh / max。私有词必须补明确映射，不能静默猜。

## 2. 下个窗口仍需处理

### R1（高）fatal 后跨重启 last-good
同进程 last-good 已修；重启后若 localStorage 只剩运行态壳，仍可能丢 intent。建议把完整 intent 快照持久化到独立 backup，fatal 时优先读 backup。

### R2（高）外部文件冲突仍是 watcher 级
保存前比较磁盘 hash/mtime/lastFileText；不一致直接冲突态。磁盘存在、patch 不含且不在 pendingDeletes 的有效节必须保留或拒写。

### R3（中）保存仍非原子事务
顺序是 provider.yml → saveSettings → 凭据。凭据失败时配置已保存。建议临时文件 + 凭据预检 + commit/rename，或明确两阶段语义。

### R4（中）probe 指纹对 Key 只记长度
同长度换 Key 若绕过 UI 编辑路径不会使旧探针失效。建议增加不可逆 key hash 或 credential revision。

### R5（中）model 仍兼任最近使用与显式默认
UI 说自动跟从，但目录勾选/移除又会自动改 model。需要产品二选一：移出 Provider 配置，或改成显式设为默认。

### R6（中）ModelSelector 仍有全局目录显示元数据
settings 侧窗口/视觉/档位已 provider 作用域，但 configuredModelDescriptors 仍用全局 getModel 做显示；不同 Provider 同名 id 仍可能串显示。建议统一 catalogSeedForProvider。

### R7（低）AddProviderSheet 多 OAuth 账号没有新行账号选择器
登录多个账号只默认最后一个 grant。AddProviderEntry.oauthAccountId 已存在，接线成本不高。

### R8（必须真机验）
OAuth 登录/多账号/登出；oauthAccountId 重启生效；watcher 冲突阻断；fatal 重启恢复；Key 删除失败恢复路径。

### R9（已知测试环境问题）
全量并行时 tests/composer-sheet.test.tsx 的 pp-goal-strip 有跨用例污染；单独跑通过，和 Provider 改动无关。

## 3. 已验证

- tsc --noEmit：通过。
- Provider/设置/门禁 38 个测试文件、472 用例：全通过。
- build-builtin-plugins：41 个内置插件产物自包含校验通过。
- 测试命令入口：cd src-ui 后跑 node .\node_modules\vitest\vitest.mjs run（文件列表见 git diff / 新增测试）。

## 4. 部署警告

插件构建提示 faceDeps 指纹 cdf5375e → 0d502120，删除键 modelThinking。
只替换 dist-plugins 不够，旧 exe 会拒载新产物；必须重建 exe：cd src-tauri && cargo tauri build（或 --no-bundle）。

## 5. 关键文件

Provider 页：ProviderPage/ProviderDetail/ModelReasoningLevels/SettingsPanel/settings-panel-helpers/AddProviderSheet/ProviderList/ProviderAdvanced/provider-data/status。
核心：settings.ts/provider/model-meta.ts/providers-doc.ts/providers-store.ts/live.ts/catalog.ts/oauth.ts。
新增测试：provider-oauth-account-selection/provider-status-fingerprint/provider-thinking-capability-view/ui/provider-model-autofill。

## 6. 接手顺序

1. 先读本文和 docs/design/provider-system-spec.md 的思考档位/OAuth 章节。
2. 不重做第 0 节的已修项。
3. 先 R1/R2，再 R3/R5/R6；R4/R7 视真机反馈。
4. 最后跑 tsc + provider 套件 + 真机 OAuth/文件冲突验收。
