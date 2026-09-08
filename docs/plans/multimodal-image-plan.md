# 多模态图片链路施工计划（附图入卷——发送/接收/展示全链补齐）

> 立项：2026-09-08 · 状态：**B1+B2+B3 已竣工（B1 = 0d2c39bd · B2 = b99c5217 · B3 = 9affbbf2，
> 门禁全绿——vitest 全量 2870 用例 0 失败 / tsc 0 / biome 0/0 / convergence 双档 / doc-sync / build），
> B4 渲染 + B5 配置待施工** · 上游：2026-09-08 两问调查（问题 1）
> B1 落账注：rpc-contract.ts 源码面（action union + kernelWriteFileBase64）随并行窗口
> 9afa6878 已先行入库，B1 commit 补生成 frontend-rpc-contract.md；D-14 落账 = 无需契约升版。
> B2 落账注：门禁策略在视图（imageCapable 目录声明）、机制在 chat-core；一次 agent 族
> 全量红经单跑复核为并发假红（在册模式）；git commit -F 信息文件须用 shell 写
> （文件工具的 D:\tmp 与 shell 不互通——B2 实测）。
> B3 落账注：预算算法测试驱动出真 bug（同消息内丢新保旧）——重写为反向贪心保新弃旧；
> phase-6 AgentConfig 字段面 29→30（imageReader IO 注入腰，登记 agent-platformization-plan
> §6 台账，gate/spec/断言三处同步）；agent 层零 app 依赖纪律保住（ctx.fs 是模型可见
> 工具面不适配内部读——改走 workspace 工厂闭包注入）；event-catalog 仅行号漂移重生成。
> 拍板：用户 2026-09-08「先来补齐图片多模态配套」→「先落 plan」。
> 参照系：DSH（`D:\useful\deepseek-harness`）图片链路全量研究（2026-09-08 主会话亲读，
> 可抄决定见 §1.2——DSH 是本仓钦定参照工程）。
> 自查模式：本文全部断言已对代码实测（file:line 落点，行号为 2026-09-08 快照）。

## 0. 背景：为什么做（五断点实测，2026-09-08 调查）

用户配置 vision 模型时，图片「发送/接收/展示」配套不齐备——发图只是把路径塞进文本
前缀让模型自己 read_file（read_file 读图片还是 UTF-8 报错）：

| # | 断点 | 现状 | 实测证据 |
|---|---|---|---|
| 1 | 发送·采集 | ❌ 无图片入口 | ComposerDock.tsx:437 夹=Tauri dialog 路径附件（filters 空）；:449 attachPaths（引/拖共用）；全仓无 paste 处理器 |
| 2 | 发送·管线 | ❌ 附件压成文本前缀 | chat-core.ts:1323-1329「用户附加了以下文件…可以用 read_file 读取」→ :1346 `agent.run(signal, focusPrefix + text)` 只收字符串 |
| 3 | 发送·适配器 | ❌ content 恒 string | provider/types.ts:26 `Message.content: string`；openai.ts:236-263 / anthropic.ts:240 / responses.ts:226 均无图片编码 |
| 4 | 接收 | ❌ 无图片 part | message-model.ts AssistantPart 联合无 image；markdown.ts 全文无 img 语法 |
| 5 | 展示 | ⚠️ 半支持 | components.tsx:471 `useMediaData`（fs_cap read_base64→data URI）只服务资产块；用户附件图只显示路径小字（translate.ts:184-193 payload.files） |
| — | 配置 | ⚠️ 半支持 | types.ts:142 `ModelDescriptor.input` 字段在，但 catalog seed + 三适配器 /models 拉取（openai.ts:151 等）全部硬编码 `['text']`，零消费方 |

唯一能跑通的图 = agent 主动 `show_asset` 的资产通道（MediaBody），与用户↔模型图片无关。

**Office 三件套（同日调查问题 2）不属本计划**——工具层空白/展示层 #20 在册暂缓
（scientific-rendering-plan.md:248），另线处理。

## 1. 勘察事实

### 1.1 兰台可复用地基（实测，全部现成）

- **读字节通道全链就位**：fs_cap `read_base64`（fs_cap.rs dispatch →
  confined_fs.rs:733 `read_base64_cap` → base64）→ components.tsx:471 `useMediaData`
  → data URI → `<img>`（含大图预览浮层、epoch 防串流、MEDIA_MIME 表）。
- **原生拖放通道**：bridge.ts:136 `watchFileDragDrop`（Rust FileDragEvent 给路径；
  WebView 收不到 HTML5 drop——chat-core.ts:1453 注记实测）。
- **附件草稿底座**：state/input-store.ts `attachedFiles {path,name,size}` +
  会话草稿槽（saveSessionDraft/restoreSessionDraft）——引/拖/夹三入口已汇入。
- **per-model 覆盖面**：settings.ts:58 `ModelOverrides`（contextWindow/maxTokens 先例）+
  ProviderDetail.tsx:331 设置 UI——`input` 声明可挂同面。
- **模型目录**：provider/catalog.ts（catalog/*.json 静态 seed glob 装载 + /models
  动态合并，静态优先）；`input` 字段已在 ModelDescriptor（types.ts:142）。
- **会话持久化**：agent 侧 agent.ts:840 `saveState`（AgentRecord 含 session
  Message[]）+ UI 侧卷 JSON（UserMessage 全字段自然随卷）——引用形态可序列化即存活。
- **compaction 折叠视图**：agent.ts:1594 `payloadMessages()` → agent-compaction.ts
  impl（折叠区从载荷消失——图片随折叠退役，见 D-12）。
- **缓存锚点无碍**：anthropic.ts `findLastNonThinkingBlock` 只跳 thinking——
  image block 可挂 cache_control，无需特判。

### 1.2 DSH 可抄设计决定（研究纪要，出处亲读）

| # | DSH 决定 | 出处 |
|---|---|---|
| 1 | 消息只存引用不存字节：准入落持久附件（attachmentId=sha256 内容寻址），transcript 只有 ImageAttachmentRef；请求期才解析成 wire | attachment/src/types.ts、attachment-local/src/store.ts:87-120 |
| 2 | 准入即规整：EXIF 校正+降采样（规整上限 2048×2048/4MiB）+ magic-byte 校验声明类型；全批先验后写 | attachment-local/src/store.ts:95-120、normalization.ts |
| 3 | 限制默认值：单图 20MiB/每消息 20 图/消息总量 200MiB/白名单 png·jpeg·webp·gif | attachment-local/src/index.ts:28-48 |
| 4 | 序列化：OpenAI 兼容 `image_url: data URI`；**纯文本消息保持 string 紧凑形态**；每图前置 text 句柄 part | llm-deepseek/src/serialize.ts:141-187 |
| 5 | 预算降级：请求超限→**最旧先移除**换确定性占位文本（含量度/恢复路径提示） | llm/src/content.ts:224-280 |
| 6 | 能力门禁三面：目录 `inputModalities` 声明（zod default ['text']）→ 分发层对非 vision 模型**投影为文本占位（不报错）**→ 适配器硬门禁兜底 | llm/src/index.ts:996-1006、adapter.ts:457 |
| 7 | 采集：paste=`clipboardData.items kind==='file'`→File；drag=document 级深度计数+DropOverlay；rail 缩略+lightbox | ComposerAttachments.tsx、input/editor/keymap.ts:127-147 |
| 8 | 渲染双轨：提交瞬间 previewUrl 同步显示，落盘后 ref→会话作用域 URL 缓存（resolve/peek/seed+revoke） | ui-conversation/conversation/historical-images.ts |
| 9 | markdown img 只渲远端：sanitizeUrl+协议白名单，不合法降级 alt 文本 | ui-primitives/markdown/render.tsx:505-513 |

### 1.3 精确落位图（施工插入点）

| 断点 | 插入点 |
|---|---|
| 采集 | ComposerDock.tsx:437（夹→图片过滤分支）/:449 attachPaths（图片扩展名分流）/ 新增 onPaste（webview 剪贴板 File 直拿字节）/ bridge.ts:136 watchFileDragDrop（路径→read_base64 读字节）；input-store.ts 旁挂图片草稿槽 |
| 管线 | chat-core.ts:1323-1346（图片不再文本前缀化；普通文件行为不变）→ agent.run 扩参 → agent.ts:1035 `_appendMessage('user/message', …)`；provider/types.ts:26 Message 旁挂 `images?` 字段 |
| 适配器 | openai.ts:236 user→content parts；anthropic.ts:240 `appendBlocks('user')`→image block；responses.ts:226 已是 parts 数组（+input_image）；agent.ts:1298 `payloadMessages()` 后、stream 前插解析步骤 |
| 渲染 | translate.ts:184 translateUser payload 旁挂 images；renderer 复用 useMediaData；markdown.ts 新块型（**measure.ts 镜像必做**——单一解析纪律） |
| 配置 | catalog seed JSON 声明 + settings.ts:58 ModelOverrides.input + ProviderDetail.tsx 开关 + ModelSelector 徽标 |

## 2. 目标形态

```
粘贴(paste File) / 拖放(原生通道→路径→read_base64) / 夹(picker 图片过滤)
   ▼                          采集分流：图片 mime/扩展名
准入规整（webview canvas：EXIF 校正·长边≤2048·重编码≤4MiB·magic-byte 校验）
   ▼ fs_cap write_base64（新能力口，用户通道）
{ws}/.lantai/attachments/{sha256}.{ext}   ← 内容寻址（跨卷天然去重）
   ▼ 引用 ChatImageRef {id, mediaType, bytes, w, h, name?}
input-store 图片草稿 ──发送──► chat-core ──► agent.run(signal, text, images)
   ▼                                        └► Message.images（卷 JSON 只带引用）
请求期解析（streamOnce 前：ref→data URI，按 ref 缓存；随 Request.imageData 传）
   ├──► openai.ts   ：content parts [{type:'text'},{type:'image_url', image_url:{url:'data:…'}}]
   ├──► anthropic.ts：[{type:'image', source:{type:'base64', media_type, data}}, {type:'text'}]
   └──► responses.ts：content [{type:'input_text'}, {type:'input_image', image_url}]
预算降级（请求总量超限→最旧先移除→占位文本）· 能力投影（无 image 声明→占位文本，不报错）
渲染：用户气泡缩略图（useMediaData 通道+现成预览浮层）· markdown ![alt](https://…) 远端白名单·固定盒
持久化：引用随卷/随 session 落盘——字节永不进卷，重启即活
```

## 3. 裁定表（agent 落款，无待拍板项）

| # | 决策点 | 裁定 |
|---|---|---|
| D-1 | 字节归属 | **字节永不进卷**：`Message.images?: ChatImageRef[]` 旁挂（content 保持 string——compaction/sanitizeToolPairing/token-counter 零波及）；UI 侧 UserMessage 同构旁挂。ChatImageRef = `{id, mediaType, bytes, width, height, name?, originalDimensions?}`——纯 JSON 可序列化 |
| D-2 | 存储形态 | `{ws}/.lantai/attachments/{sha256hex}.{ext}` 内容寻址，**不按会话分目录**（跨卷去重）；ext 由 mediaType 映射。目录随 workspace_remove 一起走（与 sessions 同语义） |
| D-3 | 采集三入口 | paste（webview clipboardData File→字节）；拖放（原生通道给 path→fs_cap read_base64 读字节——真机唯一 drag 路）；夹 picker（Tauri dialog 加图片 filters 分支）。三入口汇聚同一准入规整 |
| D-4 | 准入规整 | webview `createImageBitmap`+canvas：EXIF 校正、长边≤2048/像素≤2048²、重编码 jpeg q0.85（png 规整保留无损分支）；**magic-byte 校验声明类型**（不信任 mime 声明）；限制抄 DSH 默认（§1.2#3）。规整失败→拒绝+toast，不入草稿 |
| D-5 | 请求期解析 | agent.ts `streamOnce`（L1275）stream 调用前：收集本轮载荷全部 ref → fs_cap read_base64 → `{id→{mediaType, data}}`，**按 id 缓存**（agent 实例级 Map——同一图跨回合零重读）；挂 `Request.imageData`。适配器保持纯函数（只 join，不 IO） |
| D-6 | wire 纯文本纪律 | 无 images 的消息 wire 形态**字节不变**（openai string 紧凑态/anthropic 单 text block/responses 单 input_text）——零回归面，convergence 零漂移预期 |
| D-7 | 预算降级 | 请求图片累计上限：20 图/消息总量 200MiB（D-4 准入面）之外，**请求级**累计 data URI ≤ 24MiB、≤ 40 图；超限**最旧先移除**，换占位文本 `[图片已省略（超出请求预算）：{name} {w}×{h}。可请用户重新附图。]`——确定性决策（总量已知的按序移除，无量子化需求——兰台历史远小于 DSH 压力场景） |
| D-8 | 能力门禁三面 | ① 目录声明：catalog seed JSON 给已知 vision 模型 `input:["text","image"]` + 用户对自定义/动态模型经 **ModelOverrides.input** 补声明；② composer 入口：活跃模型无 image 声明→图片入口隐藏+paste 弹提示；③ agent 投影：载荷含图而模型无声明→图投为占位文本（不报错——抄 projectImagesForTextModel） |
| D-9 | 渲染 | 用户气泡：payload.images 缩略行（复用 useMediaData+现成预览浮层）；markdown img：`![alt](http/https)` 新块型——sanitizeUrl+协议白名单（抄 §1.2#9），**固定盒高 160px**（chem 180px 固定盒先例）+ measure.ts 镜像 + RO 兜底；本地路径/data URI 不进 markdown 通道（资产通道既有职责） |
| D-10 | 接收面边界 | 模型原生图片输出**不在本期**（chat-completions 生态罕见；DSA 生图属生成工具线）；模型回 markdown 远端图由 D-9 覆盖；tool-result 图片（DSH 有）暂不做——agent 工具面无产图工具，无消费方 |
| D-11 | token 计数 | token-counter 不计图片（vision 按图/按 token 计费不透明）；上下文估算偏低——注释注明，可接受 |
| D-12 | compaction | 折叠区图片随折叠退役（payloadMessages 折叠视图天然如此）；摘要 user prompt 追加「本区含 N 张已折叠图片」事实提示 |
| D-13 | Rust 能力口 | fs_cap 新 `write_base64` 动作：confined_fs.rs 实现（复用 write 的 resolve_write_dispatch 闸与原子写）+ fs_cap.rs dispatch + rpc-contract.ts 白名单/结果类型三处同步。**只开用户通道（is_agent=false）**——agent 工具面（EditTool）不注册该动作描述（二进制写面给 agent 属权限面扩展，另议） |
| D-14 | 契约核对 | 批 1 核对 rpc-contract.ts 是否在开放面契约文件清单（contract-version.ts）内：在→四步升版同 commit（bump+变更记录+指纹+同 commit）；不在→指纹自查记录。**工具面零改动**（无新 agent 工具）→ gen:tool-contract 不涉 |
| D-15 | 规整归属 | 规整在 TS webview（策略在 TS、Rust 只留能力口——kernel-plugin v3 宪法）；**不引 Rust 图片解码 crate** |

## 4. 批序（每批独立全门禁绿 commit）

| 批 | 内容 | 验收 |
|---|---|---|
| B1 底座 | ① ChatImageRef/Message.images/UserMessage.images 类型；② input-store 图片草稿槽（增删+草稿快照随迁）；③ Rust fs_cap write_base64（confined_fs 实现+dispatch+rpc-contract 同步，cargo 单测：写读 roundtrip+闸语义）；④ 准入规整纯函数 util（normalizeImage/limits/magic-byte）+ 单测；⑤ D-14 契约核对落账 | cargo 全绿（含新单测）+ vitest 新测试绿 + biome 0/0 + build |
| B2 采集 | paste handler + 拖放/picker 图片分流（attachPaths 扩展）+ ComposerDock 缩略 rail（点击放大）+ 能力门禁（D-8②：input 声明消费——入口显隐+paste 提示）+ 单测（采集分流/草稿槽/门禁） | 同上 + UI 相关 vitest 族全绿 |
| B3 发送 | chat-core sendMessage 图片分流（**图片不再文本前缀化；普通文件行为字节不变**）→ agent.run 扩参 → _appendMessage images → streamOnce 前请求期解析器（D-5：缓存+Request.imageData）→ 三适配器 parts 构造（D-6 纯文本零变化钉测试）→ 预算降级（D-7）→ 能力投影（D-8③）→ compaction 提示（D-12）+ 序列化形状单测（三协议 wire 断言） | vitest 全量 + build + biome 0/0 + convergence 双档（零漂移预期——system-prompt/工具面零改动） |
| B4 渲染 | translateUser payload.images + 用户气泡缩略渲染（复用 useMediaData）+ markdown img 块型（解析器+renderer+**measure.ts 镜像**+固定盒）+ paper 视觉测试 + 白名单拒绝路径测试 | 同上 + paper/measure 族测试全绿 |
| B5 配置+文档 | catalog seed vision 声明（anthropic/openai/deepseek 已知款）+ ModelOverrides.input + ProviderDetail「视觉模型」开关 + ModelSelector 徽标 + README.md 落账行 + 本计划状态更新 + 门禁全量收官 | 全门禁（vitest 全量/build/biome/cargo/convergence/doc-sync） |

## 5. 验收

**门禁判据**（每批）：vitest 全量 + `build` + biome 改动面 0/0 + cargo（涉 Rust 批）+
convergence 双档零漂移（预期——specs 面零改动；若纸面块型 spec 意外涉录则走
baseline-change-request，不静默重录）。

**grep 验收**（B3 后）：`Message.images` 在 agent session 落盘面存活（AgentRecord 序列化
含引用）；openai/anthropic/responses 三文件均有 images 分支；`图片已省略` 占位文本存在；
`attachedFiles` 文本前缀路径不再处理图片扩展名。

**真机验收**（B5 后用户跑）：
1. vision 模型（GLM-4V/Qwen-VL 等任配一款）粘贴截图 → 模型描述图片内容（而非 read_file 报错）
2. 非 vision 模型：入口隐藏/贴图提示；强行含图历史 → 投影占位不炸
3. 三入口齐验：粘贴（Ctrl+V 截图）/ 拖放图入卷 / 夹选图
4. 重启后历史卷用户气泡图片仍显示（附件目录+卷引用跨重启存活）
5. 多图/大图预算降级：超限图换占位文本，本轮对话不炸
6. markdown 远端图渲染 + 非白名单源降级 alt 文本

## 6. 风险与边界

- **写闸语义**：attachments 目录写入复用 write 的 resolve_write_dispatch（用户路径闸）——
  B1 用既有 sessions 目录写同款测试钉住；agent 通道不开放（D-13），无新权限面。
- **卷体积**：每图引用 ~200B JSON，字节永不进卷；附件目录只增不减（无 GC——与 sessions
  同生命周期语义，删卷不清图——内容寻址下同图复用，清了会破别的卷）。
- **canvas 规整质量**：jpeg q0.85 默认 + png 无损分支；规整失败拒绝入草稿（不静默降质）。
- **WebView paste**：Tauri WebView 剪贴板图片可用性以真机验收 3 兜底；不可用则拖放/夹两入口
  先行，paste 面记录欠账。
- **老卷零迁移**：images 为可选字段，旧卷自然兼容。
- **并行窗口纪律**：每批 staging 前重新 `git status --short` 核对改动面（既有教训）。
