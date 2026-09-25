// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ctx.tokenMeter —— 内核算第 16 个 service（§4-6 A，用户 2026-09-25 裁定）。
//
// 病灶：token 计量面（每卷账本 `SessionTokenMeter` + 分桶代数 `usage.ts` +
// 构成估算 `estimate.ts` / `image-tokens.ts` + 文本分词 `token-counter.ts`）
// 是 Agent 与 UI 共同的度量面，却「既不在内核 service 清单、也无产物认领」
// ——账本 §5 挂成一条分类缺口，消费方（如创作坞墨量册）只能 import 内核
// 实现文件（构建期被内联成第二份副本）。
//
// 收口（原则二/三）：本 service 是 token 计量的**具名 owner**——
//   - `createLedger()` / `restoreLedger(snapshot)`：每卷账本的唯一制造面
//     （Agent 侧不再 `new SessionTokenMeter()`；账本实例仍归调用方持有，
//     服务不存任何账本——「每卷一本」的语义不能退化成进程一本）；
//   - `usage`：分桶代数唯一实例（真源 = `./usage`，形状 = `./contract` 的
//     `TokenAlgebra`），产品经 `ctx.tokenMeter.usage` 取用，禁自建副本。
//
// **录入点仍唯一 = `Agent.streamOnce`**（`CLAUDE.md` 口径纪律）：本 service
// 不含任何「写账」动作，只有造/恢复/读代数。
//
// 缺席语义：service = 内核不可禁用 ⇒ 缺实现具名 fail-loud
// （`TOKEN_METER_UNAVAILABLE`）。装载面 = `plugins/service-plugins.ts` 表序末位
// （内核 service 全部先于产物装载）；测试域复现装载态 = `tests/setup.ts`。

import { type Context, Service } from '../../cordis';
import type { TokenAlgebra, TokenLedger, TokenMeterImplementation } from './contract';
import { SessionTokenMeter } from './meter';
import type { TokenLedgerSnapshot } from './types';
import {
  addBuckets,
  billedInputTokens,
  bucketsEqual,
  bucketsFrom,
  cacheHitPercentText,
  formatExactTokens,
  formatTokens,
  isZeroBuckets,
  pressureTokens,
  totalTokens,
  ZERO_BUCKETS,
} from './usage';

/** 分桶代数唯一实例（真源 = `./usage` 的十一个动词 + 零桶常量）。 */
export const tokenAlgebra: TokenAlgebra = {
  bucketsFrom,
  billedInputTokens,
  pressureTokens,
  totalTokens,
  addBuckets,
  bucketsEqual,
  isZeroBuckets,
  cacheHitPercentText,
  formatTokens,
  formatExactTokens,
  ZERO_BUCKETS,
};

/** ctx.tokenMeter 服务：每卷账本工厂 + 分桶代数。 */
export class TokenMeterService extends Service implements TokenMeterImplementation {
  /** 分桶代数（只读；产品读用量读数经此面）。 */
  readonly usage: TokenAlgebra = tokenAlgebra;

  constructor(ctx: Context) {
    super(ctx, 'tokenMeter');
    setActiveTokenMeter(this); // 消费闭环读取面（内核读点经 requireTokenMeter）
  }

  /** 造一本新账（每卷一本；调用方持有，服务不留引用）。 */
  createLedger(): TokenLedger {
    return new SessionTokenMeter();
  }

  /** 从卷文件快照恢复账本（毒化数据降级为空账——`SessionTokenMeter.restore` 内保证）。 */
  restoreLedger(snapshot: TokenLedgerSnapshot | null | undefined): TokenLedger {
    return SessionTokenMeter.restore(snapshot);
  }
}

// ── 消费闭环读取面（services.ts / runtime-service.ts 同款：模块级活动服务，
//    CONVENTIONS §1.10 第 3 类可变态——键控自清理，生命周期 = 进程）──

let _activeTokenMeter: TokenMeterImplementation | null = null;

function setActiveTokenMeter(svc: TokenMeterImplementation): void {
  _activeTokenMeter = svc;
}

/** 缺服务时的具名错误（fail-loud：不静默造一本游离账本让读数假装存在）。 */
const TOKEN_METER_UNAVAILABLE =
  'TOKEN_METER_UNAVAILABLE: token 计量服务缺席——请确认内核 service hologram/token-meter 已装载' +
  '（它在 plugins/service-plugins.ts 表内，内核不可禁用）。';

/** 计量服务（无服务 = null——纯读诊断面用）。 */
export function activeTokenMeter(): TokenMeterImplementation | null {
  return _activeTokenMeter;
}

/** 取计量服务；无服务 = 具名 fail-loud（内核读点用：Agent 造账本 / 恢复账本）。 */
export function requireTokenMeter(): TokenMeterImplementation {
  if (!_activeTokenMeter) throw new Error(TOKEN_METER_UNAVAILABLE);
  return _activeTokenMeter;
}

/** 测试复位（生产不调用）。 */
export function resetTokenMeterForTests(): void {
  _activeTokenMeter = null;
}

// ── ctx 通道声明 ──

declare module '../../cordis/context' {
  interface Context {
    /** token 计量服务（§4-6 A）：每卷账本工厂 + 分桶代数；录入点仍唯一 =
     *  `Agent.streamOnce`。 */
    tokenMeter: TokenMeterService;
  }
}

/** 挂载插件（`plugins/service-plugins.ts` 表序末位：内核 service 先于产物）。 */
export const tokenMeterServicePlugin = {
  name: 'hologram/token-meter',
  apply(ctx: Context) {
    new TokenMeterService(ctx);
  },
};
