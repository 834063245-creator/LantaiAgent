// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// codingExec 无状态族域第一方插件（P4 存量拆解 B① + ②，
// agent-plugin-architecture-plan §5）——五族从 composition/tool-rows 行表
// 迁入 ctx.tools 贡献通道：git/search（B①，2026-08-23）+ fs/shell/
// agent-isolation（②，2026-08-23；域插件形状对齐 S3 settings-plugin 先例：
// 一域一插件，disposer 经 ctx.effect 登记）。
//
// 搬运勘定（baton7 §1 + ② 批沿用）：五族只依赖 codingExec——装配期新闭包
// 但语义无状态（闭包只引用模块级 agentInvoke/execStreamedShell，不捕获
// 装配 opts），因此 pluginToolRows 的实例缓存（首装配实例跨装配复用）
// 语义等价。依赖装配期真值的族（ask 的 ui 回调 / wait 的 subAgentPool /
// memory・skill・task・agent 的可选 registry——①c 批）不适用本通道。
//
// 可见面零漂移按构造成立：旧名在 convergeRegistry 后经
// collectHiddenToolNames 隐藏，可见域工具由 DOMAIN_SPECS 声明序重建
// （createDomainTools 按注册表现存旧工具过滤 action，注册序无关）——
// 走行表还是插件通道注册不改变模型可见面（phase-0 快照守护，双 preset
// 实测）。
//
// 寻址域（② 批临时收窄 → S4-4 甲恢复全量，2026-08-23）：五族贡献行经
// factoryComposition() 快照进组合解析域——patch/preset 可寻址
// 'plugin/hologram/<域>-domain/<工具名>' 行禁用单个工具（粒度 = 贡献行
// = 单工具；原 builtin/<族> 整族行 id 退役不复活）。
//
// 一文件五插件：familyContributions 族贡献清单 helper 由各域共享（族注册
// 形状相同，拆文件只会复制 helper——B① 落文件时已定此形）。

import type { Tool, ToolExecutor } from '../agent/tool';
import {
  createAgentIsolationTools,
  createFsTools,
  createGitTools,
  createSearchTools,
  createShellTools,
} from '../agent/tools/coding';
import type { ToolContribution } from '../composition/services';
import type { Context } from '../cordis';

/** apply 期名字展开用的占位 exec——族工厂是纯函数，exec 只在工具 execute
 *  闭包里被引用，apply 期永不执行；占位符抛错保证任何误执行立即可见。 */
const NEVER_EXEC: ToolExecutor = async () => {
  throw new Error('[coding-domain-plugins] apply 期占位 exec 不应被调用');
};

/** 注册一个工具族为贡献清单：每工具一条贡献（id = `<插件名>/<工具名>`）。
 *  贡献 factory 惰性建族——首个贡献装配时以真实 rowCtx.codingExec 构建，
 *  同族贡献共享一次建族（apply 作用域闭包，非模块级态）。 */
function familyContributions(pluginName: string, build: (exec: ToolExecutor) => Tool[]): ToolContribution[] {
  // apply 期展开一次取名字清单——真源是族工厂本身，不手抄名字表
  const names = build(NEVER_EXEC).map((t) => t.name());
  let family: Tool[] | null = null;
  return names.map((name) => ({
    id: `${pluginName}/${name}`,
    factory: (rowCtx) => {
      // 本通道贡献需要装配上下文（codingExec）——折算路径未穿 ctx 立即炸，
      // 不注入延迟爆炸的占位 exec（错误不静默）
      if (!rowCtx?.codingExec) {
        throw new Error(`[${pluginName}] 工具贡献 ${name} 需要装配上下文（codingExec）——折算路径未穿 rowCtx`);
      }
      family ??= build(rowCtx.codingExec);
      const tool = family.find((t) => t.name() === name);
      if (!tool) throw new Error(`[${pluginName}] 族内未找到工具 ${name} —— 族工厂输出漂移`);
      return tool;
    },
  }));
}

/** git 域插件——贡献 13 工具（序 = createGitTools 声明序）。 */
export const gitDomainPlugin = {
  name: 'hologram/git-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = familyContributions('hologram/git-domain', createGitTools).map((c) => ctx.tools.register(c));
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'git-domain-tools');
  },
};

/** search 域插件——贡献 search_content 单工具。 */
export const searchDomainPlugin = {
  name: 'hologram/search-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = familyContributions('hologram/search-domain', createSearchTools).map((c) =>
        ctx.tools.register(c),
      );
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'search-domain-tools');
  },
};

/** fs 域插件——贡献 11 工具（序 = createFsTools 声明序；② 批 2026-08-23）。 */
export const fsDomainPlugin = {
  name: 'hologram/fs-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = familyContributions('hologram/fs-domain', createFsTools).map((c) => ctx.tools.register(c));
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'fs-domain-tools');
  },
};

/** shell 域插件——贡献 4 工具（run_shell → bash_output/kill/wait；② 批）。 */
export const shellDomainPlugin = {
  name: 'hologram/shell-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = familyContributions('hologram/shell-domain', createShellTools).map((c) =>
        ctx.tools.register(c),
      );
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'shell-domain-tools');
  },
};

/** agent-isolation 域插件——贡献 worktree 隔离 5 工具（② 批）。 */
export const agentIsolationDomainPlugin = {
  name: 'hologram/agent-isolation-domain',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = familyContributions('hologram/agent-isolation-domain', createAgentIsolationTools).map((c) =>
        ctx.tools.register(c),
      );
      return () => {
        for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
      };
    }, 'agent-isolation-domain-tools');
  },
};
