// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话持久化后端能力注册表（平台化 Phase 2 · D11，2026-08-27）——
// ctx.sessionPersistence seam。
//
// 裁定（D11）：agent/会话状态的持久化（状态文件 + NDJSON 增量 + 索引）从前端
// 的 Rust 文件/追加命令直派生为可替换 seam——默认 provider = 现有 Rust 命令薄
// 包装（agent/sessions-provider.ts，动作→命令恒等映射）；替代 provider 可以是
// SQLite 后端、远程会话仓等。消费面 = agent/agent-store.ts 单一权威源。
//
// 范围注记（施工⑥）：chat-session.ts 的卷落盘写链（autoSave/导出）保持
// typedRpc 直连不动——冻结文件 + 非工具基础设施消费面，P5 全量挂 seam 时统一。
//
// 无腰设计：本 seam 的调用方是基础设施（非模型工具管道），args 为 snake_case
// RPC 参数直传，不带 _agent_id 等 meta——默认 provider 直调 typedRpc，不经
// executor 派发腰（强制层 gate 管模型工具调用，不 管 store 内部落盘）。

import { type Context, Service } from '../cordis';
import { ContributionRegistry } from './services';

/** 会话持久化动作（与 agent-store.ts 消费动词一一对应；appendLog = 会话事件
 *  日志 session-log.ndjson 追加，append = 当前消息投影 NDJSON 增量）。 */
export type SessionPersistAction = 'read' | 'write' | 'append' | 'appendLog' | 'mkdir' | 'delete';

/** 会话持久化 provider：一个「agent/会话状态存储后端」。args 为 snake_case
 *  RPC 参数（与现有 agent-store 调用形状逐字节一致）。 */
export interface SessionPersistenceProvider {
  /** 注册表寻址 id（稳定行标识）。 */
  id: string;
  execute(action: SessionPersistAction, args: Record<string, unknown>): Promise<string>;
}

export class SessionPersistenceService extends Service {
  private registry = new ContributionRegistry<SessionPersistenceProvider>('sessionPersistence');

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence');
    setActiveSessionPersistence(this);
  }

  register(def: SessionPersistenceProvider): () => void {
    return this.registry.register(def);
  }

  get(id: string): SessionPersistenceProvider | undefined {
    return this.registry.get(id);
  }

  list(): SessionPersistenceProvider[] {
    return this.registry.list();
  }
}

// ── 消费读取面（模块级可变态归属 CONVENTIONS §1.10 第 3 类）──

let _activeSessions: SessionPersistenceService | null = null;

function setActiveSessionPersistence(svc: SessionPersistenceService): void {
  _activeSessions = svc;
}

/** 当前会话持久化 provider 贡献（无服务/无注册 = 空集——agent-store 的「后注册胜」扫描源）。 */
export function activeSessionPersistenceProviders(): SessionPersistenceProvider[] {
  return _activeSessions?.list() ?? [];
}

/** 会话持久化消费单点（agent-store 唯一入口；无注册响亮报错——错误不静默）。 */
export function sessionExecute(action: SessionPersistAction, args: Record<string, unknown>): Promise<string> {
  const providers = activeSessionPersistenceProviders();
  const provider = providers[providers.length - 1];
  if (!provider) {
    return Promise.reject(
      new Error(
        'SESSION_PERSISTENCE_PROVIDER: 无已注册会话持久化 provider——请确认 sessionPersistence 通道装配（生产 = loadBuiltinPlugins）',
      ),
    );
  }
  return provider.execute(action, args);
}

// ── ctx 通道声明 ──

declare module '../cordis/context' {
  interface Context {
    /** 会话持久化注册表（平台化 Phase 2 · D11）——默认 provider =
     *  builtin/rust-sessions（agent/sessions-provider.ts）；消费面 = agent-store。 */
    sessionPersistence: SessionPersistenceService;
  }
}

/** 会话持久化 service 挂载插件（loader 第一方表；先于 builtin provider 插件）。 */
export const sessionPersistenceServicePlugin = {
  name: 'hologram/session-persistence-service',
  apply(ctx: Context) {
    new SessionPersistenceService(ctx);
  },
};
