// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话持久化后端能力注册表（平台化 Phase 2 · D11，2026-08-27）——
// ctx.sessionPersistence seam。
//
// 动作面重设计（session-persistence-seam-wiring-plan C 定案，2026-09-05）：
// 旧六动作（read/write/append/appendLog/mkdir/delete）照抄 agent-store 磁盘
// CRUD 形状，对不上今天的会话模型（全量快照/目录扫描/墓碑删除）且无产线
// 消费方——agent-store 已内存化退役、agent_session_append RPC 零 TS 调用方。
// 换成**四动作、会话语义**（存储布局不进接口）：
//   read_volume {root,id}    → 卷 JSON 串或 'null'（缺失/坏文件——消费方判空）
//   list_volumes {root}      → 文件名 JSON 数组（provider 侧滤目录；保留
//                              _active.json 不过滤——消费方各自 parse id/墓碑判别）
//   save_volume {root,id,data}（快照 JSON 串）→ 'null'
//   delete_volume {root,id}  → 'null'（语义动作：默认 provider 墓碑重写
//                              deleted:true——消费方过滤契约依赖此形态；SQLite
//                              provider 可真删）。StoredSession 形状（含 deleted
//                              字段）留在消费方 chat-session——provider 存取不透明。
// root = 会话根目录（{ws}/.lantai/sessions——chat-session.ts:570 唯一权威拼接点）。
//
// 消费面（C 做实）：chat-session.ts / chat-core.ts 的产品会话卷持久化全链经
// sessionExecute 单点——插件注册 SessionPersistenceProvider 即接管产品会话
// 持久化（sessions-seam.test ③ fake provider 端到端 = 承诺的可执行证明）。
//
// 无腰设计：本 seam 的调用方是基础设施（非模型工具管道），args 为 snake_case
// RPC 参数直传，不带 _agent_id 等 meta——默认 provider 直调 kernel* helper，
// 不经 executor 派发腰（强制层 gate 管模型工具调用，不管 store 内部落盘）。

import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';
import { seamDisabled } from './seam-resolution';

/** 会话持久化动作（会话语义四动作 + 事件日志两动作——D-1/Phase 1；消费动词与
 *  chat-session 卷 CRUD 一一对应：全量快照读写 / 目录扫描 / 墓碑删除；事件日志
 *  追加（durable）与截断（断尾修复）见 DSH 参照移植计划）。运行时单一真源
 *  （sessions-seam.test ② 钉形与类型共用；变更 = 加数组元素 + provider 实现）。 */
export const SESSION_PERSIST_ACTIONS = [
  /** UI 投影缓存读（`{id}.json`——权威翻转后它只是缓存，不是卷本体）。 */
  'read_volume',
  /** 会话根目录枚举（文件名数组；消费方按 `.ndjson` / `.json` 各自认面）。 */
  'list_volumes',
  /** UI 投影缓存整体写（原子替换写）。 */
  'save_volume',
  /** 事件日志读取（缺失 = 空串，不抛）——内容真源读面。 */
  'read_log',
  /** 事件日志整体物化（原子替换写）——首批「头行 + 全部事件」。 */
  'write_log',
  /** 事件日志追加（durable：返回即已 fsync）——写面单点，检查点即排空队列。 */
  'append_events',
  /** 事件日志截断到字节偏移（断尾修复）。 */
  'truncate_log',
  /** 卷真删（日志 + 投影缓存一并删除）——墓碑语义随权威翻转退役：
   *  「文件不在 = 卷不存在」，不再需要写墓碑占位。 */
  'delete_log',
] as const;

export type SessionPersistAction = (typeof SESSION_PERSIST_ACTIONS)[number];

/** 会话持久化 provider：一个「会话存储后端」。args 为 snake_case RPC 参数
 *  （root = 会话根目录；data = 快照 JSON 串——provider 存取不透明 JSON）。 */
export interface SessionPersistenceProvider {
  /** 注册表寻址 id（稳定行标识）。 */
  id: string;
  execute(action: SessionPersistAction, args: Record<string, unknown>): Promise<string>;
}

export class SessionPersistenceService extends Service {
  // 请求期解析语义：卷 CRUD 消费面按 provider id 扫描（后注册胜 + 组合裁剪）。
  private registry = new ContributionChannel<SessionPersistenceProvider>('sessionPersistence', {
    timing: 'request',
  });

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

  /** Service 表面执行单点（D-6）：与模块级 sessionExecute 同一注册表决议——
   *  动态插件守卫白名单（sandbox.ts REQUIRED_FN_MEMBERS）声明
   *  sessionPersistence: ['execute']，本方法使该声明指向真实可调面。 */
  async execute(action: SessionPersistAction, args: Record<string, unknown>): Promise<string> {
    const providers = activeSessionPersistenceProviders();
    const provider = providers[providers.length - 1];
    if (!provider) {
      throw new Error(
        'SESSION_PERSISTENCE_PROVIDER: 无已注册会话持久化 provider——请确认 sessionPersistence 通道装配（生产 = loadBuiltinPlugins）',
      );
    }
    return provider.execute(action, args);
  }
}

// ── 消费读取面（模块级可变态归属 CONVENTIONS §1.10 第 3 类）──

let _activeSessions: SessionPersistenceService | null = null;

function setActiveSessionPersistence(svc: SessionPersistenceService): void {
  _activeSessions = svc;
}

/** 注册表原始清单（寻址行源——factoryComposition 的 `seam/sessionPersistence`
 *  域快照收编本清单；被组合禁用的行仍在此处，patch 才能重新启用）。 */
export function registeredSessionPersistenceProviders(): SessionPersistenceProvider[] {
  return _activeSessions?.list() ?? [];
}

/** 当前会话持久化 provider 贡献（无服务/无注册 = 空集——「后注册胜」扫描源）。
 *  裁剪面（平台化 Phase 3）：组合 `seam/sessionPersistence` 域禁用的 id 从视图剔除。 */
export function activeSessionPersistenceProviders(): SessionPersistenceProvider[] {
  const disabled = seamDisabled('sessionPersistence');
  return registeredSessionPersistenceProviders().filter((p) => !disabled.has(p.id));
}

/** 会话持久化消费单点（产品会话卷持久化唯一入口——chat-session/chat-core；
 *  无 provider 响亮报错——错误不静默）。 */
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
     *  builtin/rust-sessions（plugins/builtin/sessions-builtin）；消费面 =
     *  产品会话卷持久化（chat-session/chat-core 四动作）。 */
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
