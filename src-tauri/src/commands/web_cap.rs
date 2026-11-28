// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// web 能力口（R4 小面清偿，kernel-capability-d4-handle-design.md §6 R4-4）——
// web 族（search/fetch）直呼入口，不经 tool_call 信封 / PluginRegistry /
// PluginToolAdapter（builtin.web 插件随本批退役）。
//
// 口内闸（D4-4/D4-5 同款）：直接构造 WebFetchTool 过 crate::utils::check_permission
// ——无条件过闸（插件原语义）；域名规则 + SSRF + Ask 事件在 WebFetchTool /
// web_fetch 逐跳复查（插件原样）。web_search 以主用搜索引擎的搜索页 URL 过同一
// Web 域权限（搜索页也是「一次 Web 访问」）。
//
// 2026-11-28 修复（web_search 恒超时）：三处同时失效——① AnySearch 匿名请求
// 按**出口 IP** 计每日免费额度（1,000 次/天），本机 IP 已耗尽：402
// daily_free_quota_exhausted，而同一请求带 Authorization: Bearer <key> 即 200
//（服务没下线，是匿名池被用光）；② DuckDuckGo html 端点在境内 TCP connect 超时，
// 而它恰是当时的默认后端；③ Bing HTML 抓取侧的 li.b_algo 不再命中 cn.bing.com。
// 修复后的次序：AnySearch（撞 402 时接住服务端自动生成的 key、落系统凭据并重发
// 一次）→ Bing RSS 出口（format=rss，纯 XML、无 JS/无 cookie 挑战）→ DuckDuckGo
// 抓取；全败时错误带出三方原因（不再静默吞成「无结果」）。
//
// ⚠ 402 响应体会带自动生成的账号/密码/API key——只允许就地解析 api_key 一个字段，
// 整段 body 不进日志、不进错误串、不进模型上下文（AnySearch 文档明示）。
//
// 键语言：口收顶层 snake（能力口统一契约）；TS 工具面键 = manifest 语言
// （camelCase：maxResults），映射在 TS execute 层。返回 Text（search = JSON
// 字符串 / fetch = 网页文本——信封 dispatch 的 Value 序列化语义逐字节保持）。

use serde_json::Value;
use tauri::State;

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/// 内置搜索引擎。Bing 走 RSS 出口（`format=rss`：纯 XML、无反爬、无 JS）；
/// DuckDuckGo 走 html 端点（境外网络可直连，境内多被 TCP 阻断——仅作兜底）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SearchEngine {
    Bing,
    DuckDuckGo,
}

impl SearchEngine {
    fn name(self) -> &'static str {
        match self {
            SearchEngine::Bing => "bing",
            SearchEngine::DuckDuckGo => "duckduckgo",
        }
    }

    /// 备用引擎（主引擎失败或零结果时换它再试一次）。
    fn other(self) -> SearchEngine {
        match self {
            SearchEngine::Bing => SearchEngine::DuckDuckGo,
            SearchEngine::DuckDuckGo => SearchEngine::Bing,
        }
    }
}

/// `HOLOGRAM_SEARCH_BACKEND` 解析（纯函数：测试不碰进程环境）。
fn engine_from_value(value: Option<&str>) -> SearchEngine {
    match value {
        Some("duckduckgo") => SearchEngine::DuckDuckGo,
        _ => SearchEngine::Bing,
    }
}

/// 默认 Bing（境内可直连且 RSS 出口稳定）；`HOLOGRAM_SEARCH_BACKEND=duckduckgo`
/// 可切回 DuckDuckGo 抓取（境外网络更稳）。
fn search_backend() -> SearchEngine {
    engine_from_value(std::env::var("HOLOGRAM_SEARCH_BACKEND").ok().as_deref())
}

/// 搜索引擎的搜索页 URL——权限闸与真实请求共用同一 URL（单一真源）。
fn search_page_url(engine: SearchEngine, query: &str) -> String {
    let q = crate::utils::urlencoding(query);
    match engine {
        SearchEngine::Bing => format!("https://www.bing.com/search?q={q}&format=rss"),
        SearchEngine::DuckDuckGo => format!("https://html.duckduckgo.com/html/?q={q}"),
    }
}

/// 口内闸句柄（BrowserGate/UiaGate 同形——web 面用 WebFetchTool）。
pub(crate) struct WebGate<'a> {
    pub agent_id: Option<String>,
    pub state: &'a State<'a, crate::WorkspaceState>,
    pub app: &'a tauri::AppHandle,
}

impl WebGate<'_> {
    /// 工具级权限过闸（WebFetchTool：域名规则 + SSRF 前置 + Ask）。无条件过闸。
    pub async fn check(&self, tool: &crate::tools::WebFetchTool) -> Result<(), String> {
        let perm_ctx = crate::utils::get_ctx(self.state)?;
        crate::utils::check_permission(tool, &perm_ctx, self.app)
            .await
            .map_err(|m| format!("权限拒绝: {m}"))
    }
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 tool_plugins/web/mod.rs 逐行为迁入；参数键顶层 snake；
// ToolError 内联化——错误串即最终形态，Permission 带「权限拒绝: 」前缀）
// ═══════════════════════════════════════════════════════════════

/// web_search — AnySearch（402 自动接 key）+ 引擎兜底（Bing RSS → DuckDuckGo）。
async fn web_search(gate: &WebGate<'_>, args: &Value) -> Result<String, String> {
    let query = arg_str(args, "query").ok_or_else(|| "web_search: missing 'query'".to_string())?;
    let max_results = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(10)
        .clamp(1, 10);

    let primary = search_backend();
    // 权限检查用主引擎的搜索页 URL（搜索页 = 一次 Web 访问，同一 Web 域权限）。
    gate.check(&crate::tools::WebFetchTool {
        url: search_page_url(primary, &query),
        agent_id: gate.agent_id.clone(),
    })
    .await?;

    // ureq 是阻塞客户端：网络 IO 进 spawn_blocking，不占 tokio worker
    //（CONVENTIONS §2.3；超时预算最长 8s+10s，落 async worker 会拖住同线程的其它 RPC）。
    let owned_query = query.clone();
    let results =
        tokio::task::spawn_blocking(move || run_search(primary, &owned_query, max_results))
            .await
            .map_err(|e| format!("web_search: 搜索任务中断: {e}"))??;

    if results.is_empty() {
        return Ok(serde_json::json!({
            "query": query,
            "results": [],
            "error": "No results found.",
        })
        .to_string());
    }

    Ok(serde_json::json!({
        "query": query,
        "results": &results[..results.len().min(max_results)],
    })
    .to_string())
}

/// AnySearch 匿名额度耗尽后，官方会在同一个 402 响应里回一套自动生成的账号与
/// key（文档「Anonymous quota response」：用 Bearer key 重发原请求）。这里按该
/// 指引接住它并落到系统凭据——否则匿名池一旦见底，此后每次搜索都只能吃 402
///（本机 2026-11-28 现场即此：keyless 恒 402，带 key 同一请求 200）。
const ANYSEARCH_SEARCH_URL: &str = "https://api.anysearch.com/v1/search";
/// 凭据库命名空间（与 LLM provider 名同一加密文件，见 credential.rs）。
const ANYSEARCH_KEY_PROVIDER: &str = "anysearch";

enum AnySearchOutcome {
    Results(Vec<serde_json::Value>),
    QuotaExhausted { auto_key: Option<String> },
    Unauthorized,
    Failed(String),
}

/// key 来源：env 覆盖优先，其次本机凭据（首次 402 自动落盘的那把）。
fn anysearch_api_key() -> Option<String> {
    if let Ok(value) = std::env::var("HOLOGRAM_ANYSEARCH_API_KEY") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    crate::credential::get_api_key(ANYSEARCH_KEY_PROVIDER)
        .ok()
        .flatten()
}

fn anysearch_search(query: &str, max_results: usize, key: Option<&str>) -> AnySearchOutcome {
    let payload = serde_json::json!({ "query": query, "max_results": max_results });
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .http_status_as_error(false)
            .timeout_per_call(Some(std::time::Duration::from_secs(8)))
            .timeout_global(Some(std::time::Duration::from_secs(15)))
            .build(),
    );

    let mut req = agent
        .post(ANYSEARCH_SEARCH_URL)
        .header("Content-Type", "application/json")
        .header("User-Agent", CHROME_UA);
    if let Some(key) = key {
        let bearer = format!("Bearer {key}");
        req = req.header("Authorization", bearer.as_str());
    }
    let resp = match req.send(payload.to_string()) {
        Ok(resp) => resp,
        Err(e) => return AnySearchOutcome::Failed(format!("请求失败: {e}")),
    };

    let status = resp.status().as_u16();
    let mut body = resp.into_body();
    // 402 的 body 含账号/密码/key：只允许就地解析出 key，绝不进日志或错误串。
    let text = match body.read_to_string() {
        Ok(text) => text,
        Err(e) => return AnySearchOutcome::Failed(format!("读取失败: {e}")),
    };

    match status {
        200 => AnySearchOutcome::Results(parse_anysearch_results(&text, max_results)),
        402 => AnySearchOutcome::QuotaExhausted {
            auto_key: parse_generated_api_key(&text),
        },
        401 | 403 => AnySearchOutcome::Unauthorized,
        other => AnySearchOutcome::Failed(format!("HTTP {other}")),
    }
}

/// 一次搜索：AnySearch → 主引擎 → 备用引擎。AnySearch 零结果/失败才换引擎；
/// 全败时错误带出三方原因，不再静默降级成「无结果」。
fn run_search(
    primary: SearchEngine,
    query: &str,
    max_results: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let mut notes: Vec<String> = Vec::new();

    match anysearch_attempt(query, max_results) {
        Ok(items) if !items.is_empty() => return Ok(items),
        Ok(_) => notes.push("anysearch: 0 条".to_string()),
        Err(reason) => notes.push(format!("anysearch: {reason}")),
    }

    let first = engine_search(primary, query, max_results);
    if matches!(&first, Ok(items) if !items.is_empty()) {
        return first;
    }
    match engine_search(primary.other(), query, max_results) {
        Ok(items) => Ok(items),
        Err(second_err) => match first {
            // 主引擎正常返回但零命中 → 备用引擎不可达时仍按「无结果」回，不谎报故障。
            Ok(_) => Ok(Vec::new()),
            Err(first_err) => {
                notes.push(format!("{}: {first_err}", primary.name()));
                notes.push(format!("{}: {second_err}", primary.other().name()));
                Err(format!(
                    "web_search: 全部搜索引擎失败（{}）",
                    notes.join("；")
                ))
            }
        },
    }
}

/// AnySearch 一次尝试：有 key 用 key；无 key 先匿名，撞 402 就接住服务端生成的
/// key、落盘并重发一次（只重发一次，避免额度真耗尽时打转）。
fn anysearch_attempt(query: &str, max_results: usize) -> Result<Vec<serde_json::Value>, String> {
    let stored_key = anysearch_api_key();
    match anysearch_search(query, max_results, stored_key.as_deref()) {
        AnySearchOutcome::Results(items) => Ok(items),
        AnySearchOutcome::Unauthorized => {
            // 失效的 key 会把之后每次搜索都钉死在 401：清掉，下次重新走匿名注册。
            if stored_key.is_some() {
                let _ = crate::credential::delete_api_key(ANYSEARCH_KEY_PROVIDER);
                return Err("API key 失效（401/403），已清除".to_string());
            }
            Err("认证失败（401/403）".to_string())
        }
        AnySearchOutcome::QuotaExhausted { auto_key } => {
            let Some(auto_key) = auto_key else {
                return Err("每日免费额度耗尽（402），响应未含可用 key".to_string());
            };
            // 落盘失败不阻断本次搜索：内存里带着这把 key 重试一次。
            let stored =
                crate::credential::store_api_key(ANYSEARCH_KEY_PROVIDER, &auto_key).is_ok();
            match anysearch_search(query, max_results, Some(&auto_key)) {
                AnySearchOutcome::Results(items) => Ok(items),
                AnySearchOutcome::QuotaExhausted { .. } => Err(if stored {
                    "额度耗尽（402），自动生成的 key 也未恢复额度".to_string()
                } else {
                    "额度耗尽（402），自动生成的 key 未落盘且重试失败".to_string()
                }),
                AnySearchOutcome::Unauthorized => Err("自动生成的 key 无效（401/403）".to_string()),
                AnySearchOutcome::Failed(reason) => Err(reason),
            }
        }
        AnySearchOutcome::Failed(reason) => Err(reason),
    }
}

/// 402 body → 自动生成的 api_key（形如 `api_key=as_sk_xxx`）。只取这一个字段，
/// body 其余部分（username / password）一律不进日志、不进错误串。
fn parse_generated_api_key(body: &str) -> Option<String> {
    let re = regex::Regex::new(r"api_key=([A-Za-z0-9_\-]{8,200})").expect("静态正则");
    re.captures(body).map(|c| c[1].to_string())
}

/// AnySearch 成功响应 → 统一 [{ title, url, snippet }]；snippet 缺失时退 content。
fn parse_anysearch_results(text: &str, max_results: usize) -> Vec<serde_json::Value> {
    let Ok(data) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let items = data
        .get("data")
        .and_then(|d| d.get("results"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut results = Vec::new();
    for item in items.into_iter().take(max_results) {
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let url = item
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let snippet = item
            .get("snippet")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("content").and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() || url.is_empty() {
            continue;
        }
        results.push(serde_json::json!({
            "title": title,
            "url": url,
            "snippet": snippet,
        }));
    }
    results
}

fn engine_search(
    engine: SearchEngine,
    query: &str,
    max_results: usize,
) -> Result<Vec<serde_json::Value>, String> {
    match engine {
        SearchEngine::Bing => bing_rss_search(query, max_results),
        SearchEngine::DuckDuckGo => duckduckgo_search(query),
    }
}

/// Bing 的 RSS 出口（format=rss）：纯 XML、稳定字段（title/link/description），
/// 不依赖 JS / cookie，也不吃 li.b_algo 一类会随版式漂移的 HTML 结构。
fn bing_rss_search(query: &str, max_results: usize) -> Result<Vec<serde_json::Value>, String> {
    let url = search_page_url(SearchEngine::Bing, query);

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .http_status_as_error(false)
            .timeout_per_call(Some(std::time::Duration::from_secs(8)))
            .timeout_global(Some(std::time::Duration::from_secs(15)))
            .build(),
    );

    let resp = agent
        .get(&url)
        .header("User-Agent", CHROME_UA)
        .header("Accept-Language", "en-US,en;q=0.9,zh-CN;q=0.8")
        .call()
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status().as_u16();
    let mut body = resp.into_body();
    let xml = body
        .read_to_string()
        .map_err(|e| format!("读取失败: {e}"))?;

    if status != 200 {
        return Err(format!("HTTP {status}"));
    }

    Ok(parse_bing_rss(&xml, max_results))
}

/// Bing RSS → 统一 [{ title, url, snippet }] 结构（纯函数，测试直测）。
/// 空标题/空链接项丢弃（Bing 偶尔回占位项）。
fn parse_bing_rss(xml: &str, max_results: usize) -> Vec<serde_json::Value> {
    let item_re = regex::Regex::new(r"(?s)<item>(.*?)</item>").expect("静态正则");
    let title_re = regex::Regex::new(r"(?s)<title>(.*?)</title>").expect("静态正则");
    let link_re = regex::Regex::new(r"(?s)<link>(.*?)</link>").expect("静态正则");
    let desc_re = regex::Regex::new(r"(?s)<description>(.*?)</description>").expect("静态正则");
    let tag_re = regex::Regex::new(r"<[^>]*>").expect("静态正则");

    let mut results = Vec::new();
    for cap in item_re.captures_iter(xml) {
        let block = &cap[1];
        let field = |re: &regex::Regex| -> String {
            re.captures(block)
                .map(|c| html_to_text(&c[1], &tag_re))
                .unwrap_or_default()
        };
        let title = field(&title_re);
        let url = field(&link_re);
        if title.is_empty() || url.is_empty() {
            continue;
        }
        results.push(serde_json::json!({
            "title": title,
            "url": url,
            "snippet": field(&desc_re),
        }));
        if results.len() >= max_results {
            break;
        }
    }
    results
}

/// RSS 文本节点 → 纯文本：剥 CDATA 包装、去内嵌标签、解实体、压空白。
fn html_to_text(raw: &str, tag_re: &regex::Regex) -> String {
    let s = raw.trim();
    let s = s
        .strip_prefix("<![CDATA[")
        .and_then(|r| r.strip_suffix("]]>"))
        .unwrap_or(s);
    let stripped = tag_re.replace_all(s, " ");
    let text = unescape_entities(stripped.as_ref());
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 常见 XML/HTML 实体反解（Bing RSS 的 description 会带这些）。
fn unescape_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

fn duckduckgo_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let q = crate::utils::urlencoding(query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", q);

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(std::time::Duration::from_secs(5)))
            .timeout_global(Some(std::time::Duration::from_secs(10)))
            .build(),
    );

    let resp = agent
        .get(&url)
        .header("User-Agent", CHROME_UA)
        .header("Accept-Language", "en-US,en;q=0.9,zh-CN;q=0.8")
        .call()
        .map_err(|e| format!("请求失败: {e}"))?;

    let mut body = resp.into_body();
    let html = body
        .read_to_string()
        .map_err(|e| format!("读取失败: {e}"))?;

    let mut results = Vec::new();
    let title_re = regex::Regex::new(
        r#"<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>"#,
    )
    .expect("静态正则");
    let snippet_re =
        regex::Regex::new(r#"<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</a>"#)
            .expect("静态正则");
    let tag_re = regex::Regex::new(r"<[^>]*>").expect("静态正则");

    let split_re =
        regex::Regex::new(r#"<div[^>]*class="[^"]*result[^"]*"[^>]*>"#).expect("静态正则");
    let blocks: Vec<&str> = split_re.split(&html).collect();

    for block in &blocks[1..] {
        if let Some(tc) = title_re.captures(block) {
            let title = tag_re.replace_all(&tc[2], "").trim().to_string();
            if title.len() > 3 {
                let snippet = snippet_re
                    .captures(block)
                    .map(|c| tag_re.replace_all(&c[1], "").trim().to_string())
                    .unwrap_or_default();
                results.push(serde_json::json!({
                    "title": title,
                    "url": tc[1].to_string(),
                    "snippet": snippet,
                }));
                if results.len() >= 10 {
                    break;
                }
            }
        }
    }
    Ok(results)
}

/// web_fetch — URL 抓取（SSRF 逐跳复查 + 1 MiB 截断）。网页文本是 Text 结果。
async fn web_fetch(gate: &WebGate<'_>, args: &Value) -> Result<String, String> {
    let url = arg_str(args, "url").ok_or_else(|| "web_fetch: missing 'url'".to_string())?;
    gate.check(&crate::tools::WebFetchTool {
        url: url.clone(),
        agent_id: gate.agent_id.clone(),
    })
    .await?;

    let parsed = url::Url::parse(&url).map_err(|e| format!("无效 URL: {}", e))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("不支持的协议: {}", scheme));
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() || crate::utils::is_private_ip(host) {
        return Err("权限拒绝: SSRF 防护: 不允许访问内网地址".to_string());
    }

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .http_status_as_error(false)
            .timeout_per_call(Some(std::time::Duration::from_secs(10)))
            .timeout_global(Some(std::time::Duration::from_secs(30)))
            .max_redirects(0) // 禁用自动重定向 — 每一跳手动重新检查 SSRF
            .build(),
    );

    let make_request = |ua: &str| -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        agent.get(url.as_str())
                .header("User-Agent", ua)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,text/markdown;q=0.7,*/*;q=0.1")
                .header("Accept-Language", "en-US,en;q=0.9")
                .call()
    };

    // 手动跟随重定向，在每个 Location 上重新检查 SSRF
    let resp = match make_request(CHROME_UA) {
        Ok(r) if r.status().as_u16() != 403 => r,
        Ok(r) => {
            // 403 — 检查是否为 Cloudflare 验证
            let is_cf = r
                .headers()
                .get("cf-mitigated")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == "challenge")
                .unwrap_or(false);
            if is_cf {
                make_request("opencode")
                    .map_err(|e| format!("请求失败 (Cloudflare blocked): {}", e))?
            } else {
                r
            }
        }
        Err(e) => return Err(format!("请求失败: {}", e)),
    };

    // ── 手动跟随重定向并重新检查 SSRF ──
    let mut current_resp = resp;
    let mut current_url = url.clone();
    let mut redirects = 0u32;
    const MAX_REDIRECTS: u32 = 5;
    loop {
        let status = current_resp.status().as_u16();
        if !(300..400).contains(&status) {
            break;
        }
        if redirects >= MAX_REDIRECTS {
            return Err(format!("重定向次数超限 ({MAX_REDIRECTS})"));
        }
        let location = current_resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "重定向响应缺少 Location 头".to_string())?;
        // 相对于当前重定向 URL 解析相对 URL
        let base = url::Url::parse(&current_url).map_err(|e| format!("无效基址 URL: {e}"))?;
        let next_url = base
            .join(location)
            .map_err(|e| format!("无效重定向 URL: {e}"))?;
        let next_scheme = next_url.scheme();
        if next_scheme != "https" && next_scheme != "http" {
            return Err(format!("重定向到不支持的协议: {}", next_scheme));
        }
        let next_host = next_url.host_str().unwrap_or("");
        if next_host.is_empty() || crate::utils::is_private_ip(next_host) {
            return Err("权限拒绝: SSRF 防护: 重定向到内网地址被拒绝".to_string());
        }
        // 跟随重定向
        current_url = next_url.to_string();
        current_resp = agent
            .get(&current_url)
            .header("User-Agent", CHROME_UA)
            .call()
            .map_err(|e| format!("重定向请求失败: {}", e))?;
        redirects += 1;
    }
    let resp = current_resp;

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let status = resp.status().as_u16();
    let max_size: usize = 1 << 20;
    // 读 cap+1 字节以区分「恰好 1 MiB」与「真截断」——避免假阳性（2026-08-15 收口）。
    let (buf, truncated) = read_capped(resp.into_body().into_reader(), max_size)
        .map_err(|e| format!("读取失败: {}", e))?;
    let text = decode_body(&buf, parse_charset(&content_type).as_deref());

    let result = if content_type.contains("html") {
        let mut s = text;
        s = regex::Regex::new(r"(?si)<script[^>]*>.*?</script>")
            .unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则"))
            .replace_all(&s, " ")
            .to_string();
        s = regex::Regex::new(r"(?si)<style[^>]*>.*?</style>")
            .unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则"))
            .replace_all(&s, " ")
            .to_string();
        s = regex::Regex::new(r"(?s)<!--.*?-->")
            .unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则"))
            .replace_all(&s, " ")
            .to_string();
        s = regex::Regex::new(r"<[^>]*>")
            .unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则"))
            .replace_all(&s, " ")
            .to_string();
        s = s
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&apos;", "'")
            .replace("&#x27;", "'")
            .replace("&nbsp;", " ");
        s = regex::Regex::new(r"[ \t]+")
            .unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则"))
            .replace_all(&s, " ")
            .to_string();
        s = regex::Regex::new(r"\n{3,}")
            .unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则"))
            .replace_all(&s, "\n\n")
            .to_string();
        s.trim().to_string()
    } else {
        text
    };

    // 输出形态：header（最终 URL + HTTP 状态，重定向后可见）+ 正文 + 截断 footer
    //（对齐 harness web_fetch 的模型呈现；截断指引给下一步动作而非裸报错）。
    let mut out = format!("Fetched {current_url} (HTTP {status})\n\n{result}");
    if truncated {
        out.push_str("\n\n(内容已截断至 1 MiB —— 换更具体的 URL，或对已打开的页面用 browser(content) 分页读取。)");
    }
    Ok(out)
}

// ═══════════════════════════════════════════════════════════════
// 分派与入口
// ═══════════════════════════════════════════════════════════════

/// web_cap 能力口分派（R4 小面清偿立口即唯一入口——builtin.web 同批退役，
/// 无信封过渡面）。action = 退役前 builtin.web 2 工具名；参数顶层 snake；
/// 返回文本（Text shape——search 为 JSON 字符串，fetch 为网页文本）。
pub(crate) async fn web_cap(
    action: String,
    params: Value,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let _ = is_agent; // 统一契约键；web 闸两态通用不过门（D4-5）
    let gate = WebGate {
        agent_id,
        state,
        app,
    };
    match action.as_str() {
        "web_search" => web_search(&gate, &params).await,
        "web_fetch" => web_fetch(&gate, &params).await,
        other => Err(format!("web_cap: 未知 action '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2 动作全集（= 退役前 builtin.web manifest.tools 名单）。
    #[test]
    fn action_table_is_exactly_two() {
        let actions = ["web_search", "web_fetch"];
        assert_eq!(actions.len(), 2);
        for a in actions {
            assert!(a.starts_with("web_"), "{a} 命名契约");
        }
    }

    #[test]
    fn unknown_action_errors_loudly() {
        // 分派面未知 action 显式报错——与 fs/git/process/browser/uia 口同纪律
        //（错误串由 dispatch 内联产生，本表锚定名单完备性）。
        let known = ["web_search", "web_fetch"];
        for a in ["web_crawl", "search", ""] {
            assert!(!known.contains(&a), "{a} 不应在动作表内");
        }
    }

    /// 默认主路 = Bing RSS（境内可直连）；env 只认 duckduckgo 一个覆盖值。
    #[test]
    fn search_backend_defaults_to_bing_and_honours_override() {
        assert_eq!(
            engine_from_value(None),
            SearchEngine::Bing,
            "默认 Bing（境内 DDG 被 TCP 阻断，2026-11-28 实测）"
        );
        assert_eq!(engine_from_value(Some("bing")), SearchEngine::Bing);
        assert_eq!(
            engine_from_value(Some("duckduckgo")),
            SearchEngine::DuckDuckGo
        );
        assert_eq!(
            engine_from_value(Some("whatever")),
            SearchEngine::Bing,
            "未知值回落默认，不静默换引擎"
        );
    }

    /// 权限闸 URL 与真实请求共用一份（search_page_url 单一真源）。
    #[test]
    fn search_page_url_is_backend_specific() {
        let bing = search_page_url(SearchEngine::Bing, "rust lang");
        assert!(bing.starts_with("https://www.bing.com/search?q="), "{bing}");
        assert!(bing.contains("format=rss"), "{bing}");
        let ddg = search_page_url(SearchEngine::DuckDuckGo, "rust lang");
        assert!(
            ddg.starts_with("https://html.duckduckgo.com/html/?q="),
            "{ddg}"
        );
    }

    /// RSS 解析（纯函数）：CDATA / 实体 / 空标题 / 空链接 / 截断全走一遍。
    #[test]
    fn bing_rss_parses_items_with_cdata_and_entities() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<title>必应：rust</title>
<item><title>Rust Programming Language</title><link>https://rust-lang.org/</link><description>The Rust &lt;programming&gt; language &amp; toolchain</description></item>
<item><title><![CDATA[Rust 程序设计语言]]></title><link>https://rust-lang.org/zh-CN/</link><description><![CDATA[<b>Rust</b> 是一门注重安全性的语言]]></description></item>
<item><title></title><link>https://example.com/empty-title</link></item>
<item><title>No link</title><description>x</description></item>
</channel></rss>"#;
        let items = parse_bing_rss(xml, 10);
        assert_eq!(items.len(), 2, "空标题 / 空链接项必须丢弃");
        assert_eq!(items[0]["title"], "Rust Programming Language");
        assert_eq!(items[0]["url"], "https://rust-lang.org/");
        assert_eq!(
            items[0]["snippet"],
            "The Rust <programming> language & toolchain"
        );
        assert_eq!(items[1]["title"], "Rust 程序设计语言");
        assert_eq!(items[1]["snippet"], "Rust 是一门注重安全性的语言");
    }

    /// 402 body 里能且只能取出 api_key 一个字段（username/password 不外泄）。
    #[test]
    fn generated_api_key_is_extracted_from_quota_402_body() {
        let body = r#"{"code":-1,"message":"Your account and API key have been automatically generated. Use the API key below to continue.\nusername=as_auto_abc123\npassword=secretpwd\napi_key=as_sk_test0123456789abcdef0123456789","request_id":"r1","error_code":"daily_free_quota_exhausted"}"#;
        assert_eq!(
            parse_generated_api_key(body).as_deref(),
            Some("as_sk_test0123456789abcdef0123456789")
        );
        assert_eq!(parse_generated_api_key(r#"{"code":-1}"#), None);
        assert_eq!(parse_generated_api_key("api_key="), None, "空值不算 key");
    }

    /// AnySearch 成功响应 → 统一结构（snippet 缺失退 content；空标题/空链接丢弃）。
    #[test]
    fn anysearch_results_are_normalized() {
        let body = r#"{"code":0,"message":"success","data":{"results":[
{"title":"Rust Programming Language","url":"https://rust-lang.org/","snippet":"A language empowering everyone."},
{"title":"No snippet","url":"https://example.com/a","content":"Content fallback."},
{"title":"","url":"https://example.com/empty"},
{"title":"No url","snippet":"x"}],"metadata":{"total_results":4}}}"#;
        let items = parse_anysearch_results(body, 10);
        assert_eq!(items.len(), 2, "空标题/空链接项必须丢弃");
        assert_eq!(items[0]["title"], "Rust Programming Language");
        assert_eq!(items[0]["snippet"], "A language empowering everyone.");
        assert_eq!(items[1]["snippet"], "Content fallback.");
        assert_eq!(
            parse_anysearch_results(body, 1).len(),
            1,
            "遵守 max_results"
        );
        assert_eq!(
            parse_anysearch_results("not json", 10).len(),
            0,
            "坏响应不 panic"
        );
    }

    /// 联网冒烟（默认 ignored，手动跑）：
    /// `cargo test -p lantai --release --bins web_cap_live -- --ignored --nocapture`
    /// 覆盖真实链路：匿名 402 → 接住自动生成的 key → 落系统凭据 → 重发 → 200。
    #[test]
    #[ignore = "联网冒烟：手动执行，验证 AnySearch 402 自动接 key 全链路"]
    fn web_cap_live_anysearch_roundtrip() {
        let items = anysearch_attempt("rust programming language", 3).expect("AnySearch 应可用");
        eprintln!("anysearch live items = {}", items.len());
        assert!(!items.is_empty(), "应至少返回 1 条");
        assert!(
            items[0]["url"].as_str().unwrap_or("").starts_with("http"),
            "首条应是 URL"
        );
    }

    #[test]
    fn bing_rss_respects_max_results() {
        let xml: String = (0..5)
            .map(|i| {
                format!("<item><title>t{i}</title><link>https://example.com/{i}</link></item>")
            })
            .collect();
        assert_eq!(parse_bing_rss(&xml, 3).len(), 3);
        assert_eq!(parse_bing_rss(&xml, 10).len(), 5, "不足上限时全给");
    }
}

/// 从 Content-Type 头解析 charset 标签（小写、去引号）；无则 None。
fn parse_charset(content_type: &str) -> Option<String> {
    for part in content_type.split(';').skip(1) {
        let kv: Vec<&str> = part.trim().splitn(2, '=').collect();
        if kv.len() == 2 && kv[0].trim().eq_ignore_ascii_case("charset") {
            return Some(kv[1].trim().trim_matches('"').to_ascii_lowercase());
        }
    }
    None
}

/// 按声明 charset 解码；未声明或未知标签一律按 UTF-8 宽容解码
///（坏字节变 � 而非整页报错——能用的正文胜过 mojibake 报错）。
fn decode_body(bytes: &[u8], charset: Option<&str>) -> String {
    if let Some(label) = charset {
        if let Some(enc) = encoding_rs::Encoding::for_label(label.as_bytes()) {
            let (cow, _) = enc.decode_without_bom_handling(bytes);
            return cow.into_owned();
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 从 reader 按字节 cap 读取：读 cap+1 字节以区分「恰好到 cap」与「真截断」。
fn read_capped<R: std::io::Read>(reader: R, cap: usize) -> std::io::Result<(Vec<u8>, bool)> {
    use std::io::Read as _;
    let mut buf = Vec::new();
    reader.take((cap as u64) + 1).read_to_end(&mut buf)?;
    let truncated = buf.len() > cap;
    buf.truncate(cap);
    Ok((buf, truncated))
}
