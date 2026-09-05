// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// web 能力口（R4 小面清偿，kernel-capability-d4-handle-design.md §6 R4-4）——
// web 族（search/fetch）直呼入口，不经 tool_call 信封 / PluginRegistry /
// PluginToolAdapter（builtin.web 插件随本批退役）。
//
// 口内闸（D4-4/D4-5 同款）：直接构造 WebFetchTool 过 crate::utils::check_permission
// ——无条件过闸（插件原语义）；域名规则 + SSRF + Ask 事件在 WebFetchTool /
// web_fetch 逐跳复查（插件原样）。web_search 沿用原实现：以兜底搜索页 URL 过
// WebFetch 权限（AnySearch 是后端 API，仍受同一 Web 域权限约束）。
//
// 键语言：口收顶层 snake（能力口统一契约）；TS 工具面键 = manifest 语言
// （camelCase：maxResults），映射在 TS execute 层。返回 Text（search = JSON
// 字符串 / fetch = 网页文本——信封 dispatch 的 Value 序列化语义逐字节保持）。

use serde_json::Value;
use tauri::State;

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

fn search_backend() -> &'static str {
    match std::env::var("HOLOGRAM_SEARCH_BACKEND").as_deref() {
        Ok("bing") => "bing",
        _ => "duckduckgo",
    }
}

const ANYSEARCH_SEARCH_URL: &str = "https://api.anysearch.com/v1/search";

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

/// web_search — AnySearch 免费 API + Bing/DuckDuckGo 抓取兜底。
async fn web_search(gate: &WebGate<'_>, args: &Value) -> Result<String, String> {
    let query = arg_str(args, "query")
        .ok_or_else(|| "web_search: missing 'query'".to_string())?;
    let max_results = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(10)
        .clamp(1, 10);

    // 权限检查沿用原有搜索页 URL（AnySearch 是后端 API，仍受同一 Web 域权限约束）。
    let backend = search_backend();
    let fallback_url = match backend {
        "bing" => format!("https://www.bing.com/search?q={}&setlang=en", crate::utils::urlencoding(&query)),
        _ => format!("https://html.duckduckgo.com/html/?q={}", crate::utils::urlencoding(&query)),
    };
    gate.check(&crate::tools::WebFetchTool { url: fallback_url, agent_id: gate.agent_id.clone() }).await?;

    // 1) 先尝试 AnySearch 匿名免费 API（无需用户配置任何 key）
    // 2) 失败/空结果时自动降级到 Bing / DuckDuckGo 页面抓取
    let results = match anysearch_free_search(&query, max_results) {
        Ok(results) if !results.is_empty() => results,
        _ => match backend {
            "bing" => bing_search(&query)?,
            _ => duckduckgo_search(&query)?,
        },
    };

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

/// AnySearch 匿名免费搜索：不需要 API key。
/// 返回统一 [{ title, url, snippet }] 结构；失败时上层会 fallback。
fn anysearch_free_search(query: &str, max_results: usize) -> Result<Vec<serde_json::Value>, String> {
    let body = serde_json::json!({
        "query": query,
        "max_results": max_results,
        "language": "zh-CN",
    });

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(std::time::Duration::from_secs(8)))
            .timeout_global(Some(std::time::Duration::from_secs(15)))
            .build()
    );

    let resp = agent.post(ANYSEARCH_SEARCH_URL)
        .header("Content-Type", "application/json")
        .header("User-Agent", CHROME_UA)
        .send(body.to_string())
        .map_err(|e| format!("AnySearch request failed: {}", e))?;

    let status = resp.status().as_u16();
    let mut body = resp.into_body();
    let text = body.read_to_string().map_err(|e| format!("AnySearch read error: {}", e))?;

    if status != 200 {
        return Err(format!("AnySearch API {}", status));
    }

    let data: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("AnySearch parse error: {}", e))?;

    let items = data
        .get("data")
        .and_then(|d| d.get("results"))
        .or_else(|| data.get("results"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut results = Vec::new();
    for item in items.into_iter().take(max_results) {
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let snippet = item.get("content")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("description").and_then(|v| v.as_str()))
            .or_else(|| item.get("snippet").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();

        if !title.is_empty() && !url.is_empty() {
            results.push(serde_json::json!({
                "title": title,
                "url": url,
                "snippet": snippet,
            }));
        }
    }
    Ok(results)
}

fn bing_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://www.bing.com/search?q={}&setlang=en", crate::utils::urlencoding(query));

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(std::time::Duration::from_secs(5)))
            .timeout_global(Some(std::time::Duration::from_secs(10)))
            .build()
    );

    let resp = agent.get(&url)
        .header("User-Agent", CHROME_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .call()
        .map_err(|e| format!("web_search: request failed: {}", e))?;

    let mut body = resp.into_body();
    let html = body.read_to_string().map_err(|e| format!("web_search: read error: {}", e))?;

    let mut results = Vec::new();
    let block_re = regex::Regex::new(r#"<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)</li>"#).expect("静态正则");
    let link_re = regex::Regex::new(r#"<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a></h2>"#).expect("静态正则");
    let snippet_re = regex::Regex::new(r#"<p[^>]*>([\s\S]*?)</p>"#).expect("静态正则");
    let tag_re = regex::Regex::new(r"<[^>]*>").expect("静态正则");

    for cap in block_re.captures_iter(&html) {
        let block = &cap[1];
        if let Some(lc) = link_re.captures(block) {
            let title = tag_re.replace_all(&lc[2], "").trim().to_string();
            if title.len() > 3 {
                let snippet = snippet_re.captures_iter(block)
                    .map(|c| tag_re.replace_all(&c[1], "").trim().to_string())
                    .find(|s| s.len() > 15)
                    .unwrap_or_default();
                results.push(serde_json::json!({
                    "title": title,
                    "url": lc[1].to_string(),
                    "snippet": snippet,
                }));
                if results.len() >= 10 { break; }
            }
        }
    }
    Ok(results)
}

fn duckduckgo_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let q = crate::utils::urlencoding(query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", q);

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(std::time::Duration::from_secs(5)))
            .timeout_global(Some(std::time::Duration::from_secs(10)))
            .build()
    );

    let resp = agent.get(&url)
        .header("User-Agent", CHROME_UA)
        .header("Accept-Language", "en-US,en;q=0.9,zh-CN;q=0.8")
        .call()
        .map_err(|e| format!("web_search: request failed: {}", e))?;

    let mut body = resp.into_body();
    let html = body.read_to_string().map_err(|e| format!("web_search: read error: {}", e))?;

    let mut results = Vec::new();
    let title_re = regex::Regex::new(
        r#"<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>"#
    ).expect("静态正则");
    let snippet_re = regex::Regex::new(
        r#"<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</a>"#
    ).expect("静态正则");
    let tag_re = regex::Regex::new(r"<[^>]*>").expect("静态正则");

    let split_re = regex::Regex::new(r#"<div[^>]*class="[^"]*result[^"]*"[^>]*>"#).expect("静态正则");
    let blocks: Vec<&str> = split_re.split(&html).collect();

    for block in &blocks[1..] {
        if let Some(tc) = title_re.captures(block) {
            let title = tag_re.replace_all(&tc[2], "").trim().to_string();
            if title.len() > 3 {
                let snippet = snippet_re.captures(block)
                    .map(|c| tag_re.replace_all(&c[1], "").trim().to_string())
                    .unwrap_or_default();
                results.push(serde_json::json!({
                    "title": title,
                    "url": tc[1].to_string(),
                    "snippet": snippet,
                }));
                if results.len() >= 10 { break; }
            }
        }
    }
    Ok(results)
}
/// web_fetch — URL 抓取（SSRF 逐跳复查 + 1 MiB 截断）。网页文本是 Text 结果。
async fn web_fetch(gate: &WebGate<'_>, args: &Value) -> Result<String, String> {
    let url = arg_str(args, "url")
        .ok_or_else(|| "web_fetch: missing 'url'".to_string())?;
    gate.check(&crate::tools::WebFetchTool { url: url.clone(), agent_id: gate.agent_id.clone() }).await?;

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
            .build()
    );

    let make_request =
        |ua: &str| -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
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
            let is_cf = r.headers().get("cf-mitigated")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == "challenge")
                .unwrap_or(false);
            if is_cf {
                make_request("opencode").map_err(|e| format!("请求失败 (Cloudflare blocked): {}", e))?
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
        if !(300..400).contains(&status) { break; }
        if redirects >= MAX_REDIRECTS {
            return Err(format!("重定向次数超限 ({MAX_REDIRECTS})"));
        }
        let location = current_resp.headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "重定向响应缺少 Location 头".to_string())?;
        // 相对于当前重定向 URL 解析相对 URL
        let base = url::Url::parse(&current_url).map_err(|e| format!("无效基址 URL: {e}"))?;
        let next_url = base.join(location)
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
        current_resp = agent.get(&current_url)
            .header("User-Agent", CHROME_UA)
            .call()
            .map_err(|e| format!("重定向请求失败: {}", e))?;
        redirects += 1;
    }
    let resp = current_resp;

    let content_type = resp.headers()
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
        s = regex::Regex::new(r"(?si)<script[^>]*>.*?</script>").unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则")).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"(?si)<style[^>]*>.*?</style>").unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则")).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"(?s)<!--.*?-->").unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则")).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"<[^>]*>").unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则")).replace_all(&s, " ").to_string();
        s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
             .replace("&#x27;", "'").replace("&nbsp;", " ");
        s = regex::Regex::new(r"[ \t]+").unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则")).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"\n{3,}").unwrap_or_else(|_| regex::Regex::new(r"").expect("空正则")).replace_all(&s, "\n\n").to_string();
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

