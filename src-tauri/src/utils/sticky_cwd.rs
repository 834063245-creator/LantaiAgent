// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话粘性 cwd — 持久化 shell 真子集（2026-08-18，会话日志实证驱动）。
//
// 动机：2445 次 run_shell 里 46.9% 是 `cd X && cmd` 复合命令 —— 模型在用
// 每次调用重建目录状态的方式手动模拟持久 shell。粘性 cwd 让 cd 的效果
// 跨调用保持（按 agent 身份键控），消灭这笔税。
//
// 语义：
//   - 解析顺序：显式 cwd 参数 → 该 agent 的粘性值 → workspace root
//   - 落点捕获：前台命令被包装为 `{ cmd ; } ; printf '<MARKER>%s<BEL>' "$PWD"`，
//     输出流里的 marker 被截留（不向前端 emit），提取真实落点更新粘性值
//   - 自愈：cd 失败 / 命令被杀 / 超时 → 无 marker → 粘性值不动
//   - 失效：粘性路径已不存在（被删）→ 读取时清掉，回退 workspace root
//   - 隔离：按 owner_id/agent_id 键控，多 Agent 互不影响；工作区切换全清
//
// 不覆盖：后台任务（长驻命令的落点对下一次调用意义小，且完成时机被动）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

/// 粘性 cwd 标记 — OSC 序列（终端消费型，即使泄漏到 UI 也不可见）。
pub(crate) const CWD_MARKER_START: &str = "\u{1b}]lantaicwd;";
pub(crate) const CWD_MARKER_END: char = '\u{07}';

type StickyMap = Mutex<HashMap<String, PathBuf>>;

static STICKY: LazyLock<StickyMap> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// 代际计数 — 工作区切换全清时递增；持有旧代际的在途捕获不提交（防跨工作区串场）。
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// 测试串行锁 — 全局 STICKY/GENERATION 的测试必须互斥（cargo 默认并行线程）。
#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

fn lock_map() -> std::sync::MutexGuard<'static, HashMap<String, PathBuf>> {
    crate::utils::lock_or_recover(&STICKY)
}

/// 当前代际（在途捕获发起前快照）。
pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// 全清（工作区切换 / 停用时调用）。
pub(crate) fn clear_all() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    lock_map().clear();
}

/// 读取某 agent 的粘性 cwd。路径已不存在 → 清掉返回 None（自愈失效）。
pub(crate) fn get(agent_key: &str) -> Option<PathBuf> {
    let mut map = lock_map();
    if let Some(p) = map.get(agent_key) {
        if p.exists() {
            return Some(p.clone());
        }
        map.remove(agent_key);
    }
    None
}

/// 提交某 agent 的粘性 cwd（带代际校验 — 旧工作区的在途捕获不落新账）。
pub(crate) fn set(agent_key: &str, path: PathBuf, gen: u64) {
    if gen != GENERATION.load(Ordering::SeqCst) {
        return;
    }
    lock_map().insert(agent_key.to_string(), path);
}

/// 解析本次命令的生效目录：显式参数 → 粘性值 → 工作区根。
/// 返回字符串形式（下游权限/沙箱接口均按 &str 收）。
pub(crate) fn resolve(
    explicit: Option<&str>,
    agent_key: Option<&str>,
    workspace_root: String,
) -> String {
    if let Some(c) = explicit {
        return c.to_string();
    }
    if let Some(key) = agent_key {
        if let Some(p) = get(key) {
            return p.to_string_lossy().into_owned();
        }
    }
    workspace_root
}

// ── MSYS 路径规整 ──
// 捆绑 bash 的 $PWD 是 POSIX 风格（`/d/HoloGramHG/engine`），
// 而 Command::current_dir / 回显需要 Windows 风格。只处理盘符挂载
//（绝对主流）；UNC `//server/...` 与其他形态放弃（返回 None → 粘性不动，自愈）。
fn normalize_msys_path(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() {
        let drive = (bytes[1] as char).to_ascii_lowercase();
        let rest = &raw[2..];
        let rest = rest.trim_start_matches('/');
        if rest.is_empty() {
            return Some(PathBuf::from(format!("{drive}:/")));
        }
        return Some(PathBuf::from(format!("{drive}:/{rest}")));
    }
    // 已经是 Windows 风格（pwsh 捕获路径）— 原样接受
    if raw.len() >= 2 && raw.as_bytes()[1] == b':' {
        return Some(PathBuf::from(raw));
    }
    None
}

/// 从输出文本中提取 marker 携带的落点路径（无 marker → None）。
pub(crate) fn extract_cwd(text: &str) -> Option<(PathBuf, String)> {
    let start = text.rfind(CWD_MARKER_START)?;
    let after = &text[start + CWD_MARKER_START.len()..];
    let end = after.find(CWD_MARKER_END)?;
    let raw_path = &after[..end];
    let normalized = normalize_msys_path(raw_path)?;
    // 剥离后的干净文本（marker 前段 + 后段）
    let cleaned = format!(
        "{}{}",
        &text[..start],
        &after[end + CWD_MARKER_END.len_utf8()..]
    );
    Some((normalized, cleaned))
}

/// 包装前台命令（bash 方言，多行形式）：
/// ```sh
/// <command>
/// __lantai_rc=$?
/// printf '<START>%s<END>' "$PWD"
/// exit $__lantai_rc
/// ```
/// - 换行而非 `{ ... ; }` 组：命令尾的 `&`（`cmd &` 后跟 `;` 是 bash 语法错误）
///   与尾随 `# 注释`（会吞掉同行后续 token）都不破坏包装
/// - `$?` 在 printf 前捕获、`exit` 还原 —— 否则 shell 退出码被 printf 的 0
///   覆盖，失败命令显示成功（失败检测循环的根基）
/// - cd 失败时 PWD 未变，粘性值被同值覆盖，等价不动（自愈）
/// - 命令内 `exit`/`set -e`/`exec` 会跳过 printf → 无 marker → 粘性不动（自愈）
pub(crate) fn wrap_bash_command(command: &str) -> String {
    format!(
        "{command}\n__lantai_rc=$?\nprintf '{CWD_MARKER_START}%s{CWD_MARKER_END}' \"$PWD\"\nexit $__lantai_rc"
    )
}

/// 包装前台命令（pwsh 方言，换行分隔）：`[Console]::Out.Write` 直写 stdout 流，
/// 绕过 PowerShell 的流编号与 Write-Host 的信息流语义（marker 必须落在
/// 被捕获的 stdout）；`exit $LASTEXITCODE` 还原原生命令退出码。换行分隔
/// 避免命令尾 `#` 注释吞掉后续 `;` 语句。
pub(crate) fn wrap_pwsh_command(command: &str) -> String {
    format!(
        "{command}\n[Console]::Out.Write('{CWD_MARKER_START}' + $PWD.Path + [char]7)\nexit $LASTEXITCODE"
    )
}

/// 非流式路径的粘性 cwd 处理上下文 — wait_child_blocking 的完成出口
/// 据此剥 marker、提交粘性值并回显落点。
pub(crate) struct StickyContext {
    pub agent_key: Option<String>,
    pub generation: u64,
    /// 命令起始目录 — 无 marker（超时/被杀）时回显退化用。
    pub start_dir: String,
}

/// 非流式完成出口：从拼装好的结果文本剥 marker、提交粘性值，
/// 追加 `[cwd: X]` 回显行。无 marker 时仅回显起始目录。
pub(crate) fn finalize_output(text: &str, ctx: &StickyContext) -> String {
    match extract_cwd(text) {
        Some((path, cleaned)) => {
            if let Some(key) = ctx.agent_key.as_deref() {
                set(key, path.clone(), ctx.generation);
            }
            append_cwd_echo(&cleaned, &path.to_string_lossy())
        }
        None => append_cwd_echo(text, &ctx.start_dir),
    }
}

fn append_cwd_echo(text: &str, cwd: &str) -> String {
    let trimmed = text.trim_end_matches('\n');
    if trimmed.is_empty() {
        format!("[cwd: {cwd}]")
    } else {
        format!("{trimmed}\n[cwd: {cwd}]")
    }
}

/// 流式路径的跨 chunk marker 截流器。
/// 逐块喂入已解码文本，返回应向前端 emit 的干净增量；marker 跨块分裂时
/// 挂起中间片段（下一块续判），识别完成时经回调提交粘性值。
/// 未识别的挂起片段在 flush 时原样放行（命令没走到 printf —— 粘性不动）。
pub(crate) struct CwdMarkerFilter {
    pending: String,
    /// 已提交过一次后放行后续一切（每次命令只有一个 marker；后续同形文本
    /// 是命令自己的输出，不再截留）。
    consumed: bool,
}

impl CwdMarkerFilter {
    pub(crate) fn new() -> Self {
        Self { pending: String::new(), consumed: false }
    }

    /// 喂入一块解码文本，返回干净输出 + 是否提交了粘性值。
    /// `agent_key`/`gen` 为提交粘性值的身份与代际。
    pub(crate) fn push(
        &mut self,
        chunk: &str,
        agent_key: Option<&str>,
        gen: u64,
    ) -> (String, bool) {
        if self.consumed {
            return (chunk.to_string(), false);
        }
        self.pending.push_str(chunk);
        let Some(start) = self.pending.find(CWD_MARKER_START) else {
            // 无起点：若尾部是 START 的前缀（跨块分裂中），挂起尾段待续；
            // 否则全部放行。注意 drain 掉前段、保留尾段（truncate 保留的是
            // 头部字节，语义相反）。
            let hold = longest_suffix_is_prefix(&self.pending, CWD_MARKER_START);
            let keep_from = self.pending.len() - hold;
            let emit = self.pending[..keep_from].to_string();
            self.pending.drain(..keep_from);
            return (emit, false);
        };
        // 找到起点：起点之前的文本放行
        let before = self.pending[..start].to_string();
        let after = &self.pending[start + CWD_MARKER_START.len()..];
        match after.find(CWD_MARKER_END) {
            Some(end) => {
                let raw_path = &after[..end];
                let committed = if let Some(key) = agent_key {
                    if let Some(p) = normalize_msys_path(raw_path) {
                        set(key, p, gen);
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                let rest = after[end + CWD_MARKER_END.len_utf8()..].to_string();
                self.pending.clear();
                self.consumed = true;
                // marker 之后的余段随本块一起放行（consumed 后不再有挂起语义）
                (format!("{before}{rest}"), committed)
            }
            None => {
                // marker 未闭合：挂起起点之后的一切，放行起点之前的部分。
                // 若 after 已包含换行（路径不可能含换行），说明这是命令自己
                // 输出的伪 marker 文本 → 连同换行放行，不再截留。
                if let Some(nl) = after.find('\n') {
                    let fake_end = CWD_MARKER_START.len() + nl + 1;
                    let emit = format!("{}{}", before, &self.pending[start..start + fake_end]);
                    self.pending.drain(..start + fake_end);
                    return (emit, false);
                }
                // 挂起上限保护：路径不会超过 4KB；超过视为异常输出
                if after.len() > 4096 {
                    let emit = self.pending.clone();
                    self.pending.clear();
                    self.consumed = true;
                    return (emit, false);
                }
                self.pending = self.pending[start..].to_string();
                (before, false)
            }
        }
    }

    /// 流结束：放行挂起的一切（无提交）。
    pub(crate) fn flush(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }
}

/// `suffix` 是否为 `prefix_of` 的前缀的尾段（跨块分裂检测）。
fn longest_suffix_is_prefix(text: &str, pattern: &str) -> usize {
    let max = text.len().min(pattern.len());
    for hold in (1..=max).rev() {
        if text.ends_with(&pattern[..hold]) {
            // 切点必须在字符边界上
            if text.is_char_boundary(text.len() - hold) {
                return hold;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全局态（STICKY/GENERATION）测试统一持锁串行。
    fn locked() -> std::sync::MutexGuard<'static, ()> {
        crate::utils::lock_or_recover(&TEST_LOCK)
    }

    /// 真实存在的临时目录（get 要求路径存在）。
    fn tmpdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("lantai_sticky_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn msys_path_normalizes() {
        assert_eq!(
            normalize_msys_path("/d/HoloGramHG/engine").unwrap(),
            PathBuf::from("d:/HoloGramHG/engine")
        );
        assert_eq!(normalize_msys_path("/c/").unwrap(), PathBuf::from("c:/"));
        // UNC / 相对路径 → None（放弃捕获）
        assert!(normalize_msys_path("//server/share").is_none());
        assert!(normalize_msys_path("relative/x").is_none());
        // Windows 风格直通（pwsh 路径）
        assert_eq!(
            normalize_msys_path("D:\\HoloGramHG\\src-ui").unwrap(),
            PathBuf::from("D:\\HoloGramHG\\src-ui")
        );
    }

    #[test]
    fn extract_finds_marker_and_cleans() {
        let text = format!("build ok\n{CWD_MARKER_START}/d/HoloGramHG/engine{CWD_MARKER_END}\n");
        let (p, cleaned) = extract_cwd(&text).unwrap();
        assert_eq!(p, PathBuf::from("d:/HoloGramHG/engine"));
        assert_eq!(cleaned, "build ok\n\n");
        // 无 marker
        assert!(extract_cwd("plain output").is_none());
        // marker 未闭合（跨块分裂的残余）
        assert!(extract_cwd(&format!("{CWD_MARKER_START}/d/x")).is_none());
    }

    #[test]
    fn wrap_bash_survives_trailing_bg_and_comment() {
        // 尾随 & ：花括号组形式会因 `& ;` 语法错误；多行形式合法
        let w = wrap_bash_command("npm run dev &");
        assert!(w.starts_with("npm run dev &\n"), "尾随 & 必须直接换行续接: {w}");
        // 尾随注释：换行终结注释，不吞后续行
        let w2 = wrap_bash_command("cargo check # heavy");
        assert!(w2.starts_with("cargo check # heavy\n"), "注释行必须被换行终结: {w2}");
        for w in [&w, &w2] {
            assert!(w.contains("printf '"));
            assert!(w.contains("\"$PWD\""));
            assert!(w.contains("exit $__lantai_rc"), "退出码必须被还原");
        }
    }

    #[test]
    fn sticky_set_get_and_generation_fence() {
        let _g = locked();
        let real = tmpdir("fence");
        clear_all();
        let g = generation();
        set("agent-a", real.clone(), g);
        assert_eq!(get("agent-a").unwrap(), real);
        // 旧代际不提交
        set("agent-a", tmpdir("other"), g + 1);
        assert_eq!(get("agent-a").unwrap(), real);
        // 全清后无值
        clear_all();
        assert!(get("agent-a").is_none());
    }

    #[test]
    fn resolve_order_explicit_then_sticky_then_root() {
        let _g = locked();
        clear_all();
        let root = "d:/root".to_string();
        let sticky_real = tmpdir("resolve");
        set("a", sticky_real.clone(), generation());
        assert_eq!(resolve(Some("d:/explicit"), Some("a"), root.clone()), "d:/explicit");
        assert_eq!(resolve(None, Some("a"), root.clone()), sticky_real.to_string_lossy());
        assert_eq!(resolve(None, Some("missing"), root.clone()), root);
        assert_eq!(resolve(None, None, root.clone()), root);
    }

    #[test]
    fn dead_sticky_path_self_heals() {
        let _g = locked();
        clear_all();
        let tmp = std::env::temp_dir().join(format!("lantai_sticky_dead_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        set("a", tmp.clone(), generation());
        assert!(get("a").is_some());
        std::fs::remove_dir_all(&tmp).unwrap();
        assert!(get("a").is_none());
    }

    #[test]
    fn marker_filter_strips_and_commits() {
        let _g = locked();
        let real = tmpdir("filter");
        clear_all();
        let gen = generation();
        // marker 携带 real 的 MSYS 形式（C:\Users\... → /c/Users/...）
        let msys = format!(
            "/{}{}",
            real.to_string_lossy().to_lowercase().chars().next().unwrap(),
            real.to_string_lossy()[2..].replace('\\', "/")
        );
        let mut f = CwdMarkerFilter::new();
        let (out, committed) = f.push(
            &format!("ok\n{CWD_MARKER_START}{msys}{CWD_MARKER_END}\n"),
            Some("agent-f"),
            gen,
        );
        // printf 不带换行；本例 marker 后带 \n，随余段一起放行 → "ok\n" + "\n"
        assert_eq!(out, "ok\n\n");
        assert!(committed);
        assert_eq!(get("agent-f").unwrap(), real);
        // 已提交后放行一切
        let (out2, c2) = f.push("more", Some("agent-f"), gen);
        assert_eq!((out2.as_str(), c2), ("more", false));
    }

    #[test]
    fn marker_filter_handles_split_chunks() {
        let _g = locked();
        let real = tmpdir("split");
        let msys = format!(
            "/{}{}",
            real.to_string_lossy().to_lowercase().chars().next().unwrap(),
            real.to_string_lossy()[2..].replace('\\', "/")
        );
        clear_all();
        let gen = generation();
        let mut f = CwdMarkerFilter::new();
        // START 分裂在两块之间
        let (o1, c1) = f.push("before\u{1b}]lanta", Some("a"), gen);
        assert_eq!((o1.as_str(), c1), ("before", false));
        let (o2, c2) = f.push(&format!("icwd;{msys}{CWD_MARKER_END}tail"), Some("a"), gen);
        assert!(c2);
        assert_eq!(o2, "tail");
        assert_eq!(get("a").unwrap(), real);
    }

    #[test]
    fn marker_filter_flush_releases_pending_without_marker() {
        let mut f = CwdMarkerFilter::new();
        let (o, _) = f.push("tail\u{1b}]lanta", None, 0);
        assert_eq!(o, "tail");
        assert_eq!(f.flush(), "\u{1b}]lanta");
    }

    #[test]
    fn marker_filter_releases_fake_marker_with_newline() {
        let mut f = CwdMarkerFilter::new();
        // 命令自己 echo 了 marker 形文本但带换行 → 放行，后续不再截留
        let (out, committed) = f.push(
            &format!("echo {CWD_MARKER_START}not-a-path\nnext"),
            None,
            0,
        );
        assert!(!committed);
        assert!(out.contains("not-a-path"));
        assert!(!out.contains("next"), "换行后的正文应在挂起区等后续块");
        assert_eq!(f.flush(), "next");
    }

    #[test]
    fn suffix_prefix_detection() {
        // "\u{1b}]lan" 是 5 字符，且是 START（ESC ] l a n t a i c w d ;）的前缀
        assert_eq!(longest_suffix_is_prefix("abc\u{1b}]lan", CWD_MARKER_START), 5);
        assert_eq!(longest_suffix_is_prefix("abc", CWD_MARKER_START), 0);
        assert_eq!(longest_suffix_is_prefix("\u{1b}", CWD_MARKER_START), 1);
        // 完整前缀尾段
        assert_eq!(longest_suffix_is_prefix("x\u{1b}]lantaicwd;", CWD_MARKER_START), CWD_MARKER_START.len());
    }
}
