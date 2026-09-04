// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// tool_call 信封解包（kernel-plugin-runtime P2-2 内部直呼换源后测试 mock 的
// 统一适配器）：消费方从旧 RPC 名（write_file_content …）换到 tool_call 信封后，
// bridge 层 mock 看到的是 ('tool_call', { plugin, tool, args })——本助手把
// (method, params) 解回 { tool, args } 形状，测试断言保持「按工具名分派」的
// 原有写法，只换比较器。
//
// 用法（mock 分派处）：
//   const hit = unpackToolCall(method, params, 'builtin.editor', 'edit_file');
//   if (hit) { /* hit.args.filePath / hit.args.oldString … */ }

/** 匹配 tool_call 信封 (method, params) → 命中时返回其 args，未命中返回 null。 */
export function unpackToolCall(
  method: string,
  params: Record<string, unknown> | undefined,
  plugin: string,
  tool: string,
): Record<string, unknown> | null {
  if (method !== 'tool_call') return null;
  const p = params as { plugin?: unknown; tool?: unknown; args?: unknown } | undefined;
  if (p?.plugin !== plugin || p?.tool !== tool) return null;
  return (p.args as Record<string, unknown> | undefined) ?? {};
}

/** bridge 层 mock 调用记录里按信封过滤（c[0]=method, c[1]=params）：
 *  返回全部命中的 args。 */
export function toolCallArgsOf(
  calls: Array<[string, Record<string, unknown> | undefined]>,
  plugin: string,
  tool: string,
): Array<Record<string, unknown>> {
  return calls
    .map(([m, p]) => unpackToolCall(m, p, plugin, tool))
    .filter((x): x is Record<string, unknown> => x !== null);
}

/** invoke 层 mock 调用记录（c=('rpc', {method, params})）按信封过滤：
 *  返回全部命中的信封 args。typedRpc/agentInvoke 直接 mock 的站点用
 *  toolCallArgsOf，mockInvoke（invoke('rpc', payload)）站点用本变体。 */
export function toolCallArgsOfBridge(
  calls: Array<[string, { method?: string; params?: Record<string, unknown> }]>,
  plugin: string,
  tool: string,
): Array<Record<string, unknown>> {
  return toolCallArgsOf(
    calls.map(([_, payload]) => [payload?.method ?? '', payload?.params]),
    plugin,
    tool,
  );
}

// ── legacyDispatchShim：handler 面的集中式 mock 翻译层（基建 A）──
//
// 信封适配的量在 mock 分派面（每用例一条 `if (method === '…')` 链），不在断言面。
// 逐链手改 = P2-2 ~50 处 + P2-3/P2-4 各 13 文件的重复税——本 shim 把
// tool_call 信封在 mock 入口处翻译回旧 (method, params) 形状，交给原 impl，
// handler 的 if 链零改动即可继续工作。
//
// 用法：
//   mockInvoke.mockImplementation(legacyDispatchShim((cmd, payload) => { …原 if 链零改动… }))
//
// 纪律（勿走样）：
//  - snakeKey 浅层——只动 args 顶层键，值不动（content 里的 camelCase 不被污染）；
//    与旧 bridge rpc() 的转换行为逐字一致，对已是 snake 的键是幂等 no-op
//  - 表未命中 → 原样透传（自带 tool_call 分支的测试不受影响）
//  - 断言面不用 shim 救：mockInvoke 记录的仍是真实信封调用，断言一律改
//    toolCallArgsOf / toHaveBeenCalledWith('tool_call', …) —— 禁止给 shim 加
//    「调用记录旧名视图」（那是测 shim 不是测产品）
//  - dispatch 层 mock（codingExec 注入式，记录 {name, args} 形状）不适用本 shim，
//    照 parallel-subagent-bugs.test.ts 的 raw 信封断言处理

/** 旧名翻译表：'plugin.tool' → 旧 RPC 方法名（恒等映射为主）。
 *  P2-3 builtin.git 起在此表追加行——一处扩表，13 个 git 测试文件 mock 面零改动。 */
const LEGACY_METHOD_OF: Record<string, string> = {
  // builtin.editor（P2-1）
  'builtin.editor.edit_file': 'edit_file',
  // builtin.constraints（P2-1）
  'builtin.constraints.read_constraints': 'read_constraints',
  'builtin.constraints.write_constraints': 'write_constraints',
  // builtin.git（P2-3，manifest 16 工具 = 旧 RPC 方法名）
  'builtin.git.git_status': 'git_status',
  'builtin.git.git_diff_unstaged': 'git_diff_unstaged',
  'builtin.git.git_diff_staged': 'git_diff_staged',
  'builtin.git.git_log': 'git_log',
  'builtin.git.git_stage': 'git_stage',
  'builtin.git.git_stage_all': 'git_stage_all',
  'builtin.git.git_commit': 'git_commit',
  'builtin.git.git_push': 'git_push',
  'builtin.git.git_pull': 'git_pull',
  'builtin.git.git_init': 'git_init',
  'builtin.git.git_checkout': 'git_checkout',
  'builtin.git.git_create_branch': 'git_create_branch',
  'builtin.git.git_stash_push': 'git_stash_push',
  'builtin.git.git_stash_pop': 'git_stash_pop',
  'builtin.git.git_discard': 'git_discard',
  'builtin.git.git_blame': 'git_blame',
  // builtin.shell（P2-4，manifest 7 工具 = 旧 RPC 方法名）
  'builtin.shell.exec_command': 'exec_command',
  'builtin.shell.bash_output': 'bash_output',
  'builtin.shell.bash_kill': 'bash_kill',
  'builtin.shell.bash_wait': 'bash_wait',
  'builtin.shell.shell_env': 'shell_env',
  'builtin.shell.background_activity': 'background_activity',
  'builtin.shell.drain_bg_notifications': 'drain_bg_notifications',
};

/** camelCase → snake_case（浅层，只动顶层键；与 bridge rpc() 同款 ponytail 正则）。 */
const snakeKey = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

/** 信封 (plugin, tool, args) → 旧 (method, params)。表未命中返回 null。 */
function translateEnvelope(
  method: string,
  params: { plugin?: string; tool?: string; args?: Record<string, unknown> } | undefined,
): { method: string; params: Record<string, unknown> } | null {
  const legacy = LEGACY_METHOD_OF[`${params?.plugin}.${params?.tool}`];
  if (method !== 'tool_call' || legacy === undefined) return null;
  const translated: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params?.args ?? {})) translated[snakeKey(k)] = v;
  return { method: legacy, params: translated };
}

/** rpc 层 mock 包装：把 tool_call 信封翻译回旧 (method, params) 形状再交给原 impl
 *  （vi.mock bridge 的 rpc 直替站点——impl 形如 (method, params) => …）。 */
export function legacyRpcShim(
  impl: (method: string, params?: Record<string, unknown>) => unknown,
): (method: string, params?: Record<string, unknown>) => unknown {
  return (method: string, params?: Record<string, unknown>) => {
    const t = translateEnvelope(method, params);
    return t ? impl(t.method, t.params) : impl(method, params);
  };
}

/** invoke 层 mock 包装：把 tool_call 信封翻译回旧 (method, params) 形状再交给原 impl。
 *  handler 的 if (method === 'read_file_content') 链零改动即可继续工作。 */
export function legacyDispatchShim(
  impl: (cmd: string, payload: { method: string; params?: unknown }) => unknown,
): (cmd: string, payload: { method: string; params?: unknown }) => unknown {
  return (cmd: string, payload: { method: string; params?: unknown }) => {
    const t = translateEnvelope(payload?.method, payload?.params as Parameters<typeof translateEnvelope>[1]);
    return t ? impl(cmd, { method: t.method, params: t.params }) : impl(cmd, payload);
  };
}
