# 兰台 Provider 页修复交接

日期：2026-11-21
分支：main
工作区有大量未提交改动，禁止 reset/checkout 覆盖。
下个窗口只处理剩余风险，不要重做已完成修复。

## 0. 结论

Provider 页问题来自多写入面、多真相源、缺少保存事务与配置指纹，不是单纯 CSS。

本轮已修：保存前校验、保存串行化与 revision、外部文件冲突阻断、凭据删除失败上抛、fatal last-good、删除/同名重建运行态清理。
已修：Provider 名大小写唯一、OAuth 缓存与多账号选择、探针指纹、草稿测试不落持久状态、Provider 本地状态串台、思考档位能力/会话分层。

**R1/R2 本轮已完成**：跨重启独立 intent 备份 + fatal/坏节回落；保存前 revision + 磁盘原文冲突闸 +
未点名有效节保留。实现见 `providers-store.ts`，回归见 `tests/providers-store.test.ts`。

## 1. 思考档位最终语义


1. 模型能力/档位声明：Provider → 可用模型 → 参数 → 推理档位声明。
   来源为 API 拉取 / 内置目录 / 手动覆盖 / 未声明；只描述模型支持哪些档、每档 wire 值是什么。
2. 本次会话用哪一档：创作坞 → 模型选择器 → 思考；Provider 页不保存默认思考档位。

供应商返回数组：显示档位，wire 默认按档位名原值发送。
供应商返回对象：显示档位到 API 参数值的映射。
供应商未返回：显示未声明；创作坞只给自动/关闭安全兜底，可在 Provider 页手动覆盖补声明。

当前只认 canonical：minimal / low / medium / high / xhigh / max。私有词必须补明确映射，不能静默猜。

## 2. 下个窗口仍需处理

### R1（高）fatal 后跨重启 last-good（本轮已完成）
- 独立键 `hologram_provider_intent_backup_v1` 保存完整 intent 快照（不含 Key / 探针 / catalog / modelMeta）。
- 每次非 fatal、非空文本装载后刷新快照；重启后先把备份灌入 last-good，因此整份 fatal 和「整节读不出来」都能回落。
- fatal 时 `providersFileReady` 仍为 false（不写盘、不剥本机意图）；UI 明示「从本机 intent 备份恢复」。
- 回归：fatal 跨重启、重启后坏节回落、localStorage 只剩运行态壳。

### R2（高）外部文件冲突仍是 watcher 级（本轮已完成）
- 保存请求携带编辑起点 `expectedRevision`；watcher 已重读而面板仍是旧草稿时直接拒写。
- 写盘前再比磁盘原文与 `lastFileText`：watcher 尚未送达的外部修改也挡住；磁盘读不到时不按空文件重建。
- 磁盘上存在、patch 未覆盖且不在 `pendingDeletes` 的有效节用 `keep` 原样保留（注释/前向字段不动）；只有显式删除才移除。
- 全局 tab 保存不再顺手重写 provider 文件，缩小无关写入面。
- 回归：外部改写直拒、过期 revision 拒写、未点名节保留、显式删除生效。

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

- tsc --noEmit：通过（R1/R2 完成后复跑）。
- Provider + 设置过滤套件 41 个测试文件、492 用例：全通过。
- R1/R2 新增回归：fatal 跨重启备份恢复、坏节跨重启回落、保存时磁盘外部改写冲突、
  watcher 已重读的过期 revision 冲突、未点名有效节保留 / pendingDeletes 显式删除。
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
3. R1/R2 已完成，下一步 R3/R5/R6；R4/R7 视真机反馈。
4. 最后跑 tsc + provider 套件 + 真机 OAuth/文件冲突/重启恢复验收。
