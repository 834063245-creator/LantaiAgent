// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 生成物 — scripts/gen-plugin-manifests.cjs 从 src-tauri/src/tool_plugins/*/manifest.json 生成。
// 真源在 Rust 侧 manifest；改动请改 manifest 后重新生成（npm run gen:plugin-manifests），勿手改。
// schema 键序 = zod 发射序（convergence 字节契约），生成器逐字保留，勿规整。

import type { KernelToolManifest } from './manifest-tools';

export const KERNEL_MANIFESTS: readonly KernelToolManifest[] = [
  {
    "id": "builtin.browser",
    "version": "1.0.0",
    "trust": "system",
    "description": "CDP 浏览器控制（自 rpc.rs CDP 分区拆出，kernel-plugin-runtime P2-5）",
    "capabilities": [
      "network"
    ],
    "tools": [
      {
        "name": "browser_launch",
        "description": "Launch a controlled Chrome/Edge instance (isolated profile, never touches the user's daily browser data). Use before inspecting/operating external pages. Returns the debug port. If already running with the same launch shape, reuses it; changing port/headless/windowSize/profile/proxy restarts with the new shape. Pass url to open a specific page. headless mode runs with no visible UI. profile is a NAMED persistent profile (e.g. \"work\" or \"personal\"): each name is an isolated account session with its own cookies/logins, kept across kill/relaunch, and switchable with browser_switch_session. Omit profile for the default temporary profile that is deleted on kill. proxy uses Chrome --proxy-server (e.g. \"socks5://127.0.0.1:1080\"); proxyBypass sets --proxy-bypass-list.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "url": {
              "description": "Optional URL to open in the controlled browser",
              "type": "string"
            },
            "port": {
              "description": "Debug port (default: auto-probe from 9223; 9222 is reserved for 兰台 webview)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "headless": {
              "description": "Run Chrome without a visible window (default false)",
              "type": "boolean"
            },
            "windowSize": {
              "description": "Launch window size (--window-size=width,height)",
              "type": "object",
              "properties": {
                "width": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 16384,
                  "description": "Window width in pixels"
                },
                "height": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 16384,
                  "description": "Window height in pixels"
                }
              },
              "required": [
                "width",
                "height"
              ]
            },
            "profile": {
              "description": "Named persistent account profile/session slot (e.g. \"work\"); omit for temporary default profile",
              "type": "string",
              "maxLength": 48
            },
            "proxy": {
              "description": "Chrome --proxy-server value (e.g. \"socks5://127.0.0.1:1080\")",
              "type": "string"
            },
            "proxyBypass": {
              "description": "Chrome --proxy-bypass-list value (e.g. \"localhost;127.0.0.1\")",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_connect",
        "description": "Connect to a browser instance the USER has already started with a remote debugging port (Chrome/Edge launched with --remote-debugging-port=NNNN, or a Chromium-based app exposing one). If the user did not provide a port, call browser_discover first to list instances and let the user pick one. Takes over that live instance with its real logins and data — requires user approval. After connect: targets → attach → snapshot/click as usual. session optionally registers the external instance as a named account slot for browser_switch_session. kill only disconnects (never kills a browser this agent did not launch). 9222 is refused (兰台 webview, read-only self channel).",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "port": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991,
              "description": "Debug port of the running browser instance (e.g. 9223)"
            },
            "session": {
              "description": "Optional account slot name to register this instance under (default: default)",
              "type": "string",
              "maxLength": 48
            }
          },
          "required": [
            "port"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_sessions",
        "description": "List this agent's browser account sessions (slots) and which one is active. Each named profile launched with browser_launch(profile:...) is an isolated account session with its own cookies/logins. Returns {active, sessions:[{slot,active,port,chromeRunning,external,attached,headless,windowSize,proxy}]}.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_switch_session",
        "description": "Switch the active browser account session by slot name (the profile name passed to browser_launch, or session passed to browser_connect). The previous session keeps running with its own cookies/logins; switch back to resume it. Use browser_sessions to see available slots first. To create a new account session use browser_launch(profile: \"name\").",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session": {
              "type": "string",
              "maxLength": 48,
              "description": "Account session slot name to activate"
            }
          },
          "required": [
            "session"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_cookies",
        "description": "Inspect or modify cookies in the active browser session. list: read cookies (all, or filtered by urls). set: write one cookie (url or domain required). delete: remove one cookie (name + url/domain required). Cookie values are truncated to 300 chars in list output; writing/deleting cookies changes login state and requires approval.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "op": {
              "type": "string",
              "enum": [
                "list",
                "set",
                "delete"
              ],
              "description": "Cookie operation"
            },
            "urls": {
              "description": "list: only return cookies for these URLs (default all cookies in this browser context)",
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "url": {
              "description": "set/delete: cookie URL (either url or domain is required)",
              "type": "string"
            },
            "name": {
              "description": "set/delete: cookie name",
              "type": "string"
            },
            "value": {
              "description": "set: cookie value",
              "type": "string"
            },
            "domain": {
              "description": "set/delete: cookie domain (either url or domain is required)",
              "type": "string"
            },
            "path": {
              "description": "set/delete: cookie path (default /)",
              "type": "string"
            },
            "httpOnly": {
              "description": "set: HttpOnly flag",
              "type": "boolean"
            },
            "secure": {
              "description": "set: Secure flag",
              "type": "boolean"
            },
            "sameSite": {
              "description": "set: SameSite restriction",
              "type": "string",
              "enum": [
                "Strict",
                "Lax",
                "None"
              ]
            },
            "expires": {
              "description": "set: expiration time in Unix seconds (default session cookie)",
              "type": "number"
            }
          },
          "required": [
            "op"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_kill",
        "description": "Terminate the controlled Chrome instance launched by this agent in the ACTIVE account session. Only kills the Chrome this agent launched. Named profile directories are kept so the login state can be relaunched/restored.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_targets",
        "description": "List all page targets available on the CDP port — [{id, title, url}]. Use after launch to see what pages exist, then attach to one.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_discover",
        "description": "Discover Chromium-based instances on this machine that have a debug port open — queries the process table, so the USER does not need to know or report any port. Returns {instances:[{browser, port, pages:[{id,title,url}]}]}. Use BEFORE browser_connect when the user says \"operate my browser\" without a port: list the instances to the user, let them pick, then connect(port). 兰台 webview (9222) is filtered out.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_attach",
        "description": "Attach to a specific page target (by id from browser_targets) so subsequent inspect/click/type/press/scroll/eval act on it. This is also how you switch between open tabs: pick another targetId from browser_targets and attach. This takes control of an external page — requires user approval. Note: targetId is the CDP target id; the \"target\" parameter (self vs external) is separate.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "targetId": {
              "type": "string",
              "description": "CDP target id from browser(targets) — not \"self\""
            }
          },
          "required": [
            "targetId"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_inspect",
        "description": "Read element geometry/style/text/contrast from the attached page using a CSS selector (or snapshot ref number). Returns JSON array: {tag, id, rect{x,y,width,height}, visible, scrollable, style{color,background,fontSize,...}, text, contrast}. props: optional subset of [\"geometry\",\"style\",\"text\",\"contrast\"]. maxResults caps elements (default 20). Use to verify visual details after UI changes.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "selector": {
              "type": "string",
              "description": "CSS selector (or ref number from snapshot) of element(s) to inspect"
            },
            "props": {
              "description": "Optional subset: geometry/style/text/contrast",
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "maxResults": {
              "description": "Max elements (default 20)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "required": [
            "selector"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_report",
        "description": "Visual lint report on the attached page (or scope selector) — checks contrast (WCAG 4.5:1), spacing scale (4/8/12/16/24/32), alignment, hierarchy (overused shadows), overflow. Returns {issues:[{rule,severity,detail,selector}], ok}. Use AFTER modifying UI code to self-review the rendered result.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "scope": {
              "description": "Optional CSS selector to limit the scan (default: whole page)",
              "type": "string"
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_snapshot",
        "description": "Snapshot interactive elements on the attached page — returns {source, refs:[{ref,tag,role,name,text,type?,id?}], count, total, offset, truncated}. Prefers Chrome Accessibility.getFullAXTree (source:\"ax\"); falls back to an enhanced DOM probe that traverses same-origin iframes and shadow DOM and computes accessible names (aria-label/labelledby/label/alt/title/placeholder). Marks elements with ref numbers; use these ref numbers in click/type/select/hover/scroll (e.g. selector: \"37\"). Refs are valid until the DOM changes — if an operation fails with \"target gone\", re-snapshot. If truncated is true there are more elements below — call again with offset to page (e.g. offset: 80 for page 2, 160 for page 3). PREFERRED over hand-written CSS selectors.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "scope": {
              "description": "Optional CSS selector to limit the snapshot (default: whole page)",
              "type": "string"
            },
            "maxResults": {
              "description": "Max elements per page (default 80)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "offset": {
              "description": "Skip this many interactive elements (for paging; default 0)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_content",
        "description": "Extract page text content from the attached page — always returns {title, url, format}. format \"text\" (default) returns cleaned innerText; \"markdown\" returns a lightweight markdown conversion (headings/lists/links/images/tables). scope limits extraction to a CSS selector. Pagination is character-based: maxChars (default 8000, max 20000) + offset reads the next chunk. Use instead of browser_eval for readable page body.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "scope": {
              "description": "Optional CSS selector to limit extraction (default: whole page)",
              "type": "string"
            },
            "format": {
              "description": "Output format: text (default) or markdown",
              "type": "string",
              "enum": [
                "text",
                "markdown"
              ]
            },
            "maxChars": {
              "description": "Max content characters per page (default 8000)",
              "type": "integer",
              "minimum": 1,
              "maximum": 20000
            },
            "offset": {
              "description": "Skip this many content characters (for paging; default 0)",
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_console",
        "description": "Read recent page console events (console.log/error, exceptions, Log.entryAdded) from the attached page. Use after UI changes or operations to check for new errors. Returns {entries:[{type,text}]}.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "limit": {
              "description": "Max entries (default 30)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_network",
        "description": "Read recent network events (requests/responses/failures) from the attached page. Requests and responses are paired by requestId: one entry has method/url/status/mimeType/error, with status null while pending and error set on load failure. Returns {entries:[{requestId,method,url,status,mimeType,resourceType,error}], paired:true}.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "limit": {
              "description": "Max entries (default 30)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_network_detail",
        "description": "Read full detail for one observed network request by requestId (from browser_network): complete URL, method, status/statusText/mimeType, request+response headers, postData (capped), error. Only requests still inside the 200-entry event buffer are available. HAR export is not implemented yet.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "requestId": {
              "type": "string",
              "description": "requestId from browser(network) entries"
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "required": [
            "requestId"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_network_har",
        "description": "Export recently observed network events from the attached page to a HAR 1.2 file in the temp directory. Returns {path, bytes, entries}. Includes URL, request/response headers, queryString, postData, status and mimeType; timing fields are -1 because the event observer does not sample timings. Use fs(read) or hand the path to the user when a full request archive is needed.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "limit": {
              "description": "Max entries to export (default 100; max 200)",
              "type": "integer",
              "minimum": 1,
              "maximum": 200
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_screenshot",
        "description": "Capture a screenshot of the attached page — saved to a temp file, returns {path, bytes}. With a text-only model the image content is not visible; hand the path to the user for confirmation.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "fullPage": {
              "description": "Capture beyond the viewport (full scrollable page, default false)",
              "type": "boolean"
            },
            "inline": {
              "description": "Return a base64 data URL directly when <= 3MB (default false)",
              "type": "boolean"
            },
            "target": {
              "description": "\"self\" = 兰台 webview（只读）；省略 = 已 attach 的外部页面",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_viewport",
        "description": "Set viewport metrics on the attached page via Emulation.setDeviceMetricsOverride: width/height in CSS px, deviceScaleFactor (0.5-3, default 1) and mobile emulation flag (default false). This is the CDP viewport override, separate from browser_launch windowSize (the physical window).",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "width": {
              "type": "integer",
              "minimum": 1,
              "maximum": 16384,
              "description": "Viewport width in CSS pixels"
            },
            "height": {
              "type": "integer",
              "minimum": 1,
              "maximum": 16384,
              "description": "Viewport height in CSS pixels"
            },
            "deviceScaleFactor": {
              "description": "Device pixel ratio (default 1)",
              "type": "number",
              "minimum": 0.5,
              "maximum": 3
            },
            "mobile": {
              "description": "Emulate a mobile viewport (default false)",
              "type": "boolean"
            }
          },
          "required": [
            "width",
            "height"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_audit",
        "description": "Read the browser operation audit log — which agent did what (click/type/launch/attach), when, and the outcome. Use to review what the Agent has done in the browser.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "limit": {
              "description": "Max entries (default 50)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_click",
        "description": "Click an element in the attached page by snapshot ref number (e.g. selector: \"37\") or CSS selector. Waits for the element to be actionable (visible/unobscured/stable) before clicking. Returns world-change feedback (URL/DOM changes, new errors). Sensitive targets (submit buttons, download links, confirm/pay/delete text) trigger a separate approval.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "selector": {
              "type": "string",
              "description": "Ref number from snapshot or CSS selector of element to click"
            }
          },
          "required": [
            "selector"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_type",
        "description": "Type text into an input in the attached page by snapshot ref number (e.g. selector: \"37\") or CSS selector. Focuses the element then inserts text (Chinese/IME friendly). Set replace:true to clear the existing value first (dispatches input/change events). Typing into a pre-filled input or password field triggers a separate approval.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "selector": {
              "type": "string",
              "description": "Ref number from snapshot or CSS selector of input/textarea/contenteditable to focus"
            },
            "text": {
              "type": "string",
              "description": "Text to type"
            },
            "replace": {
              "description": "Replace existing value before typing (clears then dispatches input/change events)",
              "type": "boolean"
            }
          },
          "required": [
            "selector",
            "text"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_press",
        "description": "Press a key in the attached page: Enter / Tab / Escape / Backspace / Arrow keys / single characters.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "key": {
              "type": "string",
              "description": "Key name (Enter/Tab/Escape/ArrowUp/ArrowDown/... or single char)"
            },
            "modifiers": {
              "description": "Modifier keys held during the press (e.g. [\"ctrl\"] + key \"a\" = Ctrl+A)",
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "ctrl",
                  "alt",
                  "shift",
                  "meta"
                ]
              }
            }
          },
          "required": [
            "key"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_hover",
        "description": "Hover the mouse over an element in the attached page by ref number or CSS selector. Waits for the element to be actionable, then moves the mouse to its center (for hover menus/tooltips/:hover styles).",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "selector": {
              "type": "string",
              "description": "Ref number from snapshot or CSS selector of element to hover"
            }
          },
          "required": [
            "selector"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_dialog",
        "description": "Inspect or handle a JavaScript dialog (alert/confirm/prompt) on the attached page. Call without accept to query recent dialogs and whether one is pending. Call with accept:true to accept, accept:false to dismiss; promptText answers a prompt.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "accept": {
              "description": "Omit to query pending dialogs; true = accept, false = dismiss",
              "type": "boolean"
            },
            "promptText": {
              "description": "Text to enter for a prompt dialog",
              "type": "string"
            },
            "limit": {
              "description": "Max dialog entries when querying (default 10)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_upload",
        "description": "Set files on an <input type=file> in the attached page. If a file chooser was recently opened, its intercepted backend node is used; otherwise pass a CSS selector (or ref) to the input. files are local absolute paths.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "files": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Absolute local file paths to set"
            },
            "selector": {
              "description": "CSS selector (or ref) of the file input, required if no recent file chooser event",
              "type": "string"
            }
          },
          "required": [
            "files"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_new_tab",
        "description": "Open a new tab in the current browser session and auto-attach to it. Pass url to open a page (default about:blank). Use browser_targets + browser_attach to switch tabs later.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "url": {
              "description": "URL to open in the new tab (default about:blank)",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_close_tab",
        "description": "Close a browser tab by targetId (from browser_targets). If it is the currently attached tab, the session becomes unattached — list targets and attach another.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "targetId": {
              "type": "string",
              "description": "CDP target id of the tab to close"
            }
          },
          "required": [
            "targetId"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_scroll",
        "description": "Scroll the attached page: pass selector (ref number or CSS selector) to scroll element into view, or direction (down/up/top) for page scroll.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "selector": {
              "description": "Ref number or CSS selector to scroll into view",
              "type": "string"
            },
            "direction": {
              "description": "Page scroll direction: down/up/top",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_navigate",
        "description": "Navigate the attached page to a URL (Page.navigate). Returns world-change feedback after the navigation settles. Use for normal page navigation after attach.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "description": "URL to navigate to"
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_back",
        "description": "Go back one entry in the attached page navigation history. Returns {navigated:\"back\", url, change}.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_forward",
        "description": "Go forward one entry in the attached page navigation history. Returns {navigated:\"forward\", url, change}.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_reload",
        "description": "Reload the attached page (Page.reload). Returns {reloaded:true, url, change}.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_select",
        "description": "Select an <option> in a <select> element on the attached page by ref number or CSS selector. value matches option value first, then visible option text. Dispatches input/change events. Returns {selected, value, change}.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "selector": {
              "type": "string",
              "description": "Ref number from snapshot or CSS selector of the <select> element"
            },
            "value": {
              "type": "string",
              "description": "Option value (preferred) or visible option text"
            }
          },
          "required": [
            "selector",
            "value"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_wait",
        "description": "Wait — either wait a fixed number of ms, or wait until a CSS selector appears and is visible (default 10s timeout). Use after clicking an async-triggering button when the result takes a moment to load. Pass ms for a fixed sleep; pass selector to poll for it to become visible. Returns {found, selector?, waited_ms}. Does not change state.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "selector": {
              "description": "CSS selector to wait for (appears + visible)",
              "type": "string"
            },
            "ms": {
              "description": "Fixed sleep in milliseconds (capped at 30000)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_eval",
        "description": "Execute a JS expression in the attached page (read-oriented; network/storage/new-window calls blocked by whitelist). Returns the value as JSON. Prefer browser_inspect for DOM reading.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "expr": {
              "type": "string",
              "description": "JS expression to evaluate"
            }
          },
          "required": [
            "expr"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "browser_status",
        "description": "Current browser session status — port, attached target, controlled Chrome running, observer alive, pending dialog/file chooser.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.constraints",
    "version": "1.0.0",
    "trust": "system",
    "description": "约束配置读写（自 commands/constraints.rs 拆出，kernel-plugin-runtime P2-1）",
    "capabilities": [
      "filesystem_read",
      "filesystem_write"
    ],
    "tools": [
      {
        "name": "read_constraints",
        "description": "Read the current constraint configuration (hologram.constraints.yaml) for the project. Returns the YAML content. Use to check routing rules, thresholds, and allowlist/denylist settings.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "projectPath": {
              "type": "string",
              "description": "Project root directory path"
            }
          },
          "required": [
            "projectPath"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "write_constraints",
        "description": "Write the constraint configuration (hologram.constraints.yaml) for the project — replaces the whole file. Use after check_boundaries (graph domain) reveals violations worth encoding as standing rules: routing rules, thresholds, allowlist/denylist. Read the current config with fs(constraints) first so you extend existing rules rather than drop them.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "projectPath": {
              "type": "string",
              "description": "Project root directory path"
            },
            "content": {
              "type": "string",
              "description": "Full YAML content to write"
            }
          },
          "required": [
            "projectPath",
            "content"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.editor",
    "version": "1.0.0",
    "trust": "system",
    "description": "代码编辑器（自 commands/editor.rs 拆出，kernel-plugin-runtime P2-1）",
    "capabilities": [
      "filesystem_read",
      "filesystem_write"
    ],
    "tools": [
      {
        "name": "edit_file",
        "description": "Perform exact string replacement in a file. The old_string must match exactly (including indentation and whitespace) and must be unique in the file (unless replace_all is true). This is the preferred way to modify code — safer and cheaper than rewriting the entire file.",
        "read_only": false,
        "permission": {
          "family": "Edit",
          "path_key": "filePath"
        },
        "schema": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "Absolute path to the file to modify"
            },
            "oldString": {
              "type": "string",
              "description": "The exact text to find and replace (must match the file exactly, including whitespace)"
            },
            "newString": {
              "type": "string",
              "description": "The text to replace it with (must be different from oldString)"
            },
            "replaceAll": {
              "default": false,
              "description": "Replace all occurrences instead of just the first (default: false). Use when the old_string appears multiple times.",
              "type": "boolean"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "filePath",
            "oldString",
            "newString"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.fs",
    "version": "1.0.0",
    "trust": "system",
    "description": "文件系统操作（自 commands/filesystem.rs + search.rs 的 glob 拆出，kernel-plugin-runtime P2-2）",
    "capabilities": [
      "filesystem_read",
      "filesystem_write"
    ],
    "tools": [
      {
        "name": "list_directory",
        "description": "List files and subdirectories in a directory (recursive up to 4 levels deep). Returns name, path, type (file/dir), and size for each entry.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the directory to list"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "list_directory_flat",
        "description": "List the immediate files and subdirectories of a directory (non-recursive). Internal consumer tool (not model-facing).",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the directory to list"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "read_file_content",
        "description": "Read the content of a file on disk. Returns text in cat -n format (6-digit line number + tab + content). Use offset and limit to read a specific range of lines (0-indexed). Use to inspect source code files when analyzing dependencies or investigating violations.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "filePath"
        },
        "schema": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "Absolute path to the file to read"
            },
            "offset": {
              "description": "Line number to start reading from (0-indexed, default: 0)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "limit": {
              "description": "Maximum number of lines to return (default: all lines)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "filePath"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "read_memory_batch",
        "description": "Read multiple memory files under .lantai in one call. Internal consumer tool (not model-facing).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "paths": {
              "description": "Absolute file paths to read",
              "items": {
                "type": "string"
              },
              "type": "array"
            }
          },
          "required": [
            "paths"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "read_file_base64",
        "description": "Read a file and return its content base64-encoded (for in-app media rendering). Internal consumer tool (not model-facing).",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "filePath"
        },
        "schema": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "Absolute path to the file to read"
            }
          },
          "required": [
            "filePath"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "write_file_content",
        "description": "Create or overwrite a file with the given content. Creates parent directories if needed. Use to write new files or modify existing ones.",
        "read_only": false,
        "permission": {
          "family": "Edit",
          "path_key": "filePath"
        },
        "schema": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "Absolute path to the file to create or overwrite"
            },
            "content": {
              "type": "string",
              "description": "Full file content to write"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "filePath",
            "content"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "log_append",
        "description": "Append content to a log file (create if missing). Internal consumer tool (not model-facing).",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the log file"
            },
            "content": {
              "type": "string",
              "description": "Content to append"
            }
          },
          "required": [
            "path",
            "content"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "create_directory",
        "description": "Create a new directory (and any missing parent directories). Use before writing new files into a directory that may not exist yet.",
        "read_only": false,
        "permission": {
          "family": "Edit",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the directory to create"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "get_global_memory_dir",
        "description": "Return the global memory directory path. Internal consumer tool (not model-facing).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "delete_file_or_dir",
        "description": "Delete a file or directory at the specified path. Use to clean up temporary files or remove unwanted code. DANGEROUS — cannot be undone. Verify with user if deleting important files.",
        "read_only": false,
        "permission": {
          "family": "Edit",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the file or directory to delete"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "rename_file_or_dir",
        "description": "Rename a file or directory (keep it in the same parent directory). For moving to a different directory, use move_file instead.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the file/directory to rename"
            },
            "new_name": {
              "type": "string",
              "description": "New name (not path, just the name)"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "path",
            "new_name"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "move_file",
        "description": "Move or rename a file or directory. The destination path determines the new name/location.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "from": {
              "type": "string",
              "description": "Source path"
            },
            "to": {
              "type": "string",
              "description": "Destination path"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "from",
            "to"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "glob",
        "description": "Fast file pattern matching using glob patterns. Returns matching file paths sorted by modification time. Supports ** for recursive matching (e.g. \"**/*.rs\", \"src/**/*.ts\", \"*.json\"). Use this instead of run_shell to find files by name pattern — it is faster and respects .gitignore-style exclusions.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "pattern": {
              "type": "string",
              "description": "Glob pattern to match file paths against (e.g. \"**/*.rs\", \"src/**/agent*.ts\", \"*.json\")"
            },
            "path": {
              "description": "Directory to search in. Defaults to the current workspace root.",
              "type": "string"
            }
          },
          "required": [
            "pattern"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.git",
    "version": "1.0.0",
    "trust": "system",
    "description": "Git 仓库操作（自 commands/git_cmds.rs 拆出，kernel-plugin-runtime P2-3）",
    "capabilities": [
      "git_read",
      "git_write"
    ],
    "tools": [
      {
        "name": "git_status",
        "description": "Get the current git status — branch name, ahead/behind count, and list of changed files with their status (modified, added, deleted, untracked).",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_diff_unstaged",
        "description": "Show the git diff for unstaged changes. Returns unified diff output. Use to review changes before staging/committing.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            },
            "file": {
              "default": ".",
              "description": "Optional: specific file to diff. If omitted, shows all unstaged changes.",
              "type": "string"
            },
            "staged": {
              "default": false,
              "description": "Set to true to show staged changes instead of unstaged",
              "type": "boolean"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_diff_staged",
        "description": "Show the git diff for unstaged changes. Returns unified diff output. Use to review changes before staging/committing.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            },
            "file": {
              "default": ".",
              "description": "Optional: specific file to diff. If omitted, shows all unstaged changes.",
              "type": "string"
            },
            "staged": {
              "default": false,
              "description": "Set to true to show staged changes instead of unstaged",
              "type": "boolean"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_log",
        "description": "Show recent git commit history. Returns structured JSON with commit hash, message, author, and date for each commit.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            },
            "count": {
              "default": 10,
              "description": "Number of recent commits to show (default: 10)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_stage",
        "description": "Stage files for commit. Use before git_commit to add changes to the staging area.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "stage"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            },
            "files": {
              "type": "string",
              "description": "File path(s) to stage, separated by commas. Use \".\" to stage all."
            }
          },
          "required": [
            "path",
            "files"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_stage_all",
        "description": "Stage all changes (including untracked files) for commit. Equivalent of `git add .`.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "stage"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_commit",
        "description": "Commit staged changes with a message. Files must be staged first with git_stage. Returns the commit hash.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "commit"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            },
            "message": {
              "type": "string",
              "description": "Commit message (conventional commits format recommended)"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "path",
            "message"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_push",
        "description": "Push committed changes to the remote repository.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "push"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_pull",
        "description": "Pull latest changes from the remote repository (fast-forward only, no merge conflicts).",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "pull"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_init",
        "description": "Initialize a new git repository in the given directory.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "init"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the directory"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_checkout",
        "description": "Switch to a different branch. Use git_create_branch first if the branch does not exist.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "checkout"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository"
            },
            "branch": {
              "type": "string",
              "description": "Branch name to switch to"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "path",
            "branch"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_create_branch",
        "description": "Create a new git branch from the current HEAD. Does NOT switch to it — use git_checkout after.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "create_branch"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository"
            },
            "branch": {
              "type": "string",
              "description": "New branch name"
            }
          },
          "required": [
            "path",
            "branch"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_stash_push",
        "description": "Stash current uncommitted changes. Use before switching branches with dirty working tree.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "stash_push"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository"
            },
            "message": {
              "description": "Optional stash message for identification",
              "type": "string"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_stash_pop",
        "description": "Restore the most recently stashed changes. Pops the stash — the changes are applied and the stash entry is removed.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "stash_pop"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_discard",
        "description": "Discard unstaged changes to a file (git checkout -- <file>). Loses all uncommitted modifications.",
        "read_only": false,
        "permission": {
          "family": "Git",
          "path_key": "path",
          "subcommand": "discard"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository"
            },
            "file": {
              "type": "string",
              "description": "File path to discard changes for (relative to repo root)"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "path",
            "file"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "git_blame",
        "description": "Show who last modified each line of a file (git blame). Output is porcelain-format and truncated for very large results.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the git repository root"
            },
            "file": {
              "type": "string",
              "description": "File to blame (relative to the repository root)"
            }
          },
          "required": [
            "path",
            "file"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.lsp",
    "version": "1.0.0",
    "trust": "system",
    "description": "LSP 语言服务器会话（自 rpc.rs LSP 分区拆出，kernel-plugin-runtime P2-6）",
    "capabilities": [
      "lsp"
    ],
    "tools": [
      {
        "name": "lsp_start",
        "description": "Start an LSP server for a language over a workspace root. Returns the numeric session id.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "language": {
              "type": "string",
              "description": "Language id (e.g. typescript, rust, python)"
            },
            "root_uri": {
              "type": "string",
              "description": "Workspace root file:// URI"
            }
          },
          "required": [
            "language",
            "root_uri"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "lsp_request",
        "description": "Send a JSON-RPC request/notification to an LSP session. Returns the JSON-RPC result.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "LSP session id"
            },
            "method": {
              "type": "string",
              "description": "JSON-RPC method"
            },
            "params": {
              "type": "object",
              "description": "JSON-RPC params (optional for notifications)"
            }
          },
          "required": [
            "session_id",
            "method"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "lsp_stop",
        "description": "Stop an LSP server session.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "LSP session id"
            }
          },
          "required": [
            "session_id"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.pty",
    "version": "1.0.0",
    "trust": "system",
    "description": "PTY 终端会话（自 rpc.rs PTY 分区拆出，kernel-plugin-runtime P2-6）",
    "capabilities": [
      "pty"
    ],
    "tools": [
      {
        "name": "pty_spawn",
        "description": "Spawn an interactive PTY shell session. Returns the numeric session id.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "cwd": {
              "type": "string",
              "description": "Working directory for the shell"
            },
            "shell": {
              "type": "string",
              "description": "Optional shell command (default: cmd.exe on Windows)"
            },
            "cols": {
              "type": "integer",
              "description": "Initial terminal width in columns"
            },
            "rows": {
              "type": "integer",
              "description": "Initial terminal height in rows"
            }
          },
          "required": [
            "cwd",
            "cols",
            "rows"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "pty_write",
        "description": "Write raw input data to a PTY session.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "PTY session id"
            },
            "data": {
              "type": "string",
              "description": "Input data to write"
            }
          },
          "required": [
            "session_id",
            "data"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "pty_resize",
        "description": "Resize a PTY session terminal window.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "PTY session id"
            },
            "cols": {
              "type": "integer",
              "description": "New width in columns"
            },
            "rows": {
              "type": "integer",
              "description": "New height in rows"
            }
          },
          "required": [
            "session_id",
            "cols",
            "rows"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "pty_kill",
        "description": "Terminate a PTY session and its child process tree.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "PTY session id"
            }
          },
          "required": [
            "session_id"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.shell",
    "version": "1.0.0",
    "trust": "system",
    "description": "Shell 执行与后台任务管理（自 commands/shell.rs 拆出，kernel-plugin-runtime P2-4）",
    "capabilities": [
      "shell_exec"
    ],
    "tools": [
      {
        "name": "exec_command",
        "description": "Execute a shell command in the bundled bash (Unix syntax) and return stdout + stderr. The working directory is STICKY per agent: a successful `cd` in one call carries over to later calls, and every result ends with a `[cwd: ...]` line showing where you landed. Pass the `cwd` parameter to set the directory explicitly for one call. Do NOT write `cd /d X:\\...` (cmd syntax — fails in bash); write `cd /x/path` or `cd 'X:/path'`. Default timeout 5 min (max 10 min). Long output is truncated head+tail, but the FULL log is spilled to a file whose path is always printed in the result. To find output the truncation cut (e.g. a buried error), do NOT re-run the command with pipes (`| head`, `| tail`, `| grep`) — that wastes build/test time. Grep the spill file directly with the bundled bash instead (`grep -n -iE \"error|failed\" <path>`), or read its tail via fs(read) with offset; explicit-path grep bypasses search/glob ignore rules. For long or iterative work (builds, test loops, watch modes) set runInBackground: true and poll with bash_output — it returns ONLY output produced since your last read, so repeated polls cost no extra tokens. Commands run from the current sticky cwd by default. IMPORTANT: Do NOT use run_shell for file search, code search, or git operations — use glob (file patterns), search_content (text search), list_directory (directory listing), and the dedicated git_* tools instead. run_shell is ONLY for building and testing commands (npm test, cargo build, pytest, etc.).",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "command": {
              "type": "string",
              "description": "The shell command to run (e.g. \"npm test\", \"cargo build\", \"pytest -x\")"
            },
            "cwd": {
              "description": "Optional working directory for the command. Defaults to the current workspace root.",
              "type": "string"
            },
            "timeoutMs": {
              "default": 300000,
              "description": "Timeout in milliseconds (default: 300000 = 5 min, max: 600000 = 10 min)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 600000
            },
            "runInBackground": {
              "default": false,
              "description": "Set to true to run in background (returns job ID immediately). Use bash_output(id) to check progress, bash_wait(id) to wait for completion, bash_kill(id) to stop.",
              "type": "boolean"
            },
            "interpreter": {
              "description": "Optional interpreter. Default/omit = bundled bash (Unix syntax). Set \"pwsh\" ONLY for Windows-native tasks bash cannot do (registry queries, ACL, MSI, COM, WMI) — PowerShell syntax required.",
              "type": "string",
              "enum": [
                "bash",
                "pwsh"
              ]
            }
          },
          "required": [
            "command"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "bash_output",
        "description": "Read NEW output from a background shell job — only bytes produced since your previous bash_output call are returned (incremental; old output is never re-sent, so repeated polling of watch modes/dev servers is cheap). The header reports whether the job is still running ([任务运行中...]) or finished ([任务已完成, exit code: N...]).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "jobId": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991,
              "description": "The job ID returned by run_shell with runInBackground: true"
            }
          },
          "required": [
            "jobId"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "bash_kill",
        "description": "Kill a running background shell job and return any accumulated output.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "jobId": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991,
              "description": "The job ID returned by run_shell with runInBackground: true"
            }
          },
          "required": [
            "jobId"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "bash_wait",
        "description": "Block until a background shell job completes (or timeout), then return full output + exit code. Use after run_shell with runInBackground: true to wait for a long-running task.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "jobId": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991,
              "description": "The job ID returned by run_shell with runInBackground: true"
            },
            "timeoutMs": {
              "description": "Maximum wait time in milliseconds (default: 60000 = 60s, max: 600000 = 10min)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "jobId"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "shell_env",
        "description": "Return the current shell environment (OS, shell, path, bundled notes) for prompt injection. Internal consumer tool (not model-facing).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "background_activity",
        "description": "Aggregate read-only snapshot of running shell background jobs and browser sessions (status-bar HUD). Internal consumer tool (not model-facing).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "drain_bg_notifications",
        "description": "Drain pending background-job notifications (done/stalled notes) for an agent and return them as JSON. Internal consumer tool (not model-facing).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "agentId": {
              "type": "string",
              "description": "Owner agent id whose notifications to drain"
            }
          },
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.uia",
    "version": "1.0.0",
    "trust": "system",
    "description": "Windows 桌面 UIA 控制（自 rpc.rs desktop 分区拆出，kernel-plugin-runtime P2-5）",
    "capabilities": [
      "desktop"
    ],
    "tools": [
      {
        "name": "desktop_probe",
        "description": "Snapshot current machine process tree + top-level windows + visible console windows, WITH per-window channel routing advice (route.channel: \"cdp\" for Chromium windows → browser tools; \"uia\" for standard-control windows → desktop_uia_*; \"vision\" for self-drawn apps → uia_window_shot + multimodal). Returns {processes:[{pid,ppid,name,is_chromium}], windows:[{pid,name,title,visible,hwnd,route}], visible_console_windows}. route:false param skips UIA probing for a faster bare snapshot. Use to find which window to operate and HOW to operate it. Read-only; no persistent monitoring. Privacy: only process names (not full command lines); no cross-session/RDP probing.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "route": {
              "description": "Attach per-window channel routing advice (default true); false = bare snapshot, faster",
              "type": "boolean"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_screenshot",
        "description": "Capture a full-screen screenshot of the current desktop (requires an interactive desktop session). Saved to a temp file; returns {path, bytes, note}. High-privacy: may contain arbitrary on-screen content, so this asks for approval EVERY time. With a text-only model the image is not visible; hand the path to the user for confirmation.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_tree",
        "description": "Read the Windows UI Automation control tree of a desktop window — interactive controls only by default (buttons, inputs, lists, menus...), paginated. Returns {window:{pid,title,hwnd}, refs, generation, total, offset, count, truncated, tree:\"[ref] Type \\\"Name\\\"\", controls:[{ref,name,type,automation_id,enabled,rect,depth}]}. Locate the window by ONE of: hwnd (exact, from desktop_probe), pid, title (fuzzy), or omit all for the foreground window. all:true includes non-interactive layout elements; depth:N limits tree levels; offset/max_results paginate (default 80/page). refs index the FULL tree and stay reusable across actions and pages; if the window changed and a ref went stale, the action auto-refreshes once — only re-read the tree when that fails. Reading never touches focus or cursor. Self-drawn controls (WeChat/QQ/DingTalk etc.) expose an empty tree — use desktop_uia_window_shot + a vision model instead.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "hwnd": {
              "description": "Window handle from desktop_probe (hwnd field)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id - resolves to its main window",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring (fuzzy, first match)",
              "type": "string"
            },
            "depth": {
              "description": "Limit tree to N levels (real hierarchy with indentation)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "all": {
              "description": "Include non-interactive layout elements (default false = interactive only)",
              "type": "boolean"
            },
            "offset": {
              "description": "Skip this many listed controls (for paging; default 0)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "max_results": {
              "description": "Max controls per page (default 80)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_find",
        "description": "Find controls inside a desktop window by criteria (name fuzzy / control_type / automation_id / enabled). Interactive controls only by default (all:true for everything). Returns matching controls with their refs for later actions. Use instead of a full tree when you already know what kind of control you need — cheaper than uia_tree.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "hwnd": {
              "description": "Window handle from desktop_probe",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            },
            "name": {
              "description": "Control name substring (case-insensitive)",
              "type": "string"
            },
            "control_type": {
              "description": "e.g. Button, Edit, ListItem, MenuItem, CheckBox",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "enabled": {
              "description": "Filter by enabled state",
              "type": "boolean"
            },
            "all": {
              "description": "Include non-interactive elements (default false)",
              "type": "boolean"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_read",
        "description": "Read full detail of ONE control: value (password-masked), toggle state, expand state, scroll percents, rect, and the list of patterns it supports. Use after an action to verify the result (feedback loop), or before acting to see which patterns are available. Locate by ref or selector, same as the action tools. Read-only.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref from desktop_uia_tree/find",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Button, Edit",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_wait",
        "description": "Wait until a control satisfies a condition: until \"exists\" (appears), \"enabled\", or \"value\" (equals the given value). Polls every 150ms up to timeout_ms (default 10000, max 30000). Returns {found, until, waited_ms} — found:false on timeout is NOT an error. Use after clicking async-triggering buttons (e.g. dialogs that take a moment).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "until": {
              "type": "string",
              "enum": [
                "exists",
                "enabled",
                "value"
              ],
              "description": "Condition to wait for"
            },
            "value": {
              "description": "Expected value (required when until=value)",
              "type": "string"
            },
            "timeout_ms": {
              "description": "Max wait in ms (default 10000, max 30000)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "ref": {
              "description": "Control ref from desktop_uia_tree/find",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "required": [
            "until"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_click",
        "description": "Click a control in a desktop window. Locate by EITHER ref (from desktop_uia_tree/find) OR selector: name/automation_id/control_type - any combination. Triggers via InvokePattern/TogglePattern/SelectionItemPattern when available (no focus stealing), else real coordinate click (physical input). Returns world-change feedback: {done, method, target, changed:{window_title/focused/value/toggle before→after}, hint}. Permissions: first write into a window asks once (window takeover); sensitive targets (submit/pay/delete/confirm text) and coordinate clicks ask separately every time. Check \"changed\" to verify the click did what you expected; use desktop_uia_read/wait to double-check.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref from desktop_uia_tree/find (use instead of name/automation_id/control_type)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive (e.g. \"Equals\", \"Seven\")",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id (e.g. \"equalButton\", \"num7Button\")",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Button, Edit, ListItem, MenuItem, CheckBox",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle (re-locate if tree changed)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_right_click",
        "description": "Right-click a control — opens the context menu at the control center. Pure physical input (no UIA pattern for right-click), always asks. Locate by ref or selector (see desktop_uia_click). After the menu opens, read it with desktop_uia_tree and click items by ref.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref from desktop_uia_tree/find",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Button, Edit, ListItem",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_type",
        "description": "Type text into a control. ValuePattern.SetValue when supported (instant, no focus), else focus + clipboard paste (physical input, asks separately). Returns world-change feedback incl. value before→after (password fields masked). Typing into a pre-filled input or a password field is classified sensitive and asks separately.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref (usually an Edit/ComboBox)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "text": {
              "type": "string",
              "description": "Text to type"
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Edit, ComboBox",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_scroll",
        "description": "Scroll a scrollable control (ScrollPattern when available, else mouse wheel — wheel is physical input and asks separately). Returns world-change feedback incl. scroll percents before→after. Scroll itself is non-destructive; with window takeover granted it flows without asking.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref (scrollable pane/list)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "direction": {
              "type": "string",
              "enum": [
                "up",
                "down",
                "left",
                "right"
              ],
              "description": "Scroll direction"
            },
            "amount": {
              "description": "Scroll amount (>=1 large step, <1 small step; wheel ticks); default 1",
              "type": "number"
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Pane, List, ScrollBar",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "required": [
            "direction"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_select",
        "description": "Explicitly select a list item / tree item / tab (SelectionItemPattern.Select). Cleaner than clicking list entries — use for ListItems, TreeItems, TabItems, radio-like items. Returns world-change feedback.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref (the ListItem/TreeItem/TabItem to select)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Item name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType: ListItem, TreeItem, TabItem...",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_expand",
        "description": "Expand/collapse a ComboBox dropdown or tree node (ExpandCollapsePattern, idempotent toggle: expanded→collapse, collapsed→expand). After expanding a combo, read the item list with desktop_uia_tree/find and select with desktop_uia_select. Returns world-change feedback incl. expand state before→after.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref (the ComboBox/TreeItem to toggle)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType: ComboBox, TreeItem...",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_keys",
        "description": "Send a hotkey to a window (SendInput, real keyboard injection): key + modifiers (ctrl/alt/shift/meta). Examples: Ctrl+A, Delete, Enter, F5. Physical input — asks every time and is serialized globally (input lease) so concurrent agents cannot interleave keystrokes. Prefer pattern actions (click/type/select) whenever possible; use keys only for shortcuts UIA cannot reach.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "key": {
              "type": "string",
              "description": "Key name (Enter/Tab/Escape/Backspace/Delete/ArrowUp/F1-F12/single char)"
            },
            "modifiers": {
              "description": "Modifier keys held (e.g. [\"ctrl\"] + key \"a\" = Ctrl+A)",
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "ctrl",
                  "alt",
                  "shift",
                  "meta"
                ]
              }
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "required": [
            "key"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_activate",
        "description": "Bring a window to the foreground (restore if minimized + SetForegroundWindow). Physical input — asks every time. Needed before coordinate clicks / clipboard paste into apps that require focus; pattern actions (Invoke/SetValue/Select) work without activation.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "hwnd": {
              "description": "Window handle from desktop_probe",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_window_shot",
        "description": "Capture a screenshot of a single window rect (not the full screen) - smaller privacy surface than desktop_screenshot, read-only. Locate window as in desktop_uia_tree (hwnd/pid/title/foreground). Returns {path, bytes, rect, window}. With a text-only model hand the path to the user; with a vision model read the image to see self-drawn controls that UIA cannot see.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "hwnd": {
              "description": "Window handle from desktop_probe",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_audit",
        "description": "Read the desktop operation audit log — which agent did what (click/type/keys/activate), when, against which control/window, and the outcome. Mirrors browser_audit. Use to review what the Agent has done on the desktop.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "limit": {
              "description": "Max entries (default 50)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_status",
        "description": "Current desktop control state: active window-takeover grants per agent (with TTL) and the global input lease holder. Use to check who is currently allowed to operate which windows, or who holds the physical input lease.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.web",
    "version": "1.0.0",
    "trust": "system",
    "description": "Web 搜索与抓取（自 commands/web.rs 拆出，kernel-plugin-runtime Phase 1 续批）",
    "capabilities": [
      "network"
    ],
    "tools": [
      {
        "name": "web_search",
        "description": "Search the internet for real-time information. Uses a free anonymous search API first; if it fails, automatically falls back to Bing/DuckDuckGo scraping. No API key required.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Search keywords"
            },
            "maxResults": {
              "default": 10,
              "description": "Number of results to return (default 10, max 10)",
              "type": "integer",
              "minimum": 1,
              "maximum": 10
            }
          },
          "required": [
            "query"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "web_fetch",
        "description": "Fetch a URL and return its text content. HTML pages are reduced to readable text (scripts, styles, tags stripped). JSON / plain text / markdown pass through verbatim. Use to read documentation, API responses, or source files hosted on the web. 15s timeout, 1 MiB max.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "description": "The URL to fetch (HTTPS or HTTP only)"
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
];
