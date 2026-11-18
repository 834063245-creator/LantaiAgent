// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压力读数的**唯一计算口**（2026-11-19 压力基准批）——压缩判定与 UI 读数的同源保证。
//
// 在此之前「上下文占用」有两个不相干的分子：UI 读数走 `measure()` 的投影（锚压力 +
// 表面增量），压缩触发判定走这里对外暴露的全量启发式重算。分词器估低时提示条说
// 85%、判定说 79%，于是「看着要压却一路不压」。本文件把两条路收成一条：
//
//   ① 有锚且信封仍同构（`TokenLedger.anchoredPressure` 核验）⇒ 返回「锚 + 增量」；
//   ② 否则 ⇒ 全量启发式，并把锚失效的具名原因交回调用方留痕（错误不静默）。
//
// 两条路都会把结果记进账本的**当前表面量**，所以紧接着的 `measure()` 与这里返回的
// 数字恒等（`'usage'` ⇒ `projectedTokens`；`'estimated'` ⇒ `surfaceTokens`）。

import type { Message, ToolSchema } from '../../provider/types';
import { countTexts } from '../token-counter';
import type { TokenLedger } from './contract';
import { measureEnvelope } from './estimate';
import type { TokenAnchorRejectReason, TokenBaselineKind } from './types';

/** 一次压力读数的结果。 */
export interface PressureReading {
  /** 压力读数（**判定与 UI 共用**；哨兵值永不出现——无载荷时是 0）。 */
  tokens: number;
  /** 用的是哪把尺子（`'usage'` = 提供方锚；`'estimated'` = 全量启发式）。 */
  basis: TokenBaselineKind;
  /** 锚在场但不可用时的具名原因（`no-anchor` 属正常开局，不报）。 */
  rejected?: TokenAnchorRejectReason;
}

/** 读数的输入信封（调用方给全，怎么算由本模块决定）。 */
export interface PressureEnvelope {
  /** `provider/model`（锚的同构判据之一）。 */
  model: string;
  /** 本次请求携带的工具 schema（与 `toolsTokens` 同源，别各算一遍）。 */
  toolSchemas: readonly ToolSchema[];
  /** 工具 schema 满量分词数（选择器锁存值）。 */
  toolsTokens: number;
  /** 发送载荷（折叠视图，**不含**尾部临时提醒消息）。 */
  payload: readonly Message[];
  /** 尾部临时提醒（只给本次请求、不落会话）。 */
  transientReminders: readonly string[];
  /** `'usage'`（缺省）= 能复用锚就复用；`'estimated'` = 强制全量启发式
   *  （**只给必须同尺对比的账目用**，如压缩压前/压后埋点）。 */
  basis?: TokenBaselineKind;
}

/** 读一次压力（唯一计算口）。 */
export function readPressure(ledger: TokenLedger, envelope: PressureEnvelope): PressureReading {
  if ((envelope.basis ?? 'usage') === 'usage') {
    const anchored = ledger.anchoredPressure({
      model: envelope.model,
      toolsCount: envelope.toolSchemas.length,
      toolsTokens: envelope.toolsTokens,
      transientTokens: countTexts(envelope.transientReminders),
      payload: envelope.payload,
    });
    if (anchored.ok) return { tokens: anchored.pressure, basis: 'usage' };
    if (anchored.reason !== 'no-anchor') {
      return { tokens: fullEstimate(ledger, envelope), basis: 'estimated', rejected: anchored.reason };
    }
  }
  return { tokens: fullEstimate(ledger, envelope), basis: 'estimated' };
}

/** 全量启发式：整份载荷 + 附图视觉 token + 临时提醒 + 工具 schema（一把尺子量到底）。 */
function fullEstimate(ledger: TokenLedger, envelope: PressureEnvelope): number {
  const measured = measureEnvelope(envelope.payload, envelope.toolSchemas, envelope.transientReminders, {
    toolsTokens: envelope.toolsTokens,
  });
  ledger.recordSurface(measured.surfaceTokens);
  return measured.surfaceTokens;
}
