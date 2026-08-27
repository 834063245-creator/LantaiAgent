// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 动态插件运行时注册表（平台化 Phase 4 · D7，2026-08-27）——ctx.dynamicRunner。
//
// 裁定（agent-platformization-plan §3 D7）：运行时 define → run → stop →
// undefine → inspect cordis 插件包（DSH cordis-host-runner 同构）；**动态插件
// 可提供任意 seam**（工具/面板/命令/llm adapter/fs/shell/session/graph/
// subagents/prompts/renderers/capabilities 的 register 贡献），不只是工具行。
// 宿主半进沙箱求值（agent/dynamic-runner/sandbox.ts——阴影求值面 + 守卫注册
// 面 + 预算）；**动态插件 = approval + 沙箱**（D12 信任模型）——未授权的包
// 不能运行，审批经 cordis_run 工具注入的 UI 通道（askUser 语义）。
//
// 生命周期：动态插件挂载为 runner 自身 fiber 的子插件（ctx.plugin）——
// stop/undefine dispose 链式回收全部贡献（cordis 内核纪律）；runner 随根
// fiber 拆除时全部动态插件一并回收。
// 所有权：插件按定义会话（owner = 工具 args 的 _agent_id）隔离——跨会话
// 不可见/不可操作（多 Agent 并发纪律）。
// 包不可变（DSH 同构）：每次 define 追加新 packageId；currentPackageId 只在
// 完整成功后推进；失败回滚重挂旧包（尽力，失败可见）。

import { type Context, type Fiber, Service } from '../../cordis';
import {
  type CompiledDynamicPlugin,
  checkDynamicSyntax,
  DYNAMIC_APPLY_TIMEOUT_MS,
  type DynamicGuardedCtx,
  evaluateDynamicPlugin,
  type GuardBudget,
  makeGuardedCtx,
  runDynamicApply,
} from './sandbox';

/** 动态包诊断（inspect_self 的重建面——P4-C2 全程可重建）。 */
export interface DynamicDiagnostics {
  status: 'running' | 'stopped' | 'failed';
  message?: string;
  at: string;
}

export interface DynamicPackageRecord {
  packageId: string;
  name: string;
  purpose: string;
  code: string;
  diagnostics: DynamicDiagnostics | null;
}

export interface DynamicPluginRecord {
  pluginId: string;
  ownerSessionId: string;
  /** idPrefix（kind=new 时的语义前缀，诊断用）。 */
  idPrefix: string;
  packages: DynamicPackageRecord[];
  currentPackageId?: string;
  nextPackageId?: string;
  activeFiber?: Fiber;
  activeBudget?: GuardBudget;
  /** 当前激活的服务贡献 disposer 袋（stop/失败/undefine 逆序 dispose）。 */
  activeBag?: Array<() => void>;
}

export interface DefineRequest {
  kind: 'new' | 'existing';
  /** kind=new：3-6 个小写英文字母的语义前缀（宿主补唯一后缀）。 */
  idPrefix?: string;
  /** kind=existing：已有插件 id。 */
  pluginId?: string;
  name: string;
  purpose: string;
  /** 插件工厂源码：纯 JS 函数体，return { name?, apply(ctx) }。 */
  code: string;
}

export interface DefineReceipt {
  pluginId: string;
  packageId: string;
  name: string;
  purpose: string;
}

export interface RunReceipt {
  status: 'running';
  pluginId: string;
  packageId: string;
}

/** 运行审批请求（cordis_run 的 UI 通道注入——runner 不知道 UI）。 */
export interface DynamicApprovalRequest {
  pluginId: string;
  packageId: string;
  name: string;
  purpose: string;
}

export type DynamicApproval = (req: DynamicApprovalRequest) => Promise<boolean>;

const ID_PREFIX_RE = /^[a-z]{3,6}$/;

export class DynamicRunnerService extends Service {
  private readonly plugins = new Map<string, DynamicPluginRecord>();
  private readonly approvals = new Set<string>();
  private seq = 0;
  /** apply 时限（测试可注入小值；生产 = sandbox 常量）。 */
  applyTimeoutMs = DYNAMIC_APPLY_TIMEOUT_MS;

  constructor(ctx: Context) {
    super(ctx, 'dynamicRunner');
    // 根面兜底回收：服务贡献的 disposer 袋不挂插件 fiber（经 runner 代注册），
    // runner fiber 拆除（根 teardown）时全部回收——所有权单一。
    this.ctx.effect(
      () => () => {
        for (const record of this.plugins.values()) {
          void this.disposeActive(record);
        }
      },
      'dynamic-runner-root-teardown',
    );
    setActiveRunner(this);
  }

  // ── define：定义不可变包（只校验 + 记录，不执行不推进 current）──

  define(owner: string, req: DefineRequest): DefineReceipt {
    if (typeof req.name !== 'string' || req.name.trim() === '' || req.name.length > 120) {
      throw new Error('[dynamic-runner] name 必须是非空字符串（≤120 字符）');
    }
    if (typeof req.purpose !== 'string' || req.purpose.trim() === '' || req.purpose.length > 500) {
      throw new Error('[dynamic-runner] purpose 必须是非空字符串（≤500 字符）');
    }
    checkDynamicSyntax(req.code); // 语法 + 源码预算在此显式拒绝
    let record: DynamicPluginRecord;
    let packageIndex: number;
    if (req.kind === 'new') {
      if (typeof req.idPrefix !== 'string' || !ID_PREFIX_RE.test(req.idPrefix)) {
        throw new Error('[dynamic-runner] kind=new 需要 idPrefix（3-6 个小写英文字母）');
      }
      this.seq += 1;
      const pluginId = `dyn-${req.idPrefix}-${String(this.seq).padStart(4, '0')}`;
      record = { pluginId, ownerSessionId: owner, idPrefix: req.idPrefix, packages: [] };
      this.plugins.set(pluginId, record);
      packageIndex = 0;
    } else {
      const existing = req.pluginId ? this.plugins.get(req.pluginId) : undefined;
      if (!existing || existing.ownerSessionId !== owner) {
        throw new Error(`[dynamic-runner] 插件不存在或非本会话所有: ${req.pluginId ?? '(缺 pluginId)'}`);
      }
      record = existing;
      packageIndex = record.packages.length;
    }
    const packageId = `${record.pluginId}.p${packageIndex + 1}`;
    record.packages.push({
      packageId,
      name: req.name.trim(),
      purpose: req.purpose.trim(),
      code: req.code,
      diagnostics: null,
    });
    return { pluginId: record.pluginId, packageId, name: req.name.trim(), purpose: req.purpose.trim() };
  }

  // ── run：激活一个精确包（approval + 沙箱 + 失败回滚）──

  async run(
    owner: string,
    pluginId: string,
    packageId: string,
    mode: 'run' | 'update',
    approval?: DynamicApproval,
  ): Promise<RunReceipt> {
    const record = this.owned(owner, pluginId);
    if (mode === 'update' && record.currentPackageId === undefined) {
      // DSH 语义：update = 从当前包切到另一包——无运行中包时首激活必须用 run
      throw new Error('[dynamic-runner] mode=update 需要当前有运行中的包（首激活用 mode=run）');
    }
    const pkg = record.packages.find((p) => p.packageId === packageId);
    if (!pkg) {
      throw new Error(`[dynamic-runner] 包不存在: ${pluginId}/${packageId}（用 inspect_list 查看可用包）`);
    }
    // 审批门（D12）：未授权的包不能运行；无审批通道且未授权 = 拒绝
    const approvalKey = `${owner}:${pluginId}/${packageId}`;
    if (!this.approvals.has(approvalKey)) {
      if (!approval) {
        throw new Error('APPROVAL_REQUIRED: 动态插件未经授权且本会话无审批通道——拒绝运行（先经用户批准）');
      }
      const ok = await approval({ pluginId, packageId, name: pkg.name, purpose: pkg.purpose });
      if (!ok) {
        throw new Error('APPROVAL_DENIED: 用户拒绝运行动态插件——不得重复请求审批');
      }
      this.approvals.add(approvalKey);
    }
    // 求值在停旧之前——语法/形状失败不动现有运行面（DSH 语义）
    let compiled: CompiledDynamicPlugin;
    try {
      compiled = evaluateDynamicPlugin(pkg.code, `dynamic/${pluginId}`);
    } catch (e) {
      this.recordDiagnostics(pkg, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }
    const previous = record.currentPackageId;
    if (record.activeFiber) {
      await this.disposeActive(record); // update/restart：先回收旧包
    }
    record.nextPackageId = packageId;
    const budget: GuardBudget = { count: 0, cancelled: false };
    const bag: Array<() => void> = [];
    const timeoutMs = this.applyTimeoutMs;
    const resolverCtx = this.ctx; // 服务解析面（runner 代解析——见 sandbox.makeGuardedCtx）
    const attempt = this.ctx.plugin({
      name: `dynamic/${pluginId}`,
      async apply(realCtx: Context) {
        const guarded: DynamicGuardedCtx = makeGuardedCtx(realCtx, resolverCtx, bag, budget);
        await runDynamicApply(compiled.apply, guarded, timeoutMs, () => {
          budget.cancelled = true;
        });
      },
    });
    try {
      const fiber = await attempt;
      record.activeFiber = fiber;
      record.activeBudget = budget;
      record.activeBag = bag;
      record.currentPackageId = packageId;
      record.nextPackageId = undefined;
      pkg.diagnostics = { status: 'running', at: new Date().toISOString() };
      return { status: 'running', pluginId, packageId };
    } catch (e) {
      budget.cancelled = true;
      const message = e instanceof Error ? e.message : String(e);
      // 失败尝试现场回收：服务贡献 bag 逆序 dispose + 插件 fiber 拆除
      // （fiber 可能已创建而 apply 中途失败——不回收 = 贡献残留）。
      for (let i = bag.length - 1; i >= 0; i--) {
        try {
          bag[i]?.();
        } catch (disposeError) {
          console.error('[dynamic-runner] 失败尝试的贡献 disposer 执行失败:', disposeError);
        }
      }
      try {
        await (attempt as unknown as { dispose: () => Promise<void> }).dispose();
      } catch (disposeError) {
        console.error('[dynamic-runner] 失败尝试的 fiber dispose 失败:', disposeError);
      }
      pkg.diagnostics = { status: 'failed', message, at: new Date().toISOString() };
      // 回滚：尽力重挂旧包（源码在册——包此前已被授权运行，无审批需求）；
      // 失败可见（console.error），不静默吞。
      const previousPkg = record.packages.find((p) => p.packageId === previous);
      if (previousPkg) {
        try {
          await this.mount(record, previousPkg);
          record.currentPackageId = previous;
          previousPkg.diagnostics = { status: 'running', at: new Date().toISOString() };
        } catch (rollbackError) {
          console.error(
            `[dynamic-runner] 回滚重挂 ${pluginId}/${previous} 失败:`,
            rollbackError instanceof Error ? rollbackError.message : rollbackError,
          );
          record.currentPackageId = undefined;
        }
      } else {
        record.currentPackageId = undefined;
      }
      throw e instanceof Error ? e : new Error(message);
    }
  }

  // ── stop / undefine ──

  async stop(owner: string, pluginId: string): Promise<{ stopped: true }> {
    const record = this.owned(owner, pluginId);
    if (record.activeFiber) {
      await this.disposeActive(record);
      const pkg = record.packages.find((p) => p.packageId === record.currentPackageId);
      if (pkg) pkg.diagnostics = { status: 'stopped', at: new Date().toISOString() };
      record.currentPackageId = undefined;
      record.nextPackageId = undefined;
    }
    return { stopped: true };
  }

  async undefine(owner: string, pluginId: string): Promise<{ undefined: true }> {
    await this.stop(owner, pluginId);
    this.plugins.delete(pluginId);
    for (const key of [...this.approvals]) {
      if (key.startsWith(`${owner}:${pluginId}/`)) this.approvals.delete(key);
    }
    return { undefined: true };
  }

  // ── inspect（P4-C2 全程可重建面）──

  listInspect(owner: string): Array<{
    pluginId: string;
    name: string;
    purpose: string;
    packages: number;
    currentPackageId?: string;
    running: boolean;
  }> {
    return [...this.plugins.values()]
      .filter((r) => r.ownerSessionId === owner)
      .map((r) => ({
        pluginId: r.pluginId,
        name: r.packages[r.packages.length - 1]?.name ?? r.idPrefix,
        purpose: r.packages[r.packages.length - 1]?.purpose ?? '',
        packages: r.packages.length,
        currentPackageId: r.currentPackageId,
        running: r.activeFiber != null,
      }));
  }

  inspectSelf(owner: string, pluginId?: string, packageId?: string): unknown {
    if (pluginId === undefined) {
      return { mode: 'plugins', plugins: this.listInspect(owner) };
    }
    const record = this.owned(owner, pluginId);
    if (packageId === undefined) {
      return {
        mode: 'plugin',
        pluginId: record.pluginId,
        ownerSessionId: record.ownerSessionId,
        currentPackageId: record.currentPackageId,
        packages: record.packages.map((p) => ({
          packageId: p.packageId,
          name: p.name,
          purpose: p.purpose,
          diagnostics: p.diagnostics,
          isCurrent: p.packageId === record.currentPackageId,
        })),
        running: record.activeFiber != null,
      };
    }
    const pkg = record.packages.find((p) => p.packageId === packageId);
    if (!pkg) throw new Error(`[dynamic-runner] 包不存在: ${pluginId}/${packageId}`);
    return {
      mode: 'package',
      pluginId: record.pluginId,
      packageId: pkg.packageId,
      name: pkg.name,
      purpose: pkg.purpose,
      source: pkg.code,
      diagnostics: pkg.diagnostics,
      isCurrent: pkg.packageId === record.currentPackageId,
    };
  }

  /** 审批记录（诊断面——inspect 层可呈现「哪些包已授权」）。 */
  approvedKeys(): string[] {
    return [...this.approvals];
  }

  // ── 内部 ──

  private owned(owner: string, pluginId: string): DynamicPluginRecord {
    const record = this.plugins.get(pluginId);
    if (!record || record.ownerSessionId !== owner) {
      throw new Error(`[dynamic-runner] 插件不存在或非本会话所有: ${pluginId}`);
    }
    return record;
  }

  private recordDiagnostics(pkg: DynamicPackageRecord, status: DynamicDiagnostics['status'], message?: string): void {
    pkg.diagnostics = { status, message, at: new Date().toISOString() };
  }

  private async disposeActive(record: DynamicPluginRecord): Promise<void> {
    if (record.activeBudget) record.activeBudget.cancelled = true;
    const fiber = record.activeFiber;
    const bag = record.activeBag ?? [];
    record.activeFiber = undefined;
    record.activeBudget = undefined;
    record.activeBag = undefined;
    // 逆序 dispose 服务贡献（后注册的贡献可能依赖先注册的）——再拆插件 fiber
    for (let i = bag.length - 1; i >= 0; i--) {
      try {
        bag[i]?.();
      } catch (e) {
        console.error('[dynamic-runner] 贡献 disposer 执行失败（不阻断回收链）:', e);
      }
    }
    if (fiber) await fiber.dispose();
  }

  /** 重挂一个包（回滚路径——无审批：包此前已被授权运行过）。 */
  private async mount(record: DynamicPluginRecord, pkg: DynamicPackageRecord): Promise<void> {
    const compiled = evaluateDynamicPlugin(pkg.code, `dynamic/${record.pluginId}`);
    const budget: GuardBudget = { count: 0, cancelled: false };
    const bag: Array<() => void> = [];
    const timeoutMs = this.applyTimeoutMs;
    const resolverCtx = this.ctx;
    const fiber = await this.ctx.plugin({
      name: `dynamic/${record.pluginId}`,
      async apply(realCtx: Context) {
        const guarded = makeGuardedCtx(realCtx, resolverCtx, bag, budget);
        await runDynamicApply(compiled.apply, guarded, timeoutMs, () => {
          budget.cancelled = true;
        });
      },
    });
    record.activeFiber = fiber;
    record.activeBudget = budget;
    record.activeBag = bag;
  }
}

declare module '../../cordis/context' {
  interface Context {
    /** 动态插件运行时（平台化 Phase 4 · D7）——define/run/stop/undefine/
     *  inspect；沙箱宿主半见 agent/dynamic-runner/sandbox.ts。 */
    dynamicRunner: DynamicRunnerService;
  }
}

// ── 消费读取面（活动服务 + 测试复位——code-runtime 同款）──

let _activeRunner: DynamicRunnerService | null = null;

function setActiveRunner(svc: DynamicRunnerService): void {
  _activeRunner = svc;
}

/** 当前动态插件运行时（cordis 工具消费面；无装配 = null → 工具面响亮报错）。 */
export function activeDynamicRunner(): DynamicRunnerService | null {
  return _activeRunner;
}

/** 测试复位（生产不调用）。 */
export function resetDynamicRunnerForTests(): void {
  _activeRunner = null;
}

// ── 挂载插件（loadBuiltinPlugins 表序——先于外部插件与 cordis 工具装配）──

export const dynamicRunnerPlugin = {
  name: 'hologram/dynamic-runner',
  apply(ctx: Context) {
    new DynamicRunnerService(ctx);
  },
};
