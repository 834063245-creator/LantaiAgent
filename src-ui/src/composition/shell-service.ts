// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell 后端能力注册表（平台化 Phase 2 · D11，2026-08-27）——ctx.shell seam。
//
// 裁定（D11 + 施工⑤修订注记）：shell 能力（执行 + 后台任务族）从前端工具层的
// Rust 命令直派生为可替换 seam——默认 provider = 现有 Rust shell 命令薄包装
// （agent/shell-provider.ts）。**ctx.subprocess 并入本 seam**：现有形态中
// spawn/stdio/进程树即 exec_command 后台任务族（runInBackground + bash_output/
// bash_wait/bash_kill），独立 subprocess 通道无第二消费者，按「无消费者不开
// 通道」纪律不开——D11 修订注记留痕于计划 §3。
//
// 强制层不旁路（D11 铁律，同 fs）：权限咽喉 / plan gate / 审计在 executor
// 管道层，先于工具 execute——provider 换实现不触碰强制层。
//
// 注册纪律：ContributionChannel 单一内核复用；disposer 经 ctx.effect 登记。

import type { ToolExecutor } from '../agent/tool';
import { type Context, Service } from '../cordis';
import { ContributionChannel } from './contribution-channel';
import { type SeamDisabledMap, seamDisabled } from './seam-resolution';

/** shell 域动作（执行 + 后台任务族三动词）。 */
export type ShellAction = 'run' | 'output' | 'kill' | 'wait';

/** 一次 shell 调用的执行选项（fs-service 同款：dispatch 腰注入）。 */
export interface ShellCallOptions {
  dispatch: ToolExecutor;
  onProgress?: (chunk: string) => void;
  signal?: AbortSignal;
}

/** shell provider：一个「shell/子进程后端」。args 全量透传（含 meta）。 */
export interface ShellProvider {
  /** 注册表寻址 id（稳定行标识）。 */
  id: string;
  execute(action: ShellAction, args: Record<string, unknown>, opts: ShellCallOptions): Promise<string>;
}

export class ShellService extends Service {
  // 请求期解析语义：shell 域动作消费面按 provider id 扫描（后注册胜 + 组合裁剪）。
  private registry = new ContributionChannel<ShellProvider>('shell', { timing: 'request' });

  constructor(ctx: Context) {
    super(ctx, 'shell');
    setActiveShell(this);
  }

  register(def: ShellProvider): () => void {
    return this.registry.register(def);
  }

  get(id: string): ShellProvider | undefined {
    return this.registry.get(id);
  }

  list(): ShellProvider[] {
    return this.registry.list();
  }
}

// ── 消费读取面（模块级可变态归属 CONVENTIONS §1.10 第 3 类）──

let _activeShell: ShellService | null = null;

function setActiveShell(svc: ShellService): void {
  _activeShell = svc;
}

/** 注册表原始清单（寻址行源——factoryComposition 的 `seam/shell` 域快照收编本
 *  清单；被组合禁用的行仍在此处，patch 才能重新启用）。 */
export function registeredShellProviders(): ShellProvider[] {
  return _activeShell?.list() ?? [];
}

/** 当前 shell provider 贡献（无服务/无注册 = 空集——工具消费面的「后注册胜」扫描源）。
 *  裁剪面（平台化 Phase 3）：组合 `seam/shell` 域禁用的 provider id 从视图剔除。
 *  view（S6 P2a）= 调用方所属组合的裁剪面；**缺省 = 全局当前选择**（旧路径零漂移）。 */
export function activeShellProviders(view?: SeamDisabledMap | null): ShellProvider[] {
  const disabled = seamDisabled('shell', view);
  return registeredShellProviders().filter((p) => !disabled.has(p.id));
}

// ── ctx 通道声明 ──

declare module '../cordis/context' {
  interface Context {
    /** shell 后端能力注册表（平台化 Phase 2 · D11；subprocess 并入本 seam）——
     *  默认 provider = builtin/rust-shell（agent/shell-provider.ts）；
     *  消费面 = agent/tools/coding.ts shell 域四工具。 */
    shell: ShellService;
  }
}

/** shell service 挂载插件（loader 第一方表；先于 builtin shell provider 插件）。 */
export const shellServicePlugin = {
  name: 'hologram/shell-service',
  apply(ctx: Context) {
    new ShellService(ctx);
  },
};
