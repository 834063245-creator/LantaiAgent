# 嵌入缓存持久化（设计件 · Proposed）

> **状态**：未开工（2026-09-26 立项，等另开窗口施工）。施工面 = `hologram-vector`（+ 可选一行状态面）。
> **由来**：`#1 idle 误杀`修完之后暴露的**下一个瓶颈**——进程内缓存在每次进程重启时归零。
> **前置阅读**：[`engine-lsp-runtime-hardening-plan.md`](engine-lsp-runtime-hardening-plan.md)（本件的立账处）。

## 一、裁定（先看这个）

1. **做**：新增 `<data_dir>/vectors.embed.cache`，内容 = **这一轮 `build()` 用到的全量** `(snippet_hash → 向量)`。
2. **键 = snippet 内容哈希**；**文件头带 version / dim / backend**，任一不匹配 ⇒ **整份丢弃**（fail-open 重嵌入）。
   不引 mtime、不引 node id、不引文件路径。
3. **落盘时机** = `CodeVectorIndex::build()` 末尾，与既有 `save()` 同一段；`.tmp` + `rename_with_retry`
   复用既有原语（多进程同根并发写已有先例防线）。
4. **容量天然有界**：只写本轮用到的向量（22k 节点 × 384 维 × 4B ≈ **34MB**），随节点增删自动收敛，
   **不需要 LRU / GC**。
5. **不做**：不改 usearch 索引格式、不把缓存塞进 `hologram.db`、不做跨项目共享池、不做 mtime 失效。

## 二、证据（为什么值得做）

- 实测（2026-09-25）：嵌入吞吐 ≈ **26.5 节点/秒** ⇒ 21798 节点全量重建 ≈ **13.7 分钟**；该轮缓存命中
  **446/22244 = 2%**。
- 为什么只有 2%：`VECTOR_CACHE` 是**进程级 `static`**（[index.rs:257](../../hologram-vector/src/index.rs)），
  进程一死就清零。那一轮正是**刚重启的进程**在跑全量重建。
- `#1` 修完后，**同进程内**后续重建近乎全命中（watcher 每次保存触发的全量 build 只嵌入变更节点）；
  **跨重启仍是 0**——而重启是常态：切工作区、30 分钟静默预算到点、崩溃退避重启、用户重开应用。
- 收益/成本：34MB 文件读 + 反序列化，换 **13.7 分钟 CPU 推理**（22k 节点项目）。

## 三、设计

### 3.1 文件格式（裁定）

```
magic   = b"LVEC"          4B
version : u32 (LE)         缓存格式版本（与 crate 版本无关，本格式改了才 +1）
dim     : u32 (LE)         = crate::embed::EMBED_DIM（当前 384）
backend : u32 (LE) len + bytes    = crate::embed::backend_id()（"minilm" / "ngram-hash" 一族）
count   : u32 (LE)
entries : count × { u64 hash(LE) + dim × f32(LE) }
```

**为什么必须带 backend**：`embed()` / `embed_batch()` **每次调用都可能翻后端**
（MiniLM 推理失败即回退 n-gram，[embed.rs:15-52](../../hologram-vector/src/embed.rs)）。
MiniLM 向量与 n-gram 向量**不在同一空间**，混用 = 语义搜索静默变垃圾。
既有 `slots.json` 已经是同一纪律的先例（写 `dim` + `model`，load 时不匹配就拒用并 warn，
[index.rs:225-230](../../hologram-vector/src/index.rs)）——**照抄这个模式，别发明新的**。

**哈希强度**：`snippet_hash` = `DefaultHasher`（64 位 SipHash）。22k 条目碰撞概率 ~1e-11，可接受；
真要消掉概率就得存原文（34MB → 100MB+），不值。

### 3.2 读写时机（裁定）

- **读**：`build()` 开头、**进 `VECTOR_CACHE` 锁之前**：把磁盘缓存**只补空缺**地灌进进程内缓存。
  优先级 = `进程内缓存（最新） > 磁盘缓存 > 推理`。进程内已有键不覆盖。
- **写**：`build()` 末尾、推理全部完成之后，写**本轮 `vectors` 全量**（含进程内命中的那些）。
  ⇒ 文件恒等于「当前索引的向量表」：节点删了就自然消失，无需 GC，也不会无限增长。
- **失败面**：写失败 = warn（缓存是优化不是数据，不 fail build）；读失败/损坏/截断 = warn + 空缓存
  （不 panic、不阻断 build）——「错误不静默」但不「错误致命」。

### 3.3 被否的方案（写明理由，防下一轮重开）

| 方案 | 否掉的理由 |
|---|---|
| 复用 `vectors.usearch` 当向量库，只落一份 `node_id → hash` 小 sidecar | 省 34MB，但要：读旧索引 + 旧 slots + 旧 node 表、自建 id→slot→向量映射、并让**增量路径**同步维护 sidecar。多一套「索引与 sidecar 版本错位」的失败面，换 34MB 不值得 |
| 缓存塞进 `hologram.db`（SQLite 表） | db 是**图真源**，派生数据混进去会破坏「删缓存不丢数据」的直觉；还要过 storage 层事务/WAL，成本高于收益 |
| mtime / 文件级失效 | 键已是**内容**哈希，mtime 只会造成无谓重嵌 |
| 跨项目共享缓存池 | snippet 哈希跨项目会撞（同名函数、通用样板），收益不明、风险实在 |

## 四、施工面

| 文件 | 改动 |
|---|---|
| `hologram-vector/src/index.rs` | 新增私有 `embed_cache` 模块（`save` / `load` / 头部校验）；`build()` 头尾各接一次；`build` 加**可观测计数**（见 §5.1） |
| `hologram-vector/src/lib.rs` | （可选）暴露命中率读数给 `ops(status)`——**本件默认不做**（避免动引擎契约面；真要做得单独立项） |
| `engine/src/engine/pipeline.rs` | 无改动（`build()` 调用点不变） |
| `engine/src/path_utils.rs` | **无需改**：`vectors.embed.cache` 是新名字，不在历史搬迁清单里（老项目里本来就不会有这个文件） |

## 五、验收（可执行）

### 5.1 单测（`hologram-vector`）
1. **round-trip**：`save` → `load`，两边 map 相等。
2. **头部不匹配**：分别改 `dim` / `backend` / `version` ⇒ `load` 返回空 + warn（不是 Err 炸链路）。
3. **截断/魔数错** ⇒ 空 + warn，**不 panic**（v1 数据文件必须容忍毒化，INVARIANTS #11 同族纪律）。
4. **第二次 build 不再推理**（本件的核心断言）：用 **n-gram 后端**（无模型依赖，结果确定）建 3 个节点
   → `build` → 清空进程内 `VECTOR_CACHE`（需要测试专用 reset 口）→ 再 `build` ⇒ 断言**未命中数 = 0**。
   ⚠ 这要求 `build()` 有**可观测面**（返回结构体或 `last_build_stats()`），**别用日志断言**。

### 5.2 真机实测
- 22k 节点项目连跑两次，**第二次前重启引擎** ⇒ 第二次 `build` 墙钟 **< 1 分钟**（对照基线 13.7 分钟）；
  `ops(status)` 的 `vector_index.vectors` 与 `nodes` 一致（`stale = false`）。

### 5.3 门禁
`cd engine && cargo test` · `cd hologram-vector && cargo test` · 若动了生成物另跑 `npm run doc-sync`。
**不改引擎契约面**（不动 `engine/src/tools/**`）⇒ 无需升 `ENGINE_CONTRACT_VERSION`。

## 六、非目标
- 不做嵌入模型的更换/量化（那是另一条线）。
- 不做缓存命中率的**用户可见**读数（本件只保证行为；要暴露再单独立项，避免顺手扩契约面）。
- 不解决「首次分析仍然慢」——首次本来就必须推理，本件只消除**重复**推理。
