// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! builtin.web 插件——内核插件运行时 Phase 1 续批（自 commands/web.rs 拆出）。
//! 工具面（名称/描述/schema）真源 = 同目录 manifest.json（双端共享）。
//! web_fetch 的 WebFetchTool 权限语义（域名规则 + SSRF + Ask 事件）原样保留在插件内；
//! web_search 沿用原实现：以兜底搜索页 URL 过 WebFetch 权限（AnySearch 是后端
//! API，仍受同一 Web 域权限约束）。

use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{arg_str, arg_usize, ToolContext, ToolError, ToolPlugin};

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

fn search_backend() -> &'static str {
    match std::env::var("HOLOGRAM_SEARCH_BACKEND").as_deref() {
        Ok("bing") => "bing",
        _ => "duckduckgo",
    }
}

const ANYSEARCH_SEARCH_URL: &str = "https://api.anysearch.com/v1/search";

pub struct WebPlugin {
    manifest: ToolManifest,
}

impl WebPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.web manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for WebPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for WebPlugin {
    fn id(&self) -> &str {
        "builtin.web"
    }

    fn manifest(&self) -> &ToolManifest {
        &self.manifest
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a ToolContext<'a>,
        tool_name: &'a str,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, ToolError>> + Send + 'a>,
    > {
        Box::pin(async move {
            match tool_name {
                "web_search" => web_search(ctx, &args).await,
                "web_fetch" => web_fetch(ctx, &args).await,
                other => Err(ToolError::InvalidArgs(format!(
                    "builtin.web: 未知工具 '{other}'"
                ))),
            }
        })
    }
}

/// web_search — AnySearch 免费 API + Bing/DuckDuckGo 抓取兜底（业务自 commands/web.rs
/// 原样迁入；参数键改说 manifest schema 的语言，camelCase）。
async fn web_search(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("web_search: missing '{k}'"));
    let query = arg_str(args, "query").ok_or_else(|| missing("query"))?;
    let max_results = arg_usize(args, "maxResults").unwrap_or(10).clamp(1, 10);

    // 权限检查沿用原有搜索页 URL（AnySearch 是后端 API，仍受同一 Web 域权限约束）。
    let backend = search_backend();
    let fallback_url = match backend {
        "bing" => format!("https://www.bing.com/search?q={}&setlang=en", crate::utils::urlencoding(&query)),
        _ => format!("https://html.duckduckgo.com/html/?q={}", crate::utils::urlencoding(&query)),
    };
    {
        let tool = crate::tools::WebFetchTool { url: fallback_url, agent_id: ctx.agent_id.clone() };
        ctx.check_permission(&tool).await.map_err(ToolError::Permission)?;
    }

    // 1) 先尝试 AnySearch 匿名免费 API（无需用户配置任何 key）
    // 2) 失败/空结果时自动降级到 Bing / DuckDuckGo 页面抓取
    let results = match anysearch_free_search(&query, max_results) {
        Ok(results) if !results.is_empty() => results,
        _ => match backend {
            "bing" => bing_search(&query).map_err(ToolError::Tool)?,
            _ => duckduckgo_search(&query).map_err(ToolError::Tool)?,
        },
    };

    if results.is_empty() {
        return Ok(serde_json::json!({
            "query": query,
            "results": [],
            "error": "No results found.",
        }));
    }

    Ok(serde_json::json!({
        "query": query,
        "results": &results[..results.len().min(max_results)],
    }))
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

/// web_fetch — URL 抓取（业务自 commands/web.rs 原样迁入；SSRF 逐跳复查 + 1 MiB 截断）。
/// 网页文本是 Text 结果——返回 Value::String，分派处字节精确直通（不再 JSON 引号包裹）。
async fn web_fetch(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("web_fetch: missing '{k}'"));
    let url = arg_str(args, "url").ok_or_else(|| missing("url"))?;
    {
        let tool = crate::tools::WebFetchTool { url: url.clone(), agent_id: ctx.agent_id.clone() };
        ctx.check_permission(&tool).await.map_err(ToolError::Permission)?;
    }

    let parsed = url::Url::parse(&url).map_err(|e| ToolError::InvalidArgs(format!("无效 URL: {}", e)))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(ToolError::InvalidArgs(format!("不支持的协议: {}", scheme)));
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() || crate::utils::is_private_ip(host) {
        return Err(ToolError::Permission("SSRF 防护: 不允许访问内网地址".to_string()));
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
                make_request("opencode").map_err(|e| ToolError::Tool(format!("请求失败 (Cloudflare blocked): {}", e)))?
            } else {
                r
            }
        }
        Err(e) => return Err(ToolError::Tool(format!("请求失败: {}", e))),
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
            return Err(ToolError::Tool(format!("重定向次数超限 ({MAX_REDIRECTS})")));
        }
        let location = current_resp.headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ToolError::Tool("重定向响应缺少 Location 头".to_string()))?;
        // 相对于当前重定向 URL 解析相对 URL
        let base = url::Url::parse(&current_url).map_err(|e| ToolError::InvalidArgs(format!("无效基址 URL: {e}")))?;
        let next_url = base.join(location)
            .map_err(|e| ToolError::InvalidArgs(format!("无效重定向 URL: {e}")))?;
        let next_scheme = next_url.scheme();
        if next_scheme != "https" && next_scheme != "http" {
            return Err(ToolError::InvalidArgs(format!("重定向到不支持的协议: {}", next_scheme)));
        }
        let next_host = next_url.host_str().unwrap_or("");
        if next_host.is_empty() || crate::utils::is_private_ip(next_host) {
            return Err(ToolError::Permission("SSRF 防护: 重定向到内网地址被拒绝".to_string()));
        }
        // 跟随重定向
        current_url = next_url.to_string();
        current_resp = agent.get(&current_url)
            .header("User-Agent", CHROME_UA)
            .call()
            .map_err(|e| ToolError::Tool(format!("重定向请求失败: {}", e)))?;
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
        .map_err(|e| ToolError::Tool(format!("读取失败: {}", e)))?;
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
    Ok(Value::String(out))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.web");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.capabilities, vec!["network".to_string()]);
        let search = m.tools.iter().find(|t| t.name == "web_search").expect("web_search 在清单内");
        assert!(search.read_only);
        // maxResults 并入 schema（2026-09-03 并行窗口 64b56542 批，转录随迁）。
        assert!(search.schema["properties"]["maxResults"]["maximum"].as_u64() == Some(10));
        let fetch = m.tools.iter().find(|t| t.name == "web_fetch").expect("web_fetch 在清单内");
        assert!(fetch.read_only);
        assert_eq!(fetch.schema["required"][0].as_str(), Some("url"));
    }

    #[test]
    fn parse_charset_extracts_label() {
        assert_eq!(parse_charset("text/html; charset=GBK"), Some("gbk".into()));
        assert_eq!(parse_charset(r#"text/html; charset="utf-8""#), Some("utf-8".into()));
        assert_eq!(parse_charset("text/plain"), None);
    }

    #[test]
    fn decode_body_uses_declared_charset() {
        // GBK 编码的 "你好"（C4 E3 BA C3）。
        let gbk = [0xC4u8, 0xE3, 0xBA, 0xC3];
        assert_eq!(decode_body(&gbk, Some("gbk")), "你好");
        // 未声明 → UTF-8 宽容回退。
        assert_eq!(decode_body("hi".as_bytes(), None), "hi");
        assert!(decode_body(&[0xFF, 0xFE], None).contains('�'));
    }

    #[test]
    fn read_capped_distinguishes_exact_cap_from_truncation() {
        let exact = std::io::Cursor::new(vec![b'a'; 16]);
        let (buf, truncated) = read_capped(exact, 16).unwrap();
        assert_eq!(buf.len(), 16);
        assert!(!truncated, "恰好到 cap 不应判截断");

        let over = std::io::Cursor::new(vec![b'a'; 17]);
        let (buf, truncated) = read_capped(over, 16).unwrap();
        assert_eq!(buf.len(), 16);
        assert!(truncated);
    }
}
