// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// CacheStore — 从 state-inject.ts 模块级 let 迁移而来的 agent 注入缓存。
// 所有数据均可序列化；不含 Map/Set/Promise/AbortController。
// （check/timeline 缓存随图谱功能全量退役删除，2026-09-09——run_check
//  简报与引擎时间线均属图数据面。）

import { createStore } from 'zustand/vanilla';

// ── 类型 ──

export interface GitStatusSummary {
  branch: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  /** git_status files 元素（Rust utils::parse_status 同形——键是 path 非 file）。 */
  dirtyFiles: Array<{ path: string; status: string; staged: boolean; old_path?: string }>;
}

export interface BuildResult {
  command: string;
  outcome: 'pass' | 'fail';
  summary: string;
  ts: number;
  /** 产生该结果的 Agent（executor 注入的 _agent_id）。
   *  turn-start 只消费同 Agent 的条目，避免跨会话张冠李戴。 */
  ownerId?: string | null;
}

// ── Store ──

interface CacheState {
  gitCache: GitStatusSummary | null;
  gitCacheTs: number;
  blameCache: Record<string, string>;
  buildResultCache: BuildResult | null;
  /** 代际计数 — resetAgentCaches 递增；异步刷新 resolve 时比对，
   *  代际不同说明工作区已切换，在途的旧项目数据直接丢弃。 */
  epoch: number;
}

export const cacheStore = createStore<CacheState>(() => ({
  gitCache: null,
  gitCacheTs: 0,
  blameCache: {},
  buildResultCache: null,
  epoch: 0,
}));

// ── 访问器（镜像 state-inject.ts 导出接口）──

export function getGitCache(): GitStatusSummary | null {
  return cacheStore.getState().gitCache;
}
export function setGitCache(cache: GitStatusSummary, ts: number): void {
  cacheStore.setState({ gitCache: cache, gitCacheTs: ts });
}
export function getGitCacheTs(): number {
  return cacheStore.getState().gitCacheTs;
}

export function getBlameCache(): Record<string, string> {
  return cacheStore.getState().blameCache;
}
export function setBlameEntry(file: string, value: string): void {
  cacheStore.setState((s) => ({ blameCache: { ...s.blameCache, [file]: value } }));
}
export function hasBlameEntry(file: string): boolean {
  return file in cacheStore.getState().blameCache;
}

export function getBuildResultCache(): BuildResult | null {
  return cacheStore.getState().buildResultCache;
}
export function setBuildResultCache(result: BuildResult | null): void {
  cacheStore.setState({ buildResultCache: result });
}

// ── 生命周期 ──

export function getCacheEpoch(): number {
  return cacheStore.getState().epoch;
}

/** 工作区停用/切换时清空全部注入缓存并推进代际。
 *  清空防止旧项目状态注入新项目；推进代际让在途的
 *  fire-and-forget 刷新 resolve 后自动放弃写入。 */
export function resetAgentCaches(): void {
  cacheStore.setState((s) => ({
    gitCache: null,
    gitCacheTs: 0,
    blameCache: {},
    buildResultCache: null,
    epoch: s.epoch + 1,
  }));
}

/** 编辑/写入前调用 — 使该文件的 blame 条目失效，下次 pre-read 重新拉取。 */
export function invalidateBlameEntry(file: string): void {
  const s = cacheStore.getState();
  if (!(file in s.blameCache)) return;
  const next = { ...s.blameCache };
  delete next[file];
  cacheStore.setState({ blameCache: next });
}
