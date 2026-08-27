// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// fs 后端能力注册表（平台化 Phase 2 · D11，2026-08-27）——ctx.fs seam。
//
// 裁定（agent-platformization-plan §3 D11）：fs 能力从前端工具层的 Rust 命令
// 直派生为可替换 seam——默认 provider = 现有 Rust fs 命令的薄包装
// （agent/fs-provider.ts，动作→命令恒等映射经注入的 dispatch 腰转发）；
// 替代 provider 可以是 JS 内存实现、MCP、远程后端。
//
// 强制层不旁路（D11 铁律）：权限咽喉 / plan gate / 审计在 executor 管道层，
// 先于工具 execute——provider 换实现不触碰、也不需要触碰强制层；dispatch 腰
// 作为调用选项注入（默认 provider 借腰转发命令名，替代 provider 可完全忽略）。
//
// 注册纪律：ContributionRegistry 单一内核复用（重名 id 装载期拒绝 + disposer
// 双守卫）；disposer 经 ctx.effect 登记（调用方所有权）。

import type { ToolExecutor } from '../agent/tool';
import { type Context, Service } from '../cordis';
import { ContributionRegistry } from './services';

/** fs 域动作（与 domains.ts fs 域动作枚举对齐——消费面形状的唯一事实）。 */
export type FsAction =
  | 'read'
  | 'write'
  | 'edit'
  | 'list'
  | 'glob'
  | 'mkdir'
  | 'move'
  | 'rename'
  | 'delete'
  | 'constraints'
  | 'write_constraints';

/** 一次 fs 调用的执行选项。dispatch = 强制层派发腰（executor 装配的
 *  codingExec——命令名→后端 + worktree 路由 + meta 透传）；默认 provider 借腰
 *  转发既有 Rust 命令，替代 provider 可完全忽略（自管后端）。 */
export interface FsCallOptions {
  dispatch: ToolExecutor;
  onProgress?: (chunk: string) => void;
  signal?: AbortSignal;
}

/** fs provider：一个「文件系统后端」。args 为模型可见参数 + executor 注入
 *  meta（_agent_id / _forceGate）全量透传——worktree 路由语义由 args 携带，
 *  不在接口层重建。返回值 = 工具结果文本（与派发腰返回一致）。 */
export interface FsProvider {
  /** 注册表寻址 id（稳定行标识）。 */
  id: string;
  execute(action: FsAction, args: Record<string, unknown>, opts: FsCallOptions): Promise<string>;
}

export class FsService extends Service {
  private registry = new ContributionRegistry<FsProvider>('fs');

  constructor(ctx: Context) {
    super(ctx, 'fs');
    setActiveFs(this);
  }

  register(def: FsProvider): () => void {
    return this.registry.register(def);
  }

  get(id: string): FsProvider | undefined {
    return this.registry.get(id);
  }

  list(): FsProvider[] {
    return this.registry.list();
  }
}

// ── 消费读取面（services.ts 同款间接层；模块级可变态归属 CONVENTIONS §1.10 第 3 类）──

let _activeFs: FsService | null = null;

function setActiveFs(svc: FsService): void {
  _activeFs = svc;
}

/** 当前 fs provider 贡献（无服务/无注册 = 空集——工具消费面的「后注册胜」扫描源）。 */
export function activeFsProviders(): FsProvider[] {
  return _activeFs?.list() ?? [];
}

// ── ctx 通道声明 ──

declare module '../cordis/context' {
  interface Context {
    /** fs 后端能力注册表（平台化 Phase 2 · D11）——默认 provider =
     *  builtin/rust-fs（agent/fs-provider.ts）；消费面 = agent/tools/coding.ts fs 域。 */
    fs: FsService;
  }
}

/** fs service 挂载插件（loader 第一方表；先于 builtin fs provider 插件）。 */
export const fsServicePlugin = {
  name: 'hologram/fs-service',
  apply(ctx: Context) {
    new FsService(ctx);
  },
};
