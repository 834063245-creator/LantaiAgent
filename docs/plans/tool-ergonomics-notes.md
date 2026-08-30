# 工具层人体工学与智能（notes）

> 2026-08-30 记录。来源：用户实际使用反馈「agent 手里的工具每次使用要传的参数太多太长」，
> 对话中深化为「工具层智能太低」的方向批评。本文是讨论记录 + 候选补丁清单。
> **进展**：**T-1 + T-2 已落地（2026-08-30 当日实施竣工）**——rev2 归位 JS 平台层
> （per-owner 注册表 `agent/session-context.ts` + domains.ts 参数预处理腰），Rust 零改动；
> 门禁全绿（tsc/biome/vitest 全量/双 preset verify/doc-sync/契约文档重录），baseline
> freeze 附带补录 56fb9285 漏掉的 minimal system-prompt 侧重录（详见 baseline-change-request.md）。

## 诊断（对着 docs/agents/model-tool-contract.md 实账）

1. **绝对路径重复税（最大头）**：`fs` read/write/edit 的 `filePath` 契约即 "Absolute path"
   （coding.ts L97 起）；`git` 13 个 action 的 `path` 全要求 repo root；`search` 的 `directory` 同样
   ——每次调用模型都要重新生成 `D:\HoloGramHG\...` 全前缀。而 `shell` 已用 sticky cwd per agent
   解决同题（cd 一次后续免传），同一有效模式未推广到 fs/git/search，属欠账。
2. **flat schema 噪音税**：域折叠后一张参数表混装全部 action（browser 60+ 参数、desktop 40+、
   fs 16 个），每条描述重复标注 `(action: xxx)`。单次调用实际必传通常 2-4 个
   （fs(edit) 4 个、git(status) 2 个、shell(run) 1 个），但大表拉高模型多传/错传概率 + 吃系统提示词。

## 深层方向（用户 2026-08-30 提出）：工具层智能

现在的分工是「模型聪明、工具哑」：上下文推理、状态记忆、语义换算、格式校验全压在模型侧，
模型每次调用都要把上下文重新声明一遍——既是 token 税也是出错面（每次重述都是一次出错机会）。
第一手体验（Codely/通用 agent 工具面同类问题）：

- read_file 每次都要拼绝对路径；search 行号 1-based、read offset 0-based，接口文档还得教调用方换算
  （offset = L42 - 1）——接口自己在承认语义不统一。
- replace 要求逐字节复述 old_string 含缩进；文件是几十轮前读的、中途被改过就得重读重来，失败成本全是往返 token。
- 刚拿到的 taskId/jobId/agentId/assetId 下一次调用还得自己搬运接线；只有 browser 的 ref 范式做了
  「引用上次结果」，一家独享。

四条下沉重（工具层智能 = 让工具**记得住、推得出、接得上、容得下**）：

1. **默认值下沉**：path/directory/target 缺省 = workspace root / sticky cwd / 最近焦点。
2. **状态下沉**：跨调用记忆——sticky cwd、ref 表、上次结果自动接线；ref 范式只在 browser 落地，未推广。
3. **语义统一下沉**：行号 base、路径形态（相对/绝对）、大小写默认，同一套约定贯穿全部工具，
   别让调用方背换算表。
4. **校验智能下沉**：工具知道「这文件我刚返回过」→ 可做弱匹配+确认，而不是哑拒。

对兰台的落点：不是三个孤立补丁，而是一条轴——**会话上下文对象**（workspace root、sticky cwd、
最近焦点、ref 表）+ 工具包装层（composition 装配腰处 withSessionContext 之类）自动注入缺省与校验。

## 候选补丁（三处，未开工）

1. `fs` 支持 workspace 相对路径（或 sticky cwd 对齐 shell）。
2. `git` / `search` 的 path/directory 省缺时解析 workspace root。
3. schema 描述 per-action 重复标注改由 action 表统一承载，给 schema 瘦身。
