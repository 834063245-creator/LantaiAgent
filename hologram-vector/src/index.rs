// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 代码向量索引 —— 嵌入函数/类源码片段，存储到 HNSW 索引中，提供语义搜索。
//
// 本文件原为 engine/src/vector/mod.rs，L2 crate 化时物理拆出为独立 crate
// hologram-vector（纯计算层；lib.rs 声明 mod index 后再导出）。
//
// 嵌入后端（embed.rs 自动选择）：
//   1. MiniLM（minilm.rs）—— sentence-transformers/all-MiniLM-L6-v2（ONNX，384 维），
//      经 ort crate 动态加载项目自带 onnxruntime.dll，语义区分度高。
//   2. n-gram 哈希（embed.rs::ngram_embed）—— 零依赖兜底，词法相似性。
// 索引文件带嵌入后端标识（slots.json 的 model 字段），后端切换后旧索引
// 自动判废（load 返回 0），需重新分析重建。
// 嵌入/词元/ONNX 子模块（embed/minilm/wordpiece）的 mod 声明在 lib.rs
// （crate 根子模块），本文件只保留索引本体。

use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use tracing::{info, warn};

use hologram_graph::{Node, NodeKind};

pub const VECTOR_DIM: usize = crate::embed::EMBED_DIM;

// ═══════════════════════════════════════════════════════════════
// CodeVectorIndex
// ═══════════════════════════════════════════════════════════════

/// 一次向量重建的读数（2026-10-28 嵌入缓存持久化批新增）。
///
/// 存在的唯一理由：单测要断言「重启后第二次 build 不再推理」（misses = 0），
/// 而设计件明确禁止用日志断言（docs/plans/embedding-cache-persistence-design.md §5.1）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BuildStats {
    /// 本轮节点数。
    pub total: usize,
    /// 进程内缓存命中（VECTOR_CACHE）。
    pub cache_hits: usize,
    /// 仅靠磁盘缓存补上的条数（进程内原本没有）。
    pub disk_hits: usize,
    /// 真正走推理的条数。
    pub misses: usize,
    /// 写入 usearch 的条数（= total，除非中途出错）。
    pub indexed: usize,
}

pub struct CodeVectorIndex {
    index: Arc<RwLock<Option<usearch::Index>>>,
    slots: Arc<RwLock<Vec<String>>>,
    path: PathBuf,
}

impl CodeVectorIndex {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            index: Arc::new(RwLock::new(None)),
            slots: Arc::new(RwLock::new(Vec::new())),
            path: path.into(),
        }
    }

    fn ensure_index(&self, capacity: usize) -> Result<(), String> {
        if self.index.read().unwrap_or_else(|e| e.into_inner()).is_some() { return Ok(()); }
        let options = usearch::IndexOptions {
            dimensions: VECTOR_DIM,
            metric: usearch::MetricKind::Cos,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        };
        let idx = usearch::Index::new(&options)
            .map_err(|e| format!("usearch index creation failed: {e}"))?;
        idx.reserve(capacity.max(1))
            .map_err(|e| format!("usearch reserve failed: {e}"))?;
        *self.index.write().unwrap_or_else(|e| e.into_inner()) = Some(idx);
        Ok(())
    }

    /// 从图节点构建向量索引（返回写入 usearch 的条数——保持既有调用面不变）。
    pub fn build(&self, nodes: &[Node]) -> Result<usize, String> {
        Ok(self.build_with_stats(nodes)?.indexed)
    }

    /// 同 [`build`](Self::build)，另返回读数（缓存命中/磁盘补入/未命中）。
    pub fn build_with_stats(&self, nodes: &[Node]) -> Result<BuildStats, String> {
        // 全量重建语义：本实例可能已被 build 过。usearch 的 high-level wrapper
        // **不允许重复键**（同 slot 二次 add 直接报错），所以先把旧索引丢掉重建。
        // 2026-10-28 由「重启后零推理」测试暴露（此前生产调用点每次都新建实例，
        // 故从未显形——藏着「同一实例二次重建必炸」的死路）。
        *self.index.write().unwrap_or_else(|e| e.into_inner()) = None;
        self.ensure_index(nodes.len())?;
        // 预留容量（始终执行，即使索引已初始化）
        if let Some(ref idx) = *self.index.read().unwrap_or_else(|e| e.into_inner()) {
            idx.reserve(nodes.len().max(1))
                .map_err(|e| format!("usearch reserve failed: {e}"))?;
        }

        let mut node_ids = Vec::with_capacity(nodes.len());
        let mut snippets = Vec::with_capacity(nodes.len());
        for node in nodes {
            let text = match &node.snippet {
                Some(s) if !s.trim().is_empty() => s.clone(),
                _ => format!("{} {}", node.kind.as_str(), node.name),
            };
            node_ids.push(node.id.clone());
            snippets.push(text);
        }

        if snippets.is_empty() { warn!("[vector] 无节点可嵌入"); return Ok(BuildStats::default()); }

        let total = snippets.len();
        info!("[vector] 正在嵌入 {} 个节点（{}, {} 维）...", total, crate::embed::backend_id(), VECTOR_DIM);

        // 进程级向量缓存：watcher 每次文件保存都会触发全量 build()，
        // 未变更节点按 snippet 内容哈希直接命中，只有新增/变更节点真正走推理。
        let hashes: Vec<u64> = snippets.iter().map(|s| snippet_hash(s)).collect();
        let mut vectors: Vec<Option<Arc<Vec<f32>>>> = (0..total).map(|_| None).collect();
        let mut misses: Vec<usize> = Vec::new();

        // 磁盘缓存先读（**锁外**做 IO——CONVENTIONS §2.3 锁内不阻塞 IO）。
        // 优先级：进程内（最新）> 磁盘（跨进程存活）> 推理。
        let disk = self.read_disk_cache();
        let mut cache_hits = 0usize;
        let mut disk_hits = 0usize;
        {
            let mut cache = VECTOR_CACHE.lock().map_err(|e| format!("vector cache lock: {e}"))?;
            for (i, h) in hashes.iter().enumerate() {
                if let Some(v) = cache.get(h).cloned() {
                    vectors[i] = Some(v);
                    cache_hits += 1;
                    continue;
                }
                if let Some(v) = disk.get(h).cloned() {
                    vectors[i] = Some(v.clone());
                    cache.insert(*h, v);
                    disk_hits += 1;
                    continue;
                }
                misses.push(i);
            }
            // 磁盘里本轮没用到的键也一并补进进程缓存：下次 watcher 触发即可直接命中。
            for (h, v) in disk {
                cache.entry(h).or_insert(v);
            }
        }

        // 顺序 batch 推理（不再 par_iter：共享 session 的 Mutex 实测负加速 0.63x，
        // 且堵满 rayon 全局池会饿死解析/dataflow 任务 —— 见 minilm.rs::embed_batch）
        if !misses.is_empty() {
            info!("[vector] {} 个节点待嵌入（{} 个命中缓存）", misses.len(), total - misses.len());
            // 按长度排序分桶：batch 内 padding 对齐到最长样本，长度相近的样本同批
            // 可显著减少填充浪费（文件头 5 行 vs 函数体 30 行混在一起时差 6 倍）
            misses.sort_by_key(|&i| snippets[i].len());
        }
        let mut embedded: Vec<(u64, Arc<Vec<f32>>)> = Vec::new();
        for (n_done, chunk) in misses.chunks(256).enumerate() {
            let batch: Vec<&str> = chunk.iter().map(|&i| snippets[i].as_str()).collect();
            let vecs = crate::embed::embed_batch(&batch);
            for (&i, v) in chunk.iter().zip(vecs) {
                let v = Arc::new(v);
                vectors[i] = Some(v.clone());
                embedded.push((hashes[i], v));
            }
            let done = (n_done + 1) * 256;
            if done % 1024 < 256 && done < misses.len() {
                info!("[vector] embedded {}/{} nodes", done, misses.len());
            }
        }
        if !embedded.is_empty() {
            let mut cache = VECTOR_CACHE.lock().map_err(|e| format!("vector cache lock: {e}"))?;
            for (h, v) in embedded { cache.insert(h, v); }
        }

        let mut slot = 0usize;
        let mut slots = self.slots.write().unwrap_or_else(|e| e.into_inner());
        let mut index = self.index.write().unwrap_or_else(|e| e.into_inner());
        let index = index.as_mut().ok_or("index not initialized")?;

        slots.clear();
        slots.reserve(total);

        for (i, vec) in vectors.iter().enumerate() {
            let vec = vec.as_ref().expect("所有 snippet 均已嵌入");
            index.add(slot as u64, vec)
                .map_err(|e| format!("usearch add failed: {e}"))?;
            slots.push(node_ids[i].as_str().to_owned());
            slot += 1;
        }

        info!("[vector] 已索引 {} 个节点", slots.len());

        // 磁盘缓存：只在本轮**真有新嵌入**时写。内容与盘上一致时重写 34MB 是纯浪费；
        // 节点增删后的收敛由下一次 miss 触发的「全量重写」完成（文件因此恒等于
        // 「当前索引见过的最新向量表」，只增不减的窗口会在下次 miss 时收拢）。
        if !misses.is_empty() {
            let pairs: Vec<(u64, Arc<Vec<f32>>)> = hashes
                .iter()
                .zip(vectors.iter())
                .filter_map(|(h, v)| v.as_ref().map(|v| (*h, v.clone())))
                .collect();
            self.persist_embed_cache(&pairs);
        }

        let indexed = slots.len();
        Ok(BuildStats { total, cache_hits, disk_hits, misses: misses.len(), indexed })
    }

    /// 搜索。返回排序后的 (node_id, 相似度) 对。
    pub fn search(&self, query: &str, top_k: usize) -> Result<Vec<(String, f32)>, String> {
        let q_vec = crate::embed::embed(query);

        let index = self.index.read().unwrap_or_else(|e| e.into_inner());
        let index = index.as_ref().ok_or("index not initialized")?;
        let slots = self.slots.read().unwrap_or_else(|e| e.into_inner());

        if slots.is_empty() { return Ok(vec![]); }

        let results = index.search(&q_vec, top_k)
            .map_err(|e| format!("usearch search failed: {e}"))?;

        let mut output = Vec::with_capacity(results.keys.len());
        for (slot_key, distance) in results.keys.iter().zip(results.distances.iter()) {
            let slot = *slot_key as usize;
            if slot < slots.len() {
                let similarity = 1.0 - (*distance).min(2.0).max(0.0);
                output.push((slots[slot].clone(), similarity));
            }
        }
        Ok(output)
    }

    /// 原子落盘：先写临时文件再 rename，崩溃不会留下 index/slots 不一致的半成品。
    pub fn save(&self) -> Result<(), String> {
        let index = self.index.read().unwrap_or_else(|e| e.into_inner());
        let index = index.as_ref().ok_or("index not initialized")?;

        // 1. 索引 → tmp → rename
        let tmp_index = self.path.with_extension("usearch.tmp");
        let tmp_str = tmp_index.to_str().ok_or("non-UTF8 path")?;
        index.save(tmp_str).map_err(|e| format!("usearch save: {e}"))?;
        rename_with_retry(&tmp_index, &self.path)
            .map_err(|e| format!("usearch rename: {e}"))?;
        info!("[vector] 索引已保存到 {}", self.path.display());

        // 2. slots（含嵌入后端标识）→ tmp → rename
        let slot_path = self.path.with_extension("slots.json");
        let tmp_slot = self.path.with_extension("slots.json.tmp");
        let slots = self.slots.read().unwrap_or_else(|e| e.into_inner());
        let data = serde_json::json!({
            "slots": *slots,
            "dim": VECTOR_DIM,
            "model": crate::embed::backend_id(),
        });
        let json_str = serde_json::to_string(&data)
            .map_err(|e| format!("slot serialize: {e}"))?;
        std::fs::write(&tmp_slot, json_str)
            .map_err(|e| format!("slot save: {e}"))?;
        rename_with_retry(&tmp_slot, &slot_path)
            .map_err(|e| format!("slot rename: {e}"))?;
        Ok(())
    }

    pub fn load(&self) -> Result<usize, String> {
        let path_str = self.path.to_str().ok_or("non-UTF8 path")?;
        if !self.path.exists() { return Ok(0); }

        let idx = usearch::Index::restore(path_str)
            .map_err(|e| format!("usearch restore: {e}"))?;

        let slot_path = self.path.with_extension("slots.json");
        if !slot_path.exists() {
            warn!("[vector] slots.json 缺失，索引不可用（需重新分析）");
            return Ok(0);
        }
        let data: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&slot_path).map_err(|e| format!("read slots: {e}"))?
        ).map_err(|e| format!("parse slots: {e}"))?;

        // 嵌入空间校验：索引的嵌入后端必须与当前激活后端一致，
        // 否则查询向量与索引向量不在同一空间，结果全是垃圾（静默错误）。
        let saved_model = data["model"].as_str().unwrap_or("ngram-hash"); // 旧索引无此字段 → n-gram
        let active = crate::embed::backend_id();
        if saved_model != active {
            warn!("[vector] 索引嵌入后端不匹配（索引={saved_model}, 当前={active}），跳过向量搜索直至重新分析");
            return Ok(0);
        }

        let loaded: Vec<String> = data["slots"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        // 一致性校验：slots 数必须与索引内向量数一致，否则 slot 映射错位
        let index_size = idx.size();
        if loaded.len() != index_size {
            warn!("[vector] 索引/slots 不一致（index={index_size}, slots={}），索引不可用（需重新分析）", loaded.len());
            return Ok(0);
        }

        *self.slots.write().unwrap_or_else(|e| e.into_inner()) = loaded;

        let count = self.slots.read().unwrap_or_else(|e| e.into_inner()).len();
        *self.index.write().unwrap_or_else(|e| e.into_inner()) = Some(idx);
        info!("[vector] 已加载索引: {} 个向量", count);
        Ok(count)
    }

    pub fn exists_on_disk(&self) -> bool { self.path.exists() }

    // ── 磁盘嵌入缓存（2026-10-28）──
    //
    // 病灶：VECTOR_CACHE 是进程级 static，进程一死就归零 —— 实测跨重启命中率 2%，
    // 22k 节点全量重建 13.7 分钟（docs/plans/embedding-cache-persistence-design.md）。
    // 文件 = 本轮 build 见到的全量 (snippet_hash → 向量)，键是**内容**哈希，
    // 与路径/mtime/node id 全无关；容量天然有界，不需要 LRU/GC。
    // 纪律照抄 slots.json：头部带 dim + backend，任一不匹配 ⇒ 整份丢弃（fail-open 重嵌入）。
    // **缓存是优化不是数据**：读写失败一律 warn，绝不阻断 build（错误可见，但不致命）。
    fn embed_cache_path(&self) -> PathBuf {
        self.path.with_extension("embed.cache")
    }

    /// 读磁盘缓存；任何异常（缺失/损坏/版本或后端不匹配）⇒ 空表 + warn。
    fn read_disk_cache(&self) -> std::collections::HashMap<u64, Arc<Vec<f32>>> {
        let path = self.embed_cache_path();
        if !path.exists() { return std::collections::HashMap::new(); }
        match read_embed_cache(&path) {
            Ok(map) => {
                info!("[vector] 嵌入缓存命中 {} 条（{}）", map.len(), path.display());
                map
            }
            Err(e) => {
                warn!("[vector] 嵌入缓存不可用（{e}），本轮按空缓存处理");
                std::collections::HashMap::new()
            }
        }
    }

    /// 原子落盘（`.tmp` → rename_with_retry，与索引/slots 同一套原语）。
    fn persist_embed_cache(&self, pairs: &[(u64, Arc<Vec<f32>>)]) {
        let path = self.embed_cache_path();
        match write_embed_cache(&path, pairs) {
            Ok(()) => info!("[vector] 嵌入缓存已保存 {} 条 → {}", pairs.len(), path.display()),
            Err(e) => warn!("[vector] 嵌入缓存保存失败（{e}）——不影响索引可用性"),
        }
    }
}

// ── 进程级向量缓存：snippet 内容哈希 → 嵌入向量 ──
// 增量重建（watcher 每次文件保存触发）都对全量节点调 build()；缓存让未变更
// 节点免于重新推理，只有新增/变更节点真正走 MiniLM。5258 节点约占 8MB 内存。
static VECTOR_CACHE: LazyLock<Mutex<std::collections::HashMap<u64, Arc<Vec<f32>>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// snippet 内容哈希（向量缓存键）。只需同一进程内一致，DefaultHasher 足够。
/// 带重试的 rename：Windows 上多个引擎进程共用同一数据目录时，
/// 目标文件可能正被另一个进程短暂占用（os error 5 共享冲突），
/// 等一拍再试通常就能过（2026-09-09 事故：增量重建 ×7 落盘失败，
/// usearch/slots 索引没能更新）。
fn rename_with_retry(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 3;
    const RETRY_DELAY_MS: u64 = 400;
    let mut last_err = None;
    for attempt in 0..ATTEMPTS {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if attempt + 1 < ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
                }
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "rename_with_retry: no attempt made")
    }))
}

fn snippet_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

// ── 磁盘嵌入缓存格式（LVEC v1）──
// magic | version u32 | dim u32 | backend(len u32 + bytes) | count u32 | count × {hash u64 + dim × f32}
// 二进制单文件：22k 节点 ≈ 34MB，比 JSON 小一个量级（f32 直接落字节，不做文本化）。
const EMBED_CACHE_MAGIC: [u8; 4] = *b"LVEC";
/// 缓存格式版本——**与 crate 版本无关**，只有本格式改了才 +1。
const EMBED_CACHE_VERSION: u32 = 1;

fn take<'a>(bytes: &'a [u8], off: &mut usize, n: usize) -> Result<&'a [u8], String> {
    let end = off.checked_add(n).ok_or_else(|| "offset overflow".to_string())?;
    if end > bytes.len() {
        return Err(format!("truncated at {off} (+{n}, len {})", bytes.len()));
    }
    let s = &bytes[*off..end];
    *off = end;
    Ok(s)
}

fn take_u32(bytes: &[u8], off: &mut usize) -> Result<u32, String> {
    let b = take(bytes, off, 4)?;
    let arr: [u8; 4] = b.try_into().map_err(|_| "u32 slice".to_string())?;
    Ok(u32::from_le_bytes(arr))
}

/// 读缓存文件。**任何异常都返回 Err（调用方降级为空表），绝不 panic**——
/// 缓存文件是"可以被外部改坏"的输入，毒化必须容忍（INVARIANTS #11 同族纪律）。
fn read_embed_cache(
    path: &std::path::Path,
) -> Result<std::collections::HashMap<u64, Arc<Vec<f32>>>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    let mut off = 0usize;

    if take(&bytes, &mut off, 4)? != EMBED_CACHE_MAGIC {
        return Err("bad magic".to_string());
    }
    let version = take_u32(&bytes, &mut off)?;
    if version != EMBED_CACHE_VERSION {
        return Err(format!("version {version} != {EMBED_CACHE_VERSION}"));
    }
    let dim = take_u32(&bytes, &mut off)? as usize;
    if dim != VECTOR_DIM {
        return Err(format!("dim {dim} != {VECTOR_DIM}"));
    }
    let backend_len = take_u32(&bytes, &mut off)? as usize;
    let backend_bytes = take(&bytes, &mut off, backend_len)?;
    let backend = std::str::from_utf8(backend_bytes).map_err(|e| format!("backend utf8: {e}"))?;
    let active = crate::embed::backend_id();
    if backend != active {
        // MiniLM 与 n-gram 向量不在同一空间，混用 = 语义搜索静默变垃圾。
        return Err(format!("backend {backend} != {active}"));
    }

    let count = take_u32(&bytes, &mut off)? as usize;
    let entry_len = 8 + dim * 4;
    let remaining = bytes.len().saturating_sub(off);
    if remaining != count.saturating_mul(entry_len) {
        return Err(format!("payload {remaining} != count {count} × {entry_len}"));
    }

    let mut map = std::collections::HashMap::with_capacity(count);
    for _ in 0..count {
        let hash_bytes = take(&bytes, &mut off, 8)?;
        let hash_arr: [u8; 8] = hash_bytes.try_into().map_err(|_| "hash slice".to_string())?;
        let mut vec = Vec::with_capacity(dim);
        for _ in 0..dim {
            let f = take(&bytes, &mut off, 4)?;
            let arr: [u8; 4] = f.try_into().map_err(|_| "f32 slice".to_string())?;
            vec.push(f32::from_le_bytes(arr));
        }
        map.insert(u64::from_le_bytes(hash_arr), Arc::new(vec));
    }
    Ok(map)
}

fn write_embed_cache(
    path: &std::path::Path,
    entries: &[(u64, Arc<Vec<f32>>)],
) -> Result<(), String> {
    let backend = crate::embed::backend_id();
    let mut buf: Vec<u8> =
        Vec::with_capacity(16 + backend.len() + 4 + entries.len() * (8 + VECTOR_DIM * 4));
    buf.extend_from_slice(&EMBED_CACHE_MAGIC);
    buf.extend_from_slice(&EMBED_CACHE_VERSION.to_le_bytes());
    buf.extend_from_slice(&(VECTOR_DIM as u32).to_le_bytes());
    buf.extend_from_slice(&(backend.len() as u32).to_le_bytes());
    buf.extend_from_slice(backend.as_bytes());
    buf.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (hash, vec) in entries {
        if vec.len() != VECTOR_DIM {
            return Err(format!("vector dim {} != {VECTOR_DIM}", vec.len()));
        }
        buf.extend_from_slice(&hash.to_le_bytes());
        for f in vec.iter() {
            buf.extend_from_slice(&f.to_le_bytes());
        }
    }
    let tmp = path.with_extension("embed.cache.tmp");
    std::fs::write(&tmp, &buf).map_err(|e| format!("write tmp: {e}"))?;
    rename_with_retry(&tmp, path).map_err(|e| format!("rename: {e}"))
}

/// 清空进程级向量缓存（**测试专用**：模拟「进程重启后的冷缓存」）。
#[cfg(test)]
pub fn clear_process_vector_cache() {
    if let Ok(mut cache) = VECTOR_CACHE.lock() {
        cache.clear();
    }
}

// ── 进程级缓存：加载的向量索引在搜索间复用 ──
// 缓存条目附带加载时索引文件的 mtime；mtime 变化（重新分析/增量重建）→ 自动失效重载。
// L4：**按根键控**——旧单槽 Option 在双工作区并行下互踩（A 加载后 B 覆盖，
// A 的后续语义搜索用 B 的索引+错位 id 表）。VECTOR_CACHE（snippet 哈希→向量）
// 本就跨根安全（内容键），保持进程级共享。
static CACHED_INDEX: LazyLock<Mutex<std::collections::HashMap<PathBuf, CachedIndex>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

struct CachedIndex {
    vi: CodeVectorIndex,
    mtime: Option<std::time::SystemTime>,
}

fn index_mtime(path: &std::path::Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// 获取或创建给定项目根目录的缓存 CodeVectorIndex（按根键控）。
/// 首次访问时从磁盘加载；索引文件 mtime 变化时自动重载。
pub fn get_or_load_index(project_root: &std::path::Path) -> Result<(Arc<RwLock<Option<usearch::Index>>>, Arc<RwLock<Vec<String>>>), String> {
    let path = hologram_graph::data_dir(project_root).join("vectors.usearch");
    let current_mtime = index_mtime(&path);
    let mut cache = CACHED_INDEX.lock().map_err(|e| format!("vector cache lock: {e}"))?;

    let stale = match cache.get(&path) {
        None => true,
        Some(c) => c.mtime != current_mtime,
    };
    if stale {
        let vi = CodeVectorIndex::new(&path);
        if vi.exists_on_disk() {
            vi.load()?;
        }
        cache.insert(path.clone(), CachedIndex { vi, mtime: current_mtime });
    }
    let c = cache.get(&path).expect("索引缓存必已填充");
    Ok((c.vi.index.clone(), c.vi.slots.clone()))
}

/// 重建完成后显式失效该根的缓存（下次搜索重新加载磁盘上的新索引）。
/// L4 起按根失效——B 工作区重建不得误伤 A 的热缓存。
pub fn invalidate_cache(project_root: &std::path::Path) {
    if let Ok(mut cache) = CACHED_INDEX.lock() {
        cache.remove(&hologram_graph::data_dir(project_root).join("vectors.usearch"));
    }
}

// ── 重建并发守卫：全量/增量重建共用，防止两个线程同时写同一索引文件 ──
// L4：按根防重入（全局布尔会让并行双工作区的重建互相跳过）。
static BUILD_RUNNING: LazyLock<Mutex<std::collections::HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// 尝试开始一次向量索引重建（按索引文件路径防重入）；
/// 该索引已有重建在进行时返回 false（调用方应跳过本轮）。
pub fn try_begin_build(index_path: &std::path::Path) -> bool {
    match BUILD_RUNNING.lock() {
        Ok(mut set) => set.insert(index_path.to_path_buf()),
        Err(_) => false, // 锁中毒 = 保守拒绝
    }
}

/// 结束重建（必须与 try_begin_build 配对）。
pub fn end_build(index_path: &std::path::Path) {
    if let Ok(mut set) = BUILD_RUNNING.lock() {
        set.remove(index_path);
    }
}

/// 过滤向量命中：输入须按相似度降序。
/// 低于阈值丢弃（降序输入可提前终止）、与已有结果去重、命中内去重、最多 max_hits 条。
/// 引擎 handler 与 Tauri search 共用同一套策略。
pub fn filter_hits(
    raw: &[(String, f32)],
    threshold: f32,
    max_hits: usize,
    existing: &std::collections::HashSet<&str>,
) -> Vec<(String, f32)> {
    let mut hits: Vec<(String, f32)> = Vec::with_capacity(max_hits);
    for (id, score) in raw {
        if *score < threshold { break; }
        if existing.contains(id.as_str()) { continue; }
        if hits.iter().any(|(h, _)| h == id) { continue; }
        hits.push((id.clone(), *score));
        if hits.len() >= max_hits { break; }
    }
    hits
}

/// 从文件内容中提取节点的源码片段。
pub fn extract_snippet(source: &str, node_name: &str, node_kind: &NodeKind) -> Option<String> {
    if matches!(node_kind, NodeKind::File) {
        let lines: Vec<&str> = source.lines().take(5).collect();
        return Some(lines.join("\n"));
    }

    // 字节级子串搜索（memchr 加速），命中后按 \n 计数推行号。
    // 旧实现逐行 contains + 命中后全量 collect 所有行，每节点 O(文件大小)
    // 且伴随全文件行 Vec 分配 —— 155k 节点时是不可忽视的分配风暴。
    if let Some(byte_pos) = source.find(node_name) {
        let line_num = source.as_bytes()[..byte_pos].iter().filter(|&&b| b == b'\n').count();
        let start = line_num.saturating_sub(1);
        let window: Vec<&str> = source.lines().skip(start).take(30).collect();
        return Some(window.join("\n"));
    }
    Some(format!("{} {}", node_kind.as_str(), node_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rename_with_retry：正常改名一次过；源不存在时报错不 panic
    ///（多引擎共用目录的占用重试是 2026-09-09 事故的落盘修复）。
    #[test]
    fn test_rename_with_retry() {
        let tmp = std::env::temp_dir().join(format!("hologram_vi_rename_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let src = tmp.join("a.tmp");
        let dst = tmp.join("a.bin");
        let _ = std::fs::remove_file(&dst);
        std::fs::write(&src, b"x").unwrap();
        assert!(rename_with_retry(&src, &dst).is_ok());
        assert!(dst.exists() && !src.exists(), "rename should move the file");
        assert!(
            rename_with_retry(&tmp.join("no-such.tmp"), &dst).is_err(),
            "missing source must surface the io error"
        );
        let _ = std::fs::remove_file(&dst);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 后端不匹配的索引必须判废（load 返回 0），防止跨嵌入空间的垃圾结果
    #[test]
    fn test_load_rejects_backend_mismatch() {
        let tmp = std::env::temp_dir().join(format!("hologram_vi_mismatch_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let idx_path = tmp.join("vectors.usearch");

        let vi = CodeVectorIndex::new(&idx_path);
        let mut n1 = Node::new("n1", "handle_payment", NodeKind::Function);
        n1.snippet = Some("fn handle_payment(amount: f64) -> Result<Receipt> { charge(amount) }".into());
        vi.build(&[n1]).unwrap();
        vi.save().unwrap();

        // 原子落盘：不应残留临时文件
        assert!(!tmp.join("vectors.usearch.tmp").exists());
        assert!(!tmp.join("vectors.slots.json.tmp").exists());

        // 篡改 slots.json 的后端标识 → load 应判废
        let slot_path = idx_path.with_extension("slots.json");
        let data = std::fs::read_to_string(&slot_path).unwrap();
        let tampered = data.replace(crate::embed::backend_id(), "bogus-backend");
        assert!(tampered != data, "slots.json 应包含当前后端标识");
        std::fs::write(&slot_path, tampered).unwrap();

        let vi2 = CodeVectorIndex::new(&idx_path);
        assert_eq!(vi2.load().unwrap(), 0, "后端不匹配的索引必须判废");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// slots 数与索引向量数不一致时必须判废（防止 slot 映射静默错位）
    #[test]
    fn test_load_rejects_size_mismatch() {
        let tmp = std::env::temp_dir().join(format!("hologram_vi_size_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let idx_path = tmp.join("vectors.usearch");

        let vi = CodeVectorIndex::new(&idx_path);
        let nodes: Vec<Node> = (0..3).map(|i| {
            let mut n = Node::new(&format!("n{i}"), &format!("func_{i}"), NodeKind::Function);
            n.snippet = Some(format!("fn func_{i}() {{ do_work({i}); }}"));
            n
        }).collect();
        vi.build(&nodes).unwrap();
        vi.save().unwrap();

        // 删掉一个 slot → 数量不一致
        let slot_path = idx_path.with_extension("slots.json");
        let mut data: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&slot_path).unwrap()
        ).unwrap();
        data["slots"].as_array_mut().unwrap().pop();
        std::fs::write(&slot_path, serde_json::to_string(&data).unwrap()).unwrap();

        let vi2 = CodeVectorIndex::new(&idx_path);
        assert_eq!(vi2.load().unwrap(), 0, "slots/index 数量不一致必须判废");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 索引文件重建（mtime 变化）后，进程级缓存必须自动失效并重载
    #[test]
    fn test_cache_invalidates_on_index_update() {
        let root = std::env::temp_dir().join(format!("hologram_vi_cache_{}", std::process::id()));
        let dir = hologram_graph::data_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        let idx_path = dir.join("vectors.usearch");

        // 首次：索引不存在 → 空缓存
        let (_, slots) = get_or_load_index(&root).unwrap();
        assert!(slots.read().unwrap().is_empty());

        // 构建并保存索引（文件出现，mtime 变化）
        let vi = CodeVectorIndex::new(&idx_path);
        let mut n1 = Node::new("n1", "handle_payment", NodeKind::Function);
        n1.snippet = Some("fn handle_payment(amount: f64) -> Result<Receipt> { charge(amount) }".into());
        vi.build(&[n1]).unwrap();
        vi.save().unwrap();

        // 再次获取：必须看到新索引，而不是旧的空缓存
        let (_, slots2) = get_or_load_index(&root).unwrap();
        assert_eq!(slots2.read().unwrap().len(), 1, "索引重建后缓存必须自动失效重载");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 命中过滤：阈值截断、与已有结果去重、命中内去重、条数上限
    #[test]
    fn test_filter_hits() {
        let raw: Vec<(String, f32)> = vec![
            ("a".into(), 0.60),
            ("b".into(), 0.55),
            ("b".into(), 0.54), // 与 b 重复
            ("c".into(), 0.40),
            ("d".into(), 0.30), // 低于阈值（其后不再扫描）
            ("e".into(), 0.25),
        ];
        let mut existing = std::collections::HashSet::new();
        existing.insert("a");

        let hits = filter_hits(&raw, 0.35, 5, &existing);
        assert_eq!(hits, vec![("b".to_string(), 0.55), ("c".to_string(), 0.40)]);

        // 上限生效（a 不在 existing 时排第一）
        let capped = filter_hits(&raw, 0.35, 1, &std::collections::HashSet::new());
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].0, "a");

        // 全低于阈值 → 空
        assert!(filter_hits(&raw, 0.99, 5, &std::collections::HashSet::new()).is_empty());
    }

    #[test]
    fn test_extract_snippet() {
        let source = "import os\n\ndef hello_world():\n    print('hello')\n    return 42\n";
        let s = extract_snippet(source, "hello_world", &NodeKind::Function).unwrap();
        assert!(s.contains("hello_world"));
    }

    #[test]
    fn test_real_generated_index() {
        // 验证 tauri dev 期间构建的向量索引确实可用
        let path = "D:/HoloGramHG/.hologram/vectors.usearch";
        if !std::path::Path::new(path).exists() {
            eprintln!("跳过: 未找到 {path} —— 请先运行 analyze");
            return;
        }
        let vi = CodeVectorIndex::new(path);
        let n = vi.load().unwrap();
        eprintln!("从 {path} 加载了 {n} 个向量 (backend: {})", crate::embed::backend_id());
        if n == 0 {
            // 索引与当前嵌入后端不匹配（如旧 n-gram 索引）——需要重新分析
            eprintln!("跳过: 索引不可用或与当前嵌入后端不匹配，请重新运行 analyze");
            return;
        }

        // 对真实 HoloGram 代码库进行搜索测试
        let tests = [
            ("payment processing", "Should find payment/transaction related code"),
            ("window button minimize", "Should find window control UI code"),
            ("graph community layout", "Should find graph/community detection code"),
        ];
        for (query, desc) in &tests {
            let results = vi.search(query, 5).unwrap();
            eprintln!("\n--- {desc} ---");
            eprintln!("  query: \"{query}\"");
            for (id, score) in &results {
                eprintln!("  {:.2}  {id}", score);
            }
            assert!(!results.is_empty(), "搜索 '{query}' 应返回结果");
        }
    }

    #[test]
    fn test_vector_index_build_search() {
        let tmp = std::env::temp_dir().join("hologram_vi_test");
        let _ = std::fs::create_dir_all(&tmp);
        let idx_path = tmp.join("test_vectors.usearch");

        let vi = CodeVectorIndex::new(&idx_path);

        let mut n1 = Node::new("n1", "handle_payment", NodeKind::Function);
        n1.snippet = Some("fn handle_payment(amount: f64) -> Result<Receipt, Error> { process(amount) }".into());
        let mut n2 = Node::new("n2", "render_ui", NodeKind::Function);
        n2.snippet = Some("fn render_ui() { draw_button(); draw_text(); }".into());
        let mut n3 = Node::new("n3", "process_refund", NodeKind::Function);
        n3.snippet = Some("fn process_refund(order_id: u64) -> Result<Money, Error> { validate(order_id) }".into());

        let count = vi.build(&[n1, n2, n3]).unwrap();
        assert_eq!(count, 3);

        let results = vi.search("payment processing", 2).unwrap();
        assert!(!results.is_empty());
        eprintln!("search 'payment processing': {:?}", results.iter().map(|(id, s)| format!("{id}({:.2})", s)).collect::<Vec<_>>());
        // handle_payment 应排在首位
        assert_eq!(results[0].0, "n1");

        vi.save().unwrap();
        let vi2 = CodeVectorIndex::new(&idx_path);
        assert_eq!(vi2.load().unwrap(), 3);

        let results2 = vi2.search("refund money", 2).unwrap();
        eprintln!("reloaded search 'refund': {:?}", results2.iter().map(|(id, s)| format!("{id}({:.2})", s)).collect::<Vec<_>>());
        assert_eq!(results2[0].0, "n3");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── 磁盘嵌入缓存（2026-10-28：跨重启存活）──

    fn tmp_cache_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hologram_vi_ec_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 带唯一标记造三个节点：**测试之间不能共用 snippet**——进程级 VECTOR_CACHE
    /// 是全局 static，相同 snippet = 相同 hash，会让「冷启动必须真推理」的断言失真。
    fn three_nodes(tag: &str) -> Vec<Node> {
        (0..3)
            .map(|i| {
                let mut n = Node::new(&format!("{tag}{i}"), &format!("embed_cache_{tag}_fn_{i}"), NodeKind::Function);
                n.snippet = Some(format!("fn embed_cache_{tag}_fn_{i}() {{ work({i}); }}"));
                n
            })
            .collect()
    }

    /// round-trip：写进去的 (hash → 向量) 必须原样读回来（f32 逐位相等）。
    #[test]
    fn test_embed_cache_round_trip() {
        let dir = tmp_cache_dir("rt");
        let path = dir.join("vectors.embed.cache");

        let entries: Vec<(u64, Arc<Vec<f32>>)> = (0..3u64)
            .map(|i| {
                let mut v = vec![0.0f32; VECTOR_DIM];
                v[(i as usize * 7) % VECTOR_DIM] = 1.0 + i as f32;
                v[1] = -0.5;
                (i * 1_000_003 + 17, Arc::new(v))
            })
            .collect();

        write_embed_cache(&path, &entries).unwrap();
        assert!(!path.with_extension("embed.cache.tmp").exists(), "原子落盘不应残留 tmp");

        let loaded = read_embed_cache(&path).unwrap();
        assert_eq!(loaded.len(), entries.len());
        for (hash, vec) in &entries {
            let got = loaded.get(hash).expect("round-trip 必须保留每个键");
            assert_eq!(got.len(), VECTOR_DIM);
            assert_eq!(**got, **vec, "向量必须逐位相等（f32 不做文本化）");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 头部任一不匹配（version / dim / backend）⇒ 整份丢弃（Err），不静默混用。
    #[test]
    fn test_embed_cache_rejects_header_mismatch() {
        let dir = tmp_cache_dir("hdr");
        let path = dir.join("vectors.embed.cache");
        let entries: Vec<(u64, Arc<Vec<f32>>)> =
            vec![(42, Arc::new(vec![0.25f32; VECTOR_DIM]))];
        write_embed_cache(&path, &entries).unwrap();

        let good = std::fs::read(&path).unwrap();

        // version（偏移 4..8）
        let mut bad = good.clone();
        bad[4..8].copy_from_slice(&(EMBED_CACHE_VERSION + 1).to_le_bytes());
        std::fs::write(&path, &bad).unwrap();
        assert!(read_embed_cache(&path).is_err(), "版本不匹配必须判废");

        // dim（偏移 8..12）
        let mut bad = good.clone();
        bad[8..12].copy_from_slice(&((VECTOR_DIM + 1) as u32).to_le_bytes());
        std::fs::write(&path, &bad).unwrap();
        assert!(read_embed_cache(&path).is_err(), "维度不匹配必须判废");

        // backend（偏移 16 起，长度由 12..16 给出）
        let mut bad = good.clone();
        bad[16] = b'X'; // 破坏 backend 首字节
        std::fs::write(&path, &bad).unwrap();
        assert!(read_embed_cache(&path).is_err(), "后端不匹配必须判废");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 毒化数据：坏魔数 / 截断 / 空文件 ⇒ 一律 Err，绝不 panic（INVARIANTS #11 同族）。
    #[test]
    fn test_embed_cache_tolerates_corruption() {
        let dir = tmp_cache_dir("poison");
        let path = dir.join("vectors.embed.cache");

        std::fs::write(&path, b"").unwrap();
        assert!(read_embed_cache(&path).is_err(), "空文件");

        std::fs::write(&path, b"NOPE").unwrap();
        assert!(read_embed_cache(&path).is_err(), "坏魔数");

        let entries: Vec<(u64, Arc<Vec<f32>>)> =
            vec![(7, Arc::new(vec![0.5f32; VECTOR_DIM]))];
        write_embed_cache(&path, &entries).unwrap();
        let good = std::fs::read(&path).unwrap();
        std::fs::write(&path, &good[..good.len() - 7]).unwrap();
        assert!(read_embed_cache(&path).is_err(), "截断");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **本件的核心断言**：重启后（进程内缓存清空）第二次 build 零推理。
    #[test]
    fn test_second_build_needs_no_inference() {
        let dir = tmp_cache_dir("restart");
        let idx_path = dir.join("vectors.usearch");
        let nodes = three_nodes("restart");

        // 生产路径每次重建都新建实例（engine/src/engine/pipeline.rs 与
        // hologram-storage/src/store.rs 同款）——这里按同一姿势模拟。
        let first = CodeVectorIndex::new(&idx_path).build_with_stats(&nodes).unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(first.misses, 3, "冷启动：三个节点都必须真推理");
        assert_eq!(first.indexed, 3);

        // 模拟进程重启：清掉进程级 static 缓存
        clear_process_vector_cache();

        let second = CodeVectorIndex::new(&idx_path).build_with_stats(&nodes).unwrap();
        assert_eq!(second.misses, 0, "磁盘缓存必须让重启后的重建零推理");
        assert_eq!(second.disk_hits, 3, "三条全部来自磁盘缓存");
        assert_eq!(second.cache_hits, 0, "进程内缓存已被清空");
        assert_eq!(second.indexed, 3);

        // 第三次（磁盘缓存 + 进程内都在）仍然零推理
        let third = CodeVectorIndex::new(&idx_path).build_with_stats(&nodes).unwrap();
        assert_eq!(third.misses, 0);
        assert_eq!(third.cache_hits, 3, "本轮应走进程内缓存");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同一个实例重建两次都必须成功——usearch high-level wrapper 拒绝重复键，
    /// 旧代码没有重置索引，二次 build 必炸（2026-10-28 由本批测试暴露的既有死路）。
    #[test]
    fn test_rebuild_same_instance_is_ok() {
        let dir = tmp_cache_dir("reuse");
        let idx_path = dir.join("vectors.usearch");
        let vi = CodeVectorIndex::new(&idx_path);
        let nodes = three_nodes("reuse");

        assert_eq!(vi.build(&nodes).unwrap(), 3);
        assert_eq!(vi.build(&nodes).unwrap(), 3, "二次重建不应因 usearch 重复键失败");
        assert!(!vi.search("embed_cache_fn_1", 1).unwrap().is_empty(), "重建后搜索应可用");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
