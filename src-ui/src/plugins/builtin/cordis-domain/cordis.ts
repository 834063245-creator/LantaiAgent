// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// cordis 动态插件工具族（平台化 Phase 4 · D7，2026-08-27）——模型可见的
// 运行时插件 define/run/stop/undefine/inspect 面（形状对齐 DSH tool-cordis）。
//
// 折叠形态：六枚细粒度工具经 DOMAIN_SPECS 折叠为 `cordis` 域工具（本仓
// 域折叠形态保留——agent-plugin 计划 Non-goal；细粒度名隐藏但可解析）。
//
// 审批通道（D12）：cordis_run 经装配期注入的 ui.askUser（ask_user 同款
// UI 面）请求用户批准——拒绝后不得重复请求；无 UI 通道且未授权 = 拒绝
// （APPROVAL_REQUIRED）。所有权：args._agent_id（executor 注入的会话 id）
// = 插件归属会话，跨会话不可见/不可操作。

import { z } from 'zod';
import type { CodingToolsUI, DynamicApproval, Tool } from './host';
import { activeDynamicRunner, defineTool } from './host';

/** 会话归属（executor 注入的 _agent_id；缺失路径回退 root——与所有权
 *  隔离语义一致：缺 id 的调用方只能看到 root 命名空间）。 */
function ownerOf(args: Record<string, unknown>): string {
  return typeof args._agent_id === 'string' && args._agent_id !== '' ? args._agent_id : 'root';
}

/** ask 通道 → 动态插件审批回调（runner 不知道 UI——依赖倒置）。 */
function approvalFromUi(ui: CodingToolsUI | undefined, agentId?: string): DynamicApproval | undefined {
  if (!ui?.askUser) return undefined;
  return (req) =>
    new Promise<boolean>((resolve) => {
      ui.askUser?.({
        id: `cordis-run:${req.pluginId}/${req.packageId}`,
        agentId,
        header: '动态插件审批',
        question:
          `是否允许运行动态插件 ${req.pluginId}/${req.packageId}？\n\n` +
          `名称：${req.name}\n目的：${req.purpose}\n\n` +
          '插件代码将在沙箱内执行并可向组合层注册贡献（工具/面板/后端 provider 等）。',
        options: [
          { label: '允许', description: '本次会话内激活该包（可 stop / undefine 回收）' },
          { label: '拒绝', description: '不运行该包' },
        ],
        callback: (answer) => {
          const first = Array.isArray(answer) ? answer[0] : answer;
          resolve(first === '允许');
        },
      });
    });
}

/** runner 消费单点（无装配 = 响亮报错——错误不静默）。 */
function requireRunner(): NonNullable<ReturnType<typeof activeDynamicRunner>> {
  const runner = activeDynamicRunner();
  if (!runner) {
    throw new Error('[cordis] dynamicRunner 服务未装配——请确认 loadBuiltinPlugins 装配（生产表序 codeRuntime 之后）');
  }
  return runner;
}

/** cordis 工具族（六枚细粒度——折叠为 cordis 域）。
 *  deps.ui = 装配期真值（rowCtx.ui——cordis_run 的审批通道）。 */
export function createCordisTools(deps: { ui?: CodingToolsUI } = {}): Tool[] {
  return [
    defineTool({
      name: 'cordis_define',
      description:
        'Define an immutable dynamic-plugin package (not executed yet). kind:"new" starts a plugin with a 3-6 letter ' +
        'semantic idPrefix; kind:"existing" appends a package to an owned plugin without overwriting older versions. ' +
        'code is a plain JavaScript function body that returns { name?, apply(ctx) }; no TypeScript, JSX, or imports. ' +
        'Inside apply, use the guarded ctx: ctx.effect(fn,label) and ctx.<service>.register(def) for tools / panels / ' +
        'commands / llm / fs / shell / sessionPersistence / graph / subagents / prompts / renderers / capabilities. ' +
        'Dangerous globals (fetch/window/document/eval/...) are undefined in the sandbox. Define only validates syntax ' +
        'and budget — call cordis_run to activate (requires user approval).',
      schema: z.object({
        kind: z.enum(['new', 'existing']).describe('new = 创建插件并追加首个包；existing = 向已拥有的插件追加包'),
        idPrefix: z
          .string()
          .regex(/^[a-z]{3,6}$/)
          .optional()
          .describe('kind=new：3-6 个小写英文字母的语义前缀（宿主补唯一后缀）'),
        pluginId: z.string().optional().describe('kind=existing：已拥有插件的 id'),
        name: z.string().min(1).max(120).describe('包的短名（可读）'),
        purpose: z.string().min(1).max(500).describe('一句话的用户可读目的'),
        code: z.string().min(1).describe('插件工厂源码（纯 JS 函数体，return { name?, apply(ctx) }）'),
      }),
      readOnly: false,
      execute: (args) => {
        const receipt = requireRunner().define(ownerOf(args), {
          kind: args.kind,
          idPrefix: args.idPrefix,
          pluginId: args.pluginId,
          name: args.name,
          purpose: args.purpose,
          code: args.code,
        });
        return Promise.resolve(
          JSON.stringify({
            ...receipt,
            hint: `已定义（未运行）。调用 cordis_run 激活 ${receipt.pluginId}/${receipt.packageId}（需用户批准）。`,
          }),
        );
      },
    }),
    defineTool({
      name: 'cordis_run',
      description:
        'Activate one exact package of an owned dynamic plugin. mode:"run" = first activation / restart / rollback; ' +
        'mode:"update" = switch from the current package to another. First activation asks the user for approval via ' +
        'the UI channel — denial is final for that request (do not re-ask). currentPackageId advances only after full ' +
        'success; on failure the previous package is re-mounted (rollback). Read diagnostics with cordis_inspect_self.',
      schema: z.object({
        pluginId: z.string().min(1).describe('cordis_define 返回的插件 id'),
        packageId: z.string().min(1).describe('要激活的精确包 id'),
        mode: z.enum(['run', 'update']).describe('run = 首次激活/重启/回滚；update = 从当前包切到另一包'),
      }),
      readOnly: false,
      execute: (args) => {
        const runner = requireRunner();
        const owner = ownerOf(args);
        const meta = args as Record<string, unknown>;
        const agentId = typeof meta._owner_id === 'string' ? meta._owner_id : owner;
        return runner
          .run(owner, args.pluginId, args.packageId, args.mode, approvalFromUi(deps.ui, agentId))
          .then((receipt) =>
            JSON.stringify({ ...receipt, hint: '包已激活——贡献下次装配/即时生效；cordis_stop 可回收。' }),
          );
      },
    }),
    defineTool({
      name: 'cordis_stop',
      description:
        'Stop a running dynamic plugin: dispose its fiber and chain-recycle every contribution it registered ' +
        '(tools / panels / providers / MCP processes). The plugin and its packages remain defined (cordis_run can ' +
        'restart; approval is remembered per session+package).',
      schema: z.object({
        pluginId: z.string().min(1).describe('要停用的插件 id'),
      }),
      readOnly: false,
      execute: (args) => {
        return requireRunner()
          .stop(ownerOf(args), args.pluginId)
          .then((r) => JSON.stringify({ ...r, pluginId: args.pluginId }));
      },
    }),
    defineTool({
      name: 'cordis_undefine',
      description:
        'Remove an owned dynamic plugin entirely: stop it if running, delete every package (sources and diagnostics) ' +
        'and its approval records. Irreversible — define again to recreate.',
      schema: z.object({
        pluginId: z.string().min(1).describe('要删除的插件 id'),
      }),
      readOnly: false,
      execute: (args) => {
        return requireRunner()
          .undefine(ownerOf(args), args.pluginId)
          .then((r) => JSON.stringify({ ...r, pluginId: args.pluginId }));
      },
    }),
    defineTool({
      name: 'cordis_inspect_list',
      description:
        'List dynamic plugins owned by this session (id, latest package name/purpose, package count, current ' +
        'package, running state). Read-only; call before define/run to discover ids.',
      schema: z.object({}),
      readOnly: true,
      execute: (args) => {
        return Promise.resolve(JSON.stringify(requireRunner().listInspect(ownerOf(args))));
      },
    }),
    defineTool({
      name: 'cordis_inspect_self',
      description:
        'Inspect owned dynamic plugins at increasing detail. No ids = plugin summaries. pluginId = package summaries ' +
        'with current/running state. pluginId + packageId = that immutable package source + run diagnostics (use ' +
        'before repairing a failed package or defining an updated version).',
      schema: z.object({
        pluginId: z.string().optional().describe('插件 id（省略 = 列出全部）'),
        packageId: z.string().optional().describe('精确包 id（返回源码与诊断；必须与 pluginId 同给）'),
      }),
      readOnly: true,
      execute: (args) => {
        return Promise.resolve(
          JSON.stringify(requireRunner().inspectSelf(ownerOf(args), args.pluginId, args.packageId)),
        );
      },
    }),
  ];
}

export const CORDIS_TOOL_NAMES = [
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
  'cordis_inspect_list',
  'cordis_inspect_self',
] as const;
