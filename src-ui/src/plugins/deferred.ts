// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件后台唤醒回调（app shell 四件套 · 件 D，S4）——「提交即返回卡片，
// 完成后台唤醒主 Agent + minimal 定位键，内容凭定位键按需取」的宿主侧
// 包装，复用既有唤醒链路不造新轮子：
//
//   唤醒底座 = MessageBus systemNotify(type:'bg')（Rust 后台任务 bg:note 的
//   同一通道）：投递进发起 Agent 的 inbox + 触发 idle 唤醒回调；Agent 循环
//   边界 _injectInbox 消费注入为 system-reminder（「后台任务已完成」语义的
//   插件版对位）。多工作区/多会话路由经 wake handler 注入面——runtime 层
//   （workspace.ts setupAgent）注册「按 ownerId 找 bus + 解析 sessionId」的
//   路由器；本模块保持 runtime 无关（plugins 层不持 bus）。
//
// 两张门统一（决策 8）：
//   - 工具口（manifest.tools async:true）：mountToolDeclarations 包装 execute
//     ——宿主生成 taskId 注入 args._task_id + 登记发起者（executor 注入的
//     args._owner_id，bus id）；插件后台代码完成后经宿主桥
//     `host.deferred.complete(taskId, status)` 唤醒；
//   - MCP 路（mcpServers）：调用期带 deferred progressToken（登记
//     token→发起者），server 完成后发自定义通知 `lantai/deferred`
//     （params: {progressToken, taskId, status, message?}）——McpClient
//     onNotification → mcp-bridge 翻译成同一唤醒。progressToken 是 MCP
//     协议面「请求↔通知关联」的标准锚点，server 原样回带即可。
//
// minimal 定位键纪律（计划 §5-S4 测试 d）：唤醒体只带
// {status, taskId, sessionId} 三键 JSON + 一行归因前缀（插件·工具名）；
// message 可选且截 160 字。内容不进唤醒——凭 taskId 调插件工具按需取。
//
// 越界护栏：两张注册表有界（超限丢最旧）——server 永不发完成通知、插件
// 忘了 complete 都是常驻泄漏面，500 上限封顶。

export type PluginDeferredStatus = 'completed' | 'failed';

/** 唤醒键：定位信息（不含内容）。 */
export interface PluginDeferredKey {
  /** 插件自订任务 id（回执卡片里给模型的同款键——凭它取内容）。 */
  taskId: string;
  status: PluginDeferredStatus;
  /** 归因：插件名（+ 可选工具名——前缀行用）。 */
  plugin: string;
  tool?: string;
  /** 可选短讯（截 160 字——长内容走定位键自取）。 */
  message?: string;
}

/** 发起者元数据（登记项）。 */
interface DeferredOwner {
  /** 发起 Agent 的 bus id（executor 注入 args._owner_id）；缺席 = 无 Agent
   *  语境（UI/测试直调）——完成时无唤醒面，best-effort warn。 */
  ownerId?: string;
  plugin: string;
  tool?: string;
}

/** 唤醒路由器（runtime 层注册——workspace.ts setupAgent）。
 *  返回 true = 已受理（该 runtime 持有此 owner）；false = 不认识，交下一个。 */
export type DeferredWakeHandler = (ownerId: string, key: PluginDeferredKey) => boolean;

const MAX_PENDING = 500;

const wakeHandlers = new Set<DeferredWakeHandler>();
/** 工具口：taskId → 发起者（async:true 声明工具的调用期登记）。 */
const tasks = new Map<string, DeferredOwner>();
/** MCP 路：progressToken → 发起者（tools/call 调用期登记）。 */
const callTokens = new Map<string, DeferredOwner>();

function pushBounded(map: Map<string, DeferredOwner>, key: string, value: DeferredOwner): void {
  map.set(key, value);
  const overflow = map.size - MAX_PENDING;
  if (overflow > 0) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** runtime 层注册唤醒路由器（workspace.ts setupAgent 调用）。返回退订。 */
export function registerDeferredWakeHandler(handler: DeferredWakeHandler): () => void {
  wakeHandlers.add(handler);
  return () => wakeHandlers.delete(handler);
}

// ── 工具口（manifest.tools async:true）──

let taskSeq = 0;

/** 生成插件任务 id（宿主侧唯一——回执卡片与完成通知同键）。 */
export function nextPluginTaskId(): string {
  return `ptask-${Date.now().toString(36)}-${++taskSeq}`;
}

/** 调用期登记（async 工具 execute 包装调）：taskId → 发起者。 */
export function bindPluginTask(taskId: string, owner: DeferredOwner): void {
  pushBounded(tasks, taskId, owner);
}

/** 插件后台完成（宿主桥 deferred.complete 真源）：唤醒发起 Agent。
 *  返回是否唤醒受理成功（未登记 taskId / 无 runtime 认领 = false）。 */
export function completePluginTask(taskId: string, status: PluginDeferredStatus, message?: string): boolean {
  const owner = tasks.get(taskId);
  if (!owner) return false;
  tasks.delete(taskId);
  return wake(owner, { taskId, status, plugin: owner.plugin, tool: owner.tool, message });
}

// ── MCP 路（mcpServers 完成通知）──

let tokenSeq = 0;

/** 调用期登记：生成 deferred progressToken（tools/call 请求经 _meta 发出，
 *  server 完成通知原样回带）。有发起者语境才登记——args._owner_id 缺席
 *  （无 Agent 调用）不绑 token。 */
export function bindMcpDeferredToken(owner: { ownerId: string; plugin: string; tool: string }): string | undefined {
  const token = `dftok-${Date.now().toString(36)}-${++tokenSeq}`;
  pushBounded(callTokens, token, owner);
  return token;
}

/** 完成通知翻译入口（mcp-bridge 挂 client.onNotification 调）：progressToken
 *  → 发起者 → 同一唤醒。未登记 token（server 乱发/超界被逐）= 静默忽略。 */
export function completeMcpDeferred(
  token: string,
  result: { taskId: string; status: PluginDeferredStatus; message?: string },
): void {
  const owner = callTokens.get(token);
  if (!owner) return;
  callTokens.delete(token);
  wake(owner, {
    taskId: result.taskId,
    status: result.status,
    plugin: owner.plugin,
    tool: owner.tool,
    message: result.message,
  });
}

// ── 唤醒核心 + minimal 定位键 ──

function wake(owner: DeferredOwner, key: PluginDeferredKey): boolean {
  if (!owner.ownerId) {
    // 无 Agent 语境（UI/测试直调）——无可唤醒面，best-effort warn 不静默
    console.warn('[plugins/deferred] 任务完成但无发起 Agent（ownerId 缺席），无法唤醒:', key.plugin, key.taskId);
    return false;
  }
  let accepted = false;
  for (const handler of [...wakeHandlers]) {
    if (handler(owner.ownerId, key)) {
      accepted = true;
      break;
    }
  }
  if (!accepted) {
    // 无 runtime 认领（发起会话已关/runtime 已拆）——可见不静默；通知丢失
    // 的兜底是插件自带的查询工具（凭 taskId 主动取）
    console.warn('[plugins/deferred] 唤醒无 runtime 受理（发起会话可能已关闭）:', key.plugin, key.taskId);
  }
  return accepted;
}

/** 唤醒注入体格式化（runtime 层 handler 消费——workspace.ts 组 bus 消息）。
 *  minimal 定位键纪律：JSON 恰 {status, taskId, sessionId} 三键 + 归因前缀；
 *  message 截 160 字另起一行。测试钉死形状。 */
export function formatDeferredWakeNote(key: PluginDeferredKey, sessionId: string): string {
  const attribution = key.tool ? `${key.plugin} · ${key.tool}` : key.plugin;
  const verb = key.status === 'failed' ? '失败' : '完成';
  const locator = JSON.stringify({ status: key.status, taskId: key.taskId, sessionId });
  let note = `插件后台任务${verb}（${attribution}）: ${locator}`;
  if (key.message) {
    note += `\n${key.message.slice(0, 160)}`;
  }
  return note;
}

/** 测试复位（vitest 同 worker 模块态跨用例共享——防串味）。 */
export function resetPluginDeferredForTests(): void {
  wakeHandlers.clear();
  tasks.clear();
  callTokens.clear();
}

/** 测试探针：待处理任务/令牌计数（护栏断言用）。 */
export function pendingDeferredCountForTests(): { tasks: number; tokens: number } {
  return { tasks: tasks.size, tokens: callTokens.size };
}
