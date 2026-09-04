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

// P2-5（kernel-plugin-runtime）：本族工具已迁内核插件 builtin.browser / builtin.uia
// （src-tauri/src/tool_plugins/）。工具面真源 = Rust 侧 manifest.json：
// schema/description/readOnly = manifest 字节（gen:kernel-manifest 发射，convergence
// 零漂移）；execute 经 tool_call 统一信封寻址插件，args 键 = manifest schema 键
// （浏览器 camelCase / 桌面 snake_case）原样透传。权限（Ask / 敏感目标二次 Ask /
// 输入租约）在 Rust 插件内业务自检（设计件 §8 裁决）——TS 面不再持有权限逻辑。
// 复合工具 browser_fill / browser_navigate_snapshot / desktop_uia_fill 无独立 RPC
// 分支，保留在工具层：schema 仍由下方 zod 定义（模型面字节经 defineTool 发射，
// 与 manifest 逐字节一致），execute 逐字段调用信封化细粒度工具。

import { z } from 'zod';
import { errText } from '../loop-helpers';
import type { Tool } from '../tool';
import { agentInvoke } from '../tool';
import { defineTool } from './define-tool';
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

/** 信封化执行（P2-5）：agentInvoke('tool_call', { plugin, tool, args })——
 *  args 键 = manifest schema 键（浏览器 camelCase / 桌面 snake_case，原样透传）；
 *  isAgent 由 agentInvoke 恒注入。 */
async function envelopeCall(plugin: string, tool: string, args: Record<string, unknown>): Promise<string> {
  return agentInvoke<string>('tool_call', { plugin, tool, args });
}

/** manifest 驱动的浏览器域工具（builtin.browser）：schema/description/readOnly = manifest 字节。 */
function browserManifestTool(toolName: string, run: (args: Record<string, unknown>) => Promise<string>): Tool {
  const manifest = kernelManifestOf('builtin.browser');
  const spec = manifest.tools.find((t) => t.name === toolName);
  if (!spec) throw new Error(`manifest-tools: 插件 'builtin.browser' 无工具 '${toolName}'`);
  const parameters = spec.schema;
  return {
    name: () => toolName,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => spec.read_only ?? false,
    execute: (args, _onProgress, _signal) => run(args as Record<string, unknown>),
  };
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

/** browser 动作 → manifest 工具名（恒等映射——manifest 名 = 旧 RPC 方法名）。 */
const BROWSER_ACTION_TOOL: Record<string, string> = {
  launch: 'browser_launch',
  connect: 'browser_connect',
  discover: 'browser_discover',
  targets: 'browser_targets',
  kill: 'browser_kill',
  sessions: 'browser_sessions',
  switch_session: 'browser_switch_session',
  cookies: 'browser_cookies',
  attach: 'browser_attach',
  new_tab: 'browser_new_tab',
  close_tab: 'browser_close_tab',
  navigate: 'browser_navigate',
  back: 'browser_back',
  forward: 'browser_forward',
  reload: 'browser_reload',
  snapshot: 'browser_snapshot',
  content: 'browser_content',
  inspect: 'browser_inspect',
  report: 'browser_report',
  console: 'browser_console',
  network: 'browser_network',
  network_detail: 'browser_network_detail',
  network_har: 'browser_network_har',
  click: 'browser_click',
  hover: 'browser_hover',
  type: 'browser_type',
  select: 'browser_select',
  upload: 'browser_upload',
  dialog: 'browser_dialog',
  press: 'browser_press',
  scroll: 'browser_scroll',
  viewport: 'browser_viewport',
  wait: 'browser_wait',
  eval: 'browser_eval',
  screenshot: 'browser_screenshot',
  audit: 'browser_audit',
  status: 'browser_status',
};

/** 执行 browser 动作（信封化）。self → webview 只读通道；外部 → 各 Agent CDP 会话。 */
async function runBrowserAction(action: string, args: Record<string, unknown>): Promise<string> {
  const toolName = BROWSER_ACTION_TOOL[action];
  if (!toolName) return `[browser] unsupported action "${action}"`;
  const pageHint =
    action === 'snapshot'
      ? '用 snapshot 的 offset/maxResults 翻页，或 scope 收窄范围'
      : action === 'content'
        ? '用 content 的 offset/maxChars 翻页'
        : undefined;
  try {
    const result = await envelopeCall('builtin.browser', toolName, args);
    return truncate(result ?? '', pageHint);
  } catch (e) {
    const raw = errText(e);
    const parsed = parseBrowserError(raw);
    // 结构化错误：模型读人话 message，code 保留在方括号内供测试/路由。
    return parsed ? `[browser] ${action} 失败 [${parsed.code}]: ${parsed.message}` : `[browser] ${action} 失败: ${raw}`;
  }
}

export function createBrowserTools(): Tool[] {
  const run = (action: string, args: Record<string, unknown>) => runBrowserAction(action, args);
  return [
    browserManifestTool('browser_launch', (args) => run('launch', args)),
    browserManifestTool('browser_connect', (args) => run('connect', args)),
    browserManifestTool('browser_discover', (args) => run('discover', args)),
    browserManifestTool('browser_targets', (args) => run('targets', args)),
    browserManifestTool('browser_kill', (args) => run('kill', args)),
    browserManifestTool('browser_sessions', (args) => run('sessions', args)),
    browserManifestTool('browser_switch_session', (args) => run('switch_session', args)),
    browserManifestTool('browser_cookies', (args) => run('cookies', args)),
    browserManifestTool('browser_attach', (args) => run('attach', args)),
    browserManifestTool('browser_new_tab', (args) => run('new_tab', args)),
    browserManifestTool('browser_close_tab', (args) => run('close_tab', args)),
    browserManifestTool('browser_navigate', (args) => run('navigate', args)),
    browserManifestTool('browser_back', (args) => run('back', args)),
    browserManifestTool('browser_forward', (args) => run('forward', args)),
    browserManifestTool('browser_reload', (args) => run('reload', args)),
    browserManifestTool('browser_snapshot', (args) => run('snapshot', args)),
    browserManifestTool('browser_content', (args) => run('content', args)),
    browserManifestTool('browser_inspect', (args) => run('inspect', args)),
    browserManifestTool('browser_report', (args) => run('report', args)),
    browserManifestTool('browser_console', (args) => run('console', args)),
    browserManifestTool('browser_network', (args) => run('network', args)),
    browserManifestTool('browser_network_detail', (args) => run('network_detail', args)),
    browserManifestTool('browser_network_har', (args) => run('network_har', args)),
    browserManifestTool('browser_click', (args) => run('click', args)),
    browserManifestTool('browser_hover', (args) => run('hover', args)),
    browserManifestTool('browser_type', (args) => run('type', args)),
    browserManifestTool('browser_select', (args) => run('select', args)),
    browserManifestTool('browser_upload', (args) => run('upload', args)),
    browserManifestTool('browser_dialog', (args) => run('dialog', args)),
    browserManifestTool('browser_press', (args) => run('press', args)),
    browserManifestTool('browser_scroll', (args) => run('scroll', args)),
    browserManifestTool('browser_viewport', (args) => run('viewport', args)),
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
          const r = await runBrowserAction('type', { selector: f.selector, text: f.text, replace: f.replace });
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
        const nav = await runBrowserAction('navigate', { url: a.url });
        const snap = await runBrowserAction('snapshot', { maxResults: a.maxResults });
        return `== navigation ==\n${nav}\n\n== snapshot ==\n${snap}`;
      },
    }),

    browserManifestTool('browser_wait', (args) => run('wait', args)),
    browserManifestTool('browser_eval', (args) => run('eval', args)),
    browserManifestTool('browser_screenshot', (args) => run('screenshot', args)),
    browserManifestTool('browser_audit', (args) => run('audit', args)),
    browserManifestTool('browser_status', (args) => run('status', args)),
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
