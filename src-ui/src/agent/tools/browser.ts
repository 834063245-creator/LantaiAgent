// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════
// Browser 工具 — Agent「观察/操作前端页面」能力
// ═══════════════════════════════════════════════════════════
// 目标：不止自家 webview，更主要是用户日常使用的其他软件前端
// （Chrome / Edge / Electron / 其他 WebView2 应用）。
//
// 双通道（ADR 0003 D4 统一后端后，全部走 Rust CDP）：
//   - target=self → Rust cdp 模块惰性 attach 自家 webview 调试端口（只读）
//   - target 省略  → 各 Agent 自己的 CDP 会话（已 attach 的外部页面）
//
// 交互范式（ADR 0003 D2/D5）：
//   - snapshot 拿可交互元素清单（含 ref 编号），click/type/scroll 按 ref 引用；
//     不要手写 CSS selector（ref 失效会报错并提示重新 snapshot）。
//   - 操作自带 actionability 等待与反馈（URL 变化 / DOM 变化 / 新增错误）。
//   - console/network 查询页面事件（改 UI 后自查报错和请求状态）。
//
// 借鉴 HanaAgent computer-use 设计：能力声明（描述里写清能做什么）、
// 结果截断（防上下文爆炸）、语义化（不给裸坐标）。

// R4-2（kernel-capability-d4-handle-design.md，2026-09-05）：builtin.browser
// 插件随 browser 域收口退役——37 模型族工具 schema 真源回 TS zod
// （BROWSER_CAP_SCHEMA，逐键等价退役前 manifest 发射：键名/description 字节/
// int 界/enum/passthrough 全对齐，convergence 零漂移范式 = fs/git/shell 三域
// 先例）；execute 换 browser_cap 能力口直呼（不经 tool_call 信封）。口内闸 =
// BrowserTool 多层语义 + click/type_sensitive 运行时二次 Ask（Rust 强制层，
// D4-4/D4-5）；参数键：工具面 = manifest 语言 camelCase 不变（模型面契约），
// execute 层顶层 camel→snake 映射（BROWSER_CAP_SNAKE_KEYS 11 键）后直呼。
// 复合工具 browser_fill / browser_navigate_snapshot 保留在工具层：execute
// 逐字段调用细粒度动作（schema 仍 zod 定义）。

import { z } from 'zod';
import { typedRpc } from '../../rpc-contract';
import { errText } from '../loop-helpers';
import type { Tool } from '../tool';
import { agentInvoke } from '../tool';
import { defineTool, toInputJsonSchema } from './define-tool';
import { kernelManifestOf } from './manifest-tools';
import { parseStructuredError } from './structured-error';

// ═══════════════════════════════════════════════════════════
// 工具定义
// ═══════════════════════════════════════════════════════════

const MAX_RESULT_CHARS = 8000;

/** 截断提示的可选定制：只对支持分页/收窄参数的动作提示对应参数，避免误导。 */
function truncate(s: string, pageHint?: string): string {
  if (s.length <= MAX_RESULT_CHARS) return s;
  const hint = pageHint ?? '用 offset/maxResults/limit 参数翻页或收窄目标获取更多';
  return `${s.slice(0, MAX_RESULT_CHARS)}\n...[已截断，共 ${s.length} 字符；${hint}]`;
}

/**
 * 解析 Rust 侧结构化错误：`[CODE] message` → `{ code, message }`。
 * 无前缀（旧错误/权限引擎错误）返回 null，调用方回退原文。
 * （2026-08 泛化到 structured-error.ts，browser/desktop 共用；此别名防破坏既有导入。）
 */
export const parseBrowserError = parseStructuredError;

// ── browser_cap 能力口直呼（R4-2）──

/** browser_cap 契约见 rpc-contract.ts；action = 退役前 builtin.browser 37 工具名。 */
type BrowserCapAction = keyof typeof BROWSER_CAP_SCHEMA;

/** 工具面 camelCase → 口顶层 snake_case（D4-6 的 11 键表；单词小写键与
 *  meta `_agent_id`/`_owner_id` 不命中原样透传）。 */
const BROWSER_CAP_SNAKE_KEYS: Record<string, string> = {
  windowSize: 'window_size',
  proxyBypass: 'proxy_bypass',
  httpOnly: 'http_only',
  sameSite: 'same_site',
  targetId: 'target_id',
  maxResults: 'max_results',
  maxChars: 'max_chars',
  requestId: 'request_id',
  fullPage: 'full_page',
  deviceScaleFactor: 'device_scale_factor',
  promptText: 'prompt_text',
};

function snakeTopKeys(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[BROWSER_CAP_SNAKE_KEYS[k] ?? k] = v;
  return out;
}

/** browser_cap 直呼：is_agent 恒注入（agentInvoke 信封同款）；meta 键
 *  （_agent_id/_owner_id）原样透传（bridge.rpc() 对已是 snake 的键幂等）。 */
async function browserCapCall(action: BrowserCapAction, args: Record<string, unknown>): Promise<string> {
  return typedRpc('browser_cap', { action, is_agent: true, ...snakeTopKeys(args) });
}

// ═══════════════════════════════════════════════════════════════
// browser 域模型族 zod 真源（R4-2：builtin.browser 退役，schema/description/
// readOnly 自持——逐键等价退役前 manifest 发射，声明序 = createBrowserTools
// 装配字节契约序）。运行时校验回归能力口参数提取（Rust 口逐 action
// ok_or——与信封期插件侧同强度）；zod 只产 JSON Schema（模型面）。
// ═══════════════════════════════════════════════════════════════

const BROWSER_CAP_SCHEMA = {
  browser_launch: z.object({
    url: z.string().optional().describe('Optional URL to open in the controlled browser'),
    port: z
      .number()
      .int()
      .optional()
      .describe('Debug port (default: auto-probe from 9223; 9222 is reserved for 兰台 webview)'),
    headless: z.boolean().optional().describe('Run Chrome without a visible window (default false)'),
    windowSize: z
      .object({
        width: z.number().int().min(1).max(16384).describe('Window width in pixels'),
        height: z.number().int().min(1).max(16384).describe('Window height in pixels'),
      })
      .describe('Launch window size (--window-size=width,height)')
      .optional(),
    profile: z
      .string()
      .max(48)
      .optional()
      .describe('Named persistent account profile/session slot (e.g. "work"); omit for temporary default profile'),
    proxy: z.string().optional().describe('Chrome --proxy-server value (e.g. "socks5://127.0.0.1:1080")'),
    proxyBypass: z.string().optional().describe('Chrome --proxy-bypass-list value (e.g. "localhost;127.0.0.1")'),
  }),
  browser_connect: z.object({
    port: z.number().int().describe('Debug port of the running browser instance (e.g. 9223)'),
    session: z
      .string()
      .max(48)
      .optional()
      .describe('Optional account slot name to register this instance under (default: default)'),
  }),
  browser_sessions: z.object({}),
  browser_switch_session: z.object({
    session: z.string().max(48).describe('Account session slot name to activate'),
  }),
  browser_cookies: z.object({
    op: z.enum(['list', 'set', 'delete']).describe('Cookie operation'),
    urls: z
      .array(z.string())
      .optional()
      .describe('list: only return cookies for these URLs (default all cookies in this browser context)'),
    url: z.string().optional().describe('set/delete: cookie URL (either url or domain is required)'),
    name: z.string().optional().describe('set/delete: cookie name'),
    value: z.string().optional().describe('set: cookie value'),
    domain: z.string().optional().describe('set/delete: cookie domain (either url or domain is required)'),
    path: z.string().optional().describe('set/delete: cookie path (default /)'),
    httpOnly: z.boolean().optional().describe('set: HttpOnly flag'),
    secure: z.boolean().optional().describe('set: Secure flag'),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('set: SameSite restriction'),
    expires: z.number().optional().describe('set: expiration time in Unix seconds (default session cookie)'),
  }),
  browser_kill: z.object({}),
  browser_targets: z.object({}),
  browser_discover: z.object({}),
  browser_attach: z.object({
    targetId: z.string().describe('CDP target id from browser(targets) — not "self"'),
  }),
  browser_inspect: z.object({
    selector: z.string().describe('CSS selector (or ref number from snapshot) of element(s) to inspect'),
    props: z.array(z.string()).optional().describe('Optional subset: geometry/style/text/contrast'),
    maxResults: z.number().int().optional().describe('Max elements (default 20)'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_report: z.object({
    scope: z.string().optional().describe('Optional CSS selector to limit the scan (default: whole page)'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_snapshot: z.object({
    scope: z.string().optional().describe('Optional CSS selector to limit the snapshot (default: whole page)'),
    maxResults: z.number().int().optional().describe('Max elements per page (default 80)'),
    offset: z.number().int().optional().describe('Skip this many interactive elements (for paging; default 0)'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_content: z.object({
    scope: z.string().optional().describe('Optional CSS selector to limit extraction (default: whole page)'),
    format: z.enum(['text', 'markdown']).optional().describe('Output format: text (default) or markdown'),
    maxChars: z.number().int().min(1).max(20000).optional().describe('Max content characters per page (default 8000)'),
    offset: z.number().int().optional().describe('Skip this many content characters (for paging; default 0)'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_console: z.object({
    limit: z.number().int().optional().describe('Max entries (default 30)'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_network: z.object({
    limit: z.number().int().optional().describe('Max entries (default 30)'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_network_detail: z.object({
    requestId: z.string().describe('requestId from browser(network) entries'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_network_har: z.object({
    limit: z.number().int().min(1).max(200).optional().describe('Max entries to export (default 100; max 200)'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_screenshot: z.object({
    fullPage: z.boolean().optional().describe('Capture beyond the viewport (full scrollable page, default false)'),
    inline: z.boolean().optional().describe('Return a base64 data URL directly when <= 3MB (default false)'),
    target: z.string().optional().describe('"self" = 兰台 webview（只读）；省略 = 已 attach 的外部页面'),
  }),
  browser_viewport: z.object({
    width: z.number().int().min(1).max(16384).describe('Viewport width in CSS pixels'),
    height: z.number().int().min(1).max(16384).describe('Viewport height in CSS pixels'),
    deviceScaleFactor: z.number().min(0.5).max(3).optional().describe('Device pixel ratio (default 1)'),
    mobile: z.boolean().optional().describe('Emulate a mobile viewport (default false)'),
  }),
  browser_audit: z.object({
    limit: z.number().int().optional().describe('Max entries (default 50)'),
  }),
  browser_click: z.object({
    selector: z.string().describe('Ref number from snapshot or CSS selector of element to click'),
  }),
  browser_type: z.object({
    selector: z
      .string()
      .describe('Ref number from snapshot or CSS selector of input/textarea/contenteditable to focus'),
    text: z.string().describe('Text to type'),
    replace: z
      .boolean()
      .optional()
      .describe('Replace existing value before typing (clears then dispatches input/change events)'),
  }),
  browser_press: z.object({
    key: z.string().describe('Key name (Enter/Tab/Escape/ArrowUp/ArrowDown/... or single char)'),
    modifiers: z
      .array(z.enum(['ctrl', 'alt', 'shift', 'meta']))
      .optional()
      .describe('Modifier keys held during the press (e.g. ["ctrl"] + key "a" = Ctrl+A)'),
  }),
  browser_hover: z.object({
    selector: z.string().describe('Ref number from snapshot or CSS selector of element to hover'),
  }),
  browser_dialog: z.object({
    accept: z.boolean().optional().describe('Omit to query pending dialogs; true = accept, false = dismiss'),
    promptText: z.string().optional().describe('Text to enter for a prompt dialog'),
    limit: z.number().int().optional().describe('Max dialog entries when querying (default 10)'),
  }),
  browser_upload: z.object({
    files: z.array(z.string()).describe('Absolute local file paths to set'),
    selector: z
      .string()
      .optional()
      .describe('CSS selector (or ref) of the file input, required if no recent file chooser event'),
  }),
  browser_new_tab: z.object({
    url: z.string().optional().describe('URL to open in the new tab (default about:blank)'),
  }),
  browser_close_tab: z.object({
    targetId: z.string().describe('CDP target id of the tab to close'),
  }),
  browser_scroll: z.object({
    selector: z.string().optional().describe('Ref number or CSS selector to scroll into view'),
    direction: z.string().optional().describe('Page scroll direction: down/up/top'),
  }),
  browser_navigate: z.object({
    url: z.string().describe('URL to navigate to'),
  }),
  browser_back: z.object({}),
  browser_forward: z.object({}),
  browser_reload: z.object({}),
  browser_select: z.object({
    selector: z.string().describe('Ref number from snapshot or CSS selector of the <select> element'),
    value: z.string().describe('Option value (preferred) or visible option text'),
  }),
  browser_wait: z.object({
    selector: z.string().optional().describe('CSS selector to wait for (appears + visible)'),
    ms: z.number().int().optional().describe('Fixed sleep in milliseconds (capped at 30000)'),
  }),
  browser_eval: z.object({
    expr: z.string().describe('JS expression to evaluate'),
  }),
  browser_status: z.object({}),
} satisfies Record<string, z.ZodObject<z.ZodRawShape>>;

/** browser 域动作 → 模型面 description（manifest 字节转录）。 */
const BROWSER_CAP_DESCRIPTION: Record<BrowserCapAction, string> = {
  browser_launch:
    'Launch a controlled Chrome/Edge instance (isolated profile, never touches the user\'s daily browser data). Use before inspecting/operating external pages. Returns the debug port. If already running with the same launch shape, reuses it; changing port/headless/windowSize/profile/proxy restarts with the new shape. Pass url to open a specific page. headless mode runs with no visible UI. profile is a NAMED persistent profile (e.g. "work" or "personal"): each name is an isolated account session with its own cookies/logins, kept across kill/relaunch, and switchable with browser_switch_session. Omit profile for the default temporary profile that is deleted on kill. proxy uses Chrome --proxy-server (e.g. "socks5://127.0.0.1:1080"); proxyBypass sets --proxy-bypass-list.',
  browser_connect:
    'Connect to a browser instance the USER has already started with a remote debugging port (Chrome/Edge launched with --remote-debugging-port=NNNN, or a Chromium-based app exposing one). If the user did not provide a port, call browser_discover first to list instances and let the user pick one. Takes over that live instance with its real logins and data — requires user approval. After connect: targets → attach → snapshot/click as usual. session optionally registers the external instance as a named account slot for browser_switch_session. kill only disconnects (never kills a browser this agent did not launch). 9222 is refused (兰台 webview, read-only self channel).',
  browser_sessions:
    "List this agent's browser account sessions (slots) and which one is active. Each named profile launched with browser_launch(profile:...) is an isolated account session with its own cookies/logins. Returns {active, sessions:[{slot,active,port,chromeRunning,external,attached,headless,windowSize,proxy}]}.",
  browser_switch_session:
    'Switch the active browser account session by slot name (the profile name passed to browser_launch, or session passed to browser_connect). The previous session keeps running with its own cookies/logins; switch back to resume it. Use browser_sessions to see available slots first. To create a new account session use browser_launch(profile: "name").',
  browser_cookies:
    'Inspect or modify cookies in the active browser session. list: read cookies (all, or filtered by urls). set: write one cookie (url or domain required). delete: remove one cookie (name + url/domain required). Cookie values are truncated to 300 chars in list output; writing/deleting cookies changes login state and requires approval.',
  browser_kill:
    'Terminate the controlled Chrome instance launched by this agent in the ACTIVE account session. Only kills the Chrome this agent launched. Named profile directories are kept so the login state can be relaunched/restored.',
  browser_targets:
    'List all page targets available on the CDP port — [{id, title, url}]. Use after launch to see what pages exist, then attach to one.',
  browser_discover:
    'Discover Chromium-based instances on this machine that have a debug port open — queries the process table, so the USER does not need to know or report any port. Returns {instances:[{browser, port, pages:[{id,title,url}]}]}. Use BEFORE browser_connect when the user says "operate my browser" without a port: list the instances to the user, let them pick, then connect(port). 兰台 webview (9222) is filtered out.',
  browser_attach:
    'Attach to a specific page target (by id from browser_targets) so subsequent inspect/click/type/press/scroll/eval act on it. This is also how you switch between open tabs: pick another targetId from browser_targets and attach. This takes control of an external page — requires user approval. Note: targetId is the CDP target id; the "target" parameter (self vs external) is separate.',
  browser_inspect:
    'Read element geometry/style/text/contrast from the attached page using a CSS selector (or snapshot ref number). Returns JSON array: {tag, id, rect{x,y,width,height}, visible, scrollable, style{color,background,fontSize,...}, text, contrast}. props: optional subset of ["geometry","style","text","contrast"]. maxResults caps elements (default 20). Use to verify visual details after UI changes.',
  browser_report:
    'Visual lint report on the attached page (or scope selector) — checks contrast (WCAG 4.5:1), spacing scale (4/8/12/16/24/32), alignment, hierarchy (overused shadows), overflow. Returns {issues:[{rule,severity,detail,selector}], ok}. Use AFTER modifying UI code to self-review the rendered result.',
  browser_snapshot:
    'Snapshot interactive elements on the attached page — returns {source, refs:[{ref,tag,role,name,text,type?,id?}], count, total, offset, truncated}. Prefers Chrome Accessibility.getFullAXTree (source:"ax"); falls back to an enhanced DOM probe that traverses same-origin iframes and shadow DOM and computes accessible names (aria-label/labelledby/label/alt/title/placeholder). Marks elements with ref numbers; use these ref numbers in click/type/select/hover/scroll (e.g. selector: "37"). Refs are valid until the DOM changes — if an operation fails with "target gone", re-snapshot. If truncated is true there are more elements below — call again with offset to page (e.g. offset: 80 for page 2, 160 for page 3). PREFERRED over hand-written CSS selectors.',
  browser_content:
    'Extract page text content from the attached page — always returns {title, url, format}. format "text" (default) returns cleaned innerText; "markdown" returns a lightweight markdown conversion (headings/lists/links/images/tables). scope limits extraction to a CSS selector. Pagination is character-based: maxChars (default 8000, max 20000) + offset reads the next chunk. Use instead of browser_eval for readable page body.',
  browser_console:
    'Read recent page console events (console.log/error, exceptions, Log.entryAdded) from the attached page. Use after UI changes or operations to check for new errors. Returns {entries:[{type,text}]}.',
  browser_network:
    'Read recent network events (requests/responses/failures) from the attached page. Requests and responses are paired by requestId: one entry has method/url/status/mimeType/error, with status null while pending and error set on load failure. Returns {entries:[{requestId,method,url,status,mimeType,resourceType,error}], paired:true}.',
  browser_network_detail:
    'Read full detail for one observed network request by requestId (from browser_network): complete URL, method, status/statusText/mimeType, request+response headers, postData (capped), error. Only requests still inside the 200-entry event buffer are available. HAR export is not implemented yet.',
  browser_network_har:
    'Export recently observed network events from the attached page to a HAR 1.2 file in the temp directory. Returns {path, bytes, entries}. Includes URL, request/response headers, queryString, postData, status and mimeType; timing fields are -1 because the event observer does not sample timings. Use fs(read) or hand the path to the user when a full request archive is needed.',
  browser_screenshot:
    'Capture a screenshot of the attached page — saved to a temp file, returns {path, bytes}. With a text-only model the image content is not visible; hand the path to the user for confirmation.',
  browser_viewport:
    'Set viewport metrics on the attached page via Emulation.setDeviceMetricsOverride: width/height in CSS px, deviceScaleFactor (0.5-3, default 1) and mobile emulation flag (default false). This is the CDP viewport override, separate from browser_launch windowSize (the physical window).',
  browser_audit:
    'Read the browser operation audit log — which agent did what (click/type/launch/attach), when, and the outcome. Use to review what the Agent has done in the browser.',
  browser_click:
    'Click an element in the attached page by snapshot ref number (e.g. selector: "37") or CSS selector. Waits for the element to be actionable (visible/unobscured/stable) before clicking. Returns world-change feedback (URL/DOM changes, new errors). Sensitive targets (submit buttons, download links, confirm/pay/delete text) trigger a separate approval.',
  browser_type:
    'Type text into an input in the attached page by snapshot ref number (e.g. selector: "37") or CSS selector. Focuses the element then inserts text (Chinese/IME friendly). Set replace:true to clear the existing value first (dispatches input/change events). Typing into a pre-filled input or password field triggers a separate approval.',
  browser_press: 'Press a key in the attached page: Enter / Tab / Escape / Backspace / Arrow keys / single characters.',
  browser_hover:
    'Hover the mouse over an element in the attached page by ref number or CSS selector. Waits for the element to be actionable, then moves the mouse to its center (for hover menus/tooltips/:hover styles).',
  browser_dialog:
    'Inspect or handle a JavaScript dialog (alert/confirm/prompt) on the attached page. Call without accept to query recent dialogs and whether one is pending. Call with accept:true to accept, accept:false to dismiss; promptText answers a prompt.',
  browser_upload:
    'Set files on an <input type=file> in the attached page. If a file chooser was recently opened, its intercepted backend node is used; otherwise pass a CSS selector (or ref) to the input. files are local absolute paths.',
  browser_new_tab:
    'Open a new tab in the current browser session and auto-attach to it. Pass url to open a page (default about:blank). Use browser_targets + browser_attach to switch tabs later.',
  browser_close_tab:
    'Close a browser tab by targetId (from browser_targets). If it is the currently attached tab, the session becomes unattached — list targets and attach another.',
  browser_scroll:
    'Scroll the attached page: pass selector (ref number or CSS selector) to scroll element into view, or direction (down/up/top) for page scroll.',
  browser_navigate:
    'Navigate the attached page to a URL (Page.navigate). Returns world-change feedback after the navigation settles. Use for normal page navigation after attach.',
  browser_back: 'Go back one entry in the attached page navigation history. Returns {navigated:"back", url, change}.',
  browser_forward:
    'Go forward one entry in the attached page navigation history. Returns {navigated:"forward", url, change}.',
  browser_reload: 'Reload the attached page (Page.reload). Returns {reloaded:true, url, change}.',
  browser_select:
    'Select an <option> in a <select> element on the attached page by ref number or CSS selector. value matches option value first, then visible option text. Dispatches input/change events. Returns {selected, value, change}.',
  browser_wait:
    'Wait — either wait a fixed number of ms, or wait until a CSS selector appears and is visible (default 10s timeout). Use after clicking an async-triggering button when the result takes a moment to load. Pass ms for a fixed sleep; pass selector to poll for it to become visible. Returns {found, selector?, waited_ms}. Does not change state.',
  browser_eval:
    'Execute a JS expression in the attached page (read-oriented; network/storage/new-window calls blocked by whitelist). Returns the value as JSON. Prefer browser_inspect for DOM reading.',
  browser_status:
    'Current browser session status — port, attached target, controlled Chrome running, observer alive, pending dialog/file chooser.',
};

/** browser 域动作 → readOnly（manifest 字节转录）。 */
const BROWSER_CAP_READONLY: Record<BrowserCapAction, boolean> = {
  browser_launch: false,
  browser_connect: false,
  browser_sessions: true,
  browser_switch_session: false,
  browser_cookies: false,
  browser_kill: false,
  browser_targets: true,
  browser_discover: true,
  browser_attach: false,
  browser_inspect: true,
  browser_report: true,
  browser_snapshot: true,
  browser_content: true,
  browser_console: true,
  browser_network: true,
  browser_network_detail: true,
  browser_network_har: true,
  browser_screenshot: true,
  browser_viewport: false,
  browser_audit: true,
  browser_click: false,
  browser_type: false,
  browser_press: false,
  browser_hover: false,
  browser_dialog: false,
  browser_upload: false,
  browser_new_tab: false,
  browser_close_tab: false,
  browser_scroll: false,
  browser_navigate: false,
  browser_back: false,
  browser_forward: false,
  browser_reload: false,
  browser_select: false,
  browser_wait: true,
  browser_eval: false,
  browser_status: true,
};

/** browser 域模型族工具（R4-2 起 zod 真源，不查 builtin.browser 镜像）；
 *  TS 工具名保持历史名（模型面契约）；execute 走 browser_cap 直呼。 */
function browserCapTool(action: BrowserCapAction): Tool {
  const schema = BROWSER_CAP_SCHEMA[action];
  const parameters = toInputJsonSchema(schema.passthrough());
  return {
    name: () => action,
    description: () => BROWSER_CAP_DESCRIPTION[action],
    parameters: () => parameters,
    readOnly: () => BROWSER_CAP_READONLY[action] ?? false,
    execute: (args) => runBrowserAction(action, args),
  };
}

/** 执行 browser 动作（browser_cap 直呼）。self → webview 只读通道；外部 →
 *  各 Agent CDP 会话（路由语义在 Rust 口内）。 */
async function runBrowserAction(action: BrowserCapAction, args: Record<string, unknown>): Promise<string> {
  const pageHint =
    action === 'browser_snapshot'
      ? '用 snapshot 的 offset/maxResults 翻页，或 scope 收窄范围'
      : action === 'browser_content'
        ? '用 content 的 offset/maxChars 翻页'
        : undefined;
  try {
    const result = await browserCapCall(action, args);
    return truncate(result ?? '', pageHint);
  } catch (e) {
    const raw = errText(e);
    const parsed = parseBrowserError(raw);
    // 结构化错误：模型读人话 message，code 保留在方括号内供测试/路由。
    // 消息用短动作名（退役前信封路径的字节契约——模型可见输出零漂移）。
    const short = action.startsWith('browser_') ? action.slice('browser_'.length) : action;
    return parsed ? `[browser] ${short} 失败 [${parsed.code}]: ${parsed.message}` : `[browser] ${short} 失败: ${raw}`;
  }
}

export function createBrowserTools(): Tool[] {
  return [
    browserCapTool('browser_launch'),
    browserCapTool('browser_connect'),
    browserCapTool('browser_discover'),
    browserCapTool('browser_targets'),
    browserCapTool('browser_kill'),
    browserCapTool('browser_sessions'),
    browserCapTool('browser_switch_session'),
    browserCapTool('browser_cookies'),
    browserCapTool('browser_attach'),
    browserCapTool('browser_new_tab'),
    browserCapTool('browser_close_tab'),
    browserCapTool('browser_navigate'),
    browserCapTool('browser_back'),
    browserCapTool('browser_forward'),
    browserCapTool('browser_reload'),
    browserCapTool('browser_snapshot'),
    browserCapTool('browser_content'),
    browserCapTool('browser_inspect'),
    browserCapTool('browser_report'),
    browserCapTool('browser_console'),
    browserCapTool('browser_network'),
    browserCapTool('browser_network_detail'),
    browserCapTool('browser_network_har'),
    browserCapTool('browser_click'),
    browserCapTool('browser_hover'),
    browserCapTool('browser_type'),
    browserCapTool('browser_select'),
    browserCapTool('browser_upload'),
    browserCapTool('browser_dialog'),
    browserCapTool('browser_press'),
    browserCapTool('browser_scroll'),
    browserCapTool('browser_viewport'),
    defineTool({
      name: 'browser_fill',
      description:
        'Fill MULTIPLE inputs in one round on the attached page — fields: [{selector, text, replace?}]. ' +
        'Each field follows browser_type semantics (ref number or CSS selector; replace clears first). ' +
        'Returns per-field outcome. Use for forms/logins to save round-trips; ' +
        'each field still honors sensitive-input approval (pre-filled/password fields ask separately).',
      schema: z.object({
        fields: z
          .array(
            z.object({
              selector: z.string().describe('Ref number from snapshot or CSS selector of the input'),
              text: z.string().describe('Text to type'),
              replace: z.boolean().optional().describe('Replace existing value first (default false)'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Fields to fill, in order'),
      }),
      execute: async (a) => {
        const results: string[] = [];
        for (const f of a.fields) {
          const r = await runBrowserAction('browser_type', { selector: f.selector, text: f.text, replace: f.replace });
          results.push(`[${f.selector}] ${r}`);
        }
        return `browser_fill 完成 ${a.fields.length} 个字段：\n${results.join('\n')}\n提示：用 browser_snapshot 复核表单状态。`;
      },
    }),

    defineTool({
      name: 'browser_navigate_snapshot',
      description:
        'Navigate the attached page to a URL and return the interactive-element snapshot of the resulting page in ONE round ' +
        '(navigate settles → snapshot). Equivalent to browser_navigate followed by browser_snapshot, saving a turn. ' +
        'Returns navigation feedback (URL/DOM changes) plus the ref list to act on.',
      schema: z.object({
        url: z.string().describe('URL to navigate to'),
        maxResults: z.number().int().optional().describe('Max elements in the snapshot (default 80)'),
      }),
      execute: async (a) => {
        const nav = await runBrowserAction('browser_navigate', { url: a.url });
        const snap = await runBrowserAction('browser_snapshot', { maxResults: a.maxResults });
        return `== navigation ==\n${nav}\n\n== snapshot ==\n${snap}`;
      },
    }),

    browserCapTool('browser_wait'),
    browserCapTool('browser_eval'),
    browserCapTool('browser_screenshot'),
    browserCapTool('browser_audit'),
    browserCapTool('browser_status'),
  ];
}

// ═══════════════════════════════════════════════════════════
// Desktop 领域（进程/窗口/控制台可见性快照 + UIA 控制）
// ═══════════════════════════════════════════════════════════
// 与 CDP 刻意不同：不连浏览器、不做持续 observer、不订阅事件。
// 按需取一帧快照，用于定位「某进程带了可见控制台窗口」这类问题
// （如语言服务器启动弹 cmd 窗口）。probe 只读放行；screenshot 高隐私面，
// 需单独权限确认（Rust 侧 DesktopTool 强制 Ask——P2-5 起在 builtin.uia 插件内）。

const DESKTOP_ACTION_TOOL: Record<string, string> = {
  probe: 'desktop_probe',
  screenshot: 'desktop_screenshot',
  uia_tree: 'desktop_uia_tree',
  uia_find: 'desktop_uia_find',
  uia_read: 'desktop_uia_read',
  uia_wait: 'desktop_uia_wait',
  uia_click: 'desktop_uia_click',
  uia_right_click: 'desktop_uia_right_click',
  uia_type: 'desktop_uia_type',
  uia_select: 'desktop_uia_select',
  uia_expand: 'desktop_uia_expand',
  uia_scroll: 'desktop_uia_scroll',
  uia_keys: 'desktop_uia_keys',
  uia_activate: 'desktop_uia_activate',
  uia_window_shot: 'desktop_uia_window_shot',
  audit: 'desktop_audit',
  status: 'desktop_status',
};

/** 信封化执行（P2-5）：agentInvoke('tool_call', { plugin, tool, args })——
 *  args 键 = manifest schema 键（desktop snake_case，原样透传）；
 *  isAgent 由 agentInvoke 恒注入。（builtin.uia 随 R4-3 换 uia_cap 直呼。） */
async function envelopeCall(plugin: string, tool: string, args: Record<string, unknown>): Promise<string> {
  return agentInvoke<string>('tool_call', { plugin, tool, args });
}

/** manifest 驱动的桌面域工具（builtin.uia）——desktop 面 schema 键为 snake_case。 */
function desktopManifestTool(toolName: string, run: (args: Record<string, unknown>) => Promise<string>): Tool {
  const manifest = kernelManifestOf('builtin.uia');
  const spec = manifest.tools.find((t) => t.name === toolName);
  if (!spec) throw new Error(`manifest-tools: 插件 'builtin.uia' 无工具 '${toolName}'`);
  const parameters = spec.schema;
  return {
    name: () => toolName,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => spec.read_only ?? false,
    execute: (args, _onProgress, _signal) => run(args as Record<string, unknown>),
  };
}

async function runDesktopAction(action: string, args: Record<string, unknown>): Promise<string> {
  const toolName = DESKTOP_ACTION_TOOL[action];
  if (!toolName) return `[desktop] unsupported action "${action}"`;
  const pageHint =
    action === 'uia_tree' ? '用 uia_tree 的 offset/max_results 翻页、depth 限层或 name 查找收窄' : undefined;
  try {
    const result = await envelopeCall('builtin.uia', toolName, args);
    return truncate(result ?? '', pageHint);
  } catch (e) {
    const raw = errText(e);
    const parsed = parseBrowserError(raw);
    return parsed ? `[desktop] ${action} 失败 [${parsed.code}]: ${parsed.message}` : `[desktop] ${action} 失败: ${raw}`;
  }
}

export function createDesktopTools(): Tool[] {
  const run = (action: string, args: Record<string, unknown>) => runDesktopAction(action, args);
  return [
    desktopManifestTool('desktop_probe', (args) => run('probe', args)),
    desktopManifestTool('desktop_screenshot', (args) => run('screenshot', args)),
    desktopManifestTool('desktop_uia_tree', (args) => run('uia_tree', args)),
    desktopManifestTool('desktop_uia_find', (args) => run('uia_find', args)),
    desktopManifestTool('desktop_uia_read', async (a) => {
      if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
        return '[desktop_uia_read] 至少要给一个定位条件: ref / name / automation_id / control_type';
      }
      return run('uia_read', a);
    }),
    desktopManifestTool('desktop_uia_wait', async (a) => {
      if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
        return '[desktop_uia_wait] 至少要给一个定位条件: ref / name / automation_id / control_type';
      }
      return run('uia_wait', a);
    }),
    desktopManifestTool('desktop_uia_click', async (a) => {
      if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
        return '[desktop_uia_click] 至少要给一个定位条件: ref / name / automation_id / control_type';
      }
      return run('uia_click', a);
    }),
    desktopManifestTool('desktop_uia_right_click', async (a) => {
      if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
        return '[desktop_uia_right_click] 至少要给一个定位条件: ref / name / automation_id / control_type';
      }
      return run('uia_right_click', a);
    }),
    desktopManifestTool('desktop_uia_type', async (a) => {
      if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
        return '[desktop_uia_type] 至少要给一个定位条件: ref / name / automation_id / control_type';
      }
      return run('uia_type', a);
    }),
    desktopManifestTool('desktop_uia_select', async (a) => {
      if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
        return '[desktop_uia_select] 至少要给一个定位条件: ref / name / automation_id / control_type';
      }
      return run('uia_select', a);
    }),
    desktopManifestTool('desktop_uia_expand', async (a) => {
      if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
        return '[desktop_uia_expand] 至少要给一个定位条件: ref / name / automation_id / control_type';
      }
      return run('uia_expand', a);
    }),
    desktopManifestTool('desktop_uia_scroll', async (a) => {
      if (a.ref === undefined && !a.name && !a.automation_id && !a.control_type) {
        return '[desktop_uia_scroll] 至少要给一个定位条件: ref / name / automation_id / control_type';
      }
      return run('uia_scroll', a);
    }),
    desktopManifestTool('desktop_uia_keys', (args) => run('uia_keys', args)),
    desktopManifestTool('desktop_uia_activate', (args) => run('uia_activate', args)),
    defineTool({
      name: 'desktop_uia_fill',
      description:
        'Fill MULTIPLE desktop controls in one round — fields: [{ref/name/automation_id/control_type, text}]. ' +
        'Each field follows desktop_uia_type semantics (ValuePattern.SetValue preferred, world-diff per field). ' +
        'Window takeover asks once for the batch; pre-filled/password fields still ask separately. ' +
        'Returns per-field outcome (value before→after, password-masked).',
      schema: z.object({
        fields: z
          .array(
            z.object({
              ref: z.number().int().optional().describe('Control ref from desktop_uia_tree/find'),
              name: z.string().optional().describe('Control name, exact match case-insensitive'),
              automation_id: z.string().optional().describe('Exact automation id'),
              control_type: z.string().optional().describe('ControlType, e.g. Edit'),
              text: z.string().describe('Text to type'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Fields to fill, in order'),
        hwnd: z.number().int().optional().describe('Window handle'),
        pid: z.number().int().optional().describe('Process id'),
        title: z.string().optional().describe('Window title substring'),
      }),
      execute: async (a) => {
        const windowArgs = { hwnd: a.hwnd, pid: a.pid, title: a.title };
        const results: string[] = [];
        for (const f of a.fields) {
          if (f.ref === undefined && !f.name && !f.automation_id && !f.control_type) {
            results.push('[skip] 字段缺少定位条件 (ref/name/automation_id/control_type)');
            continue;
          }
          const r = await runDesktopAction('uia_type', {
            ...windowArgs,
            ref: f.ref,
            name: f.name,
            automation_id: f.automation_id,
            control_type: f.control_type,
            text: f.text,
          });
          results.push(`[${f.ref ?? f.name ?? f.automation_id ?? f.control_type}] ${r}`);
        }
        return `desktop_uia_fill 完成 ${results.length} 个字段：\n${results.join('\n')}`;
      },
    }),

    desktopManifestTool('desktop_uia_window_shot', (args) => run('uia_window_shot', args)),
    desktopManifestTool('desktop_audit', (args) => run('audit', args)),
    desktopManifestTool('desktop_status', (args) => run('status', args)),
  ];
}
