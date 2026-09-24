// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 压缩域实现对象（批 6d-2）：把产物包内的 15 个实现入口 + 工具面折成内核契约面
// `CompactionImplementation`，由 index.ts 在 apply 期登记进 `agent/compaction-impl.ts`。

import {
  applyAutoTuneConfigImpl,
  callSummaryLLMImpl,
  compactIfNeededImpl,
  compactNowImpl,
  computeCompactRegionImpl,
  foldHead,
  loadCompactionConfigImpl,
  loadCompactionTrackerImpl,
  maybeCompactImpl,
  mergePartialsImpl,
  payloadMessagesImpl,
  setCompactionConfigPathImpl,
  summarizeRegionImpl,
  summaryProviderImpl,
} from './agent-compaction';
import { createCompactionTools } from './compaction-model';
import type { CompactionImplementation } from './host';

export const compactionImplementation: CompactionImplementation = {
  foldHead,
  payloadMessages: payloadMessagesImpl,
  setCompactionConfigPath: setCompactionConfigPathImpl,
  loadCompactionTracker: loadCompactionTrackerImpl,
  loadCompactionConfig: loadCompactionConfigImpl,
  applyAutoTuneConfig: applyAutoTuneConfigImpl,
  computeCompactRegion: computeCompactRegionImpl,
  compactNow: compactNowImpl,
  compactIfNeeded: compactIfNeededImpl,
  maybeCompact: maybeCompactImpl,
  summarizeRegion: summarizeRegionImpl,
  summaryProvider: summaryProviderImpl,
  callSummaryLLM: callSummaryLLMImpl,
  mergePartials: mergePartialsImpl,
  createCompactionTools,
};
