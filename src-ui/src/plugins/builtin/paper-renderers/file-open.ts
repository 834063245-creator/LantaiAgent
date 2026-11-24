// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话文件引用的**宿主动作面**（2026-11-23 文件引用可点 · 相对路径批；
// 2026-11-24 可点判定收紧批：先核实再可点）。
//
// 三层分工：
//   1. `paper/file-ref`：这串文本像不像本机文件、逻辑绝对路径是什么（纯函数）；
//   2. 本文件：`fs_cap stat` 门禁——文件存在、不是目录、文卷能打开，才返回
//      `openable`；相对路径按常见子根再试（模型常把 src-ui 下的路径写短）；
//   3. 宿主桥 `windows.openWith`：真正开窗（无文档能力插件时状态栏具名报错）。
//
// 为什么经 globalThis 而不是 import window-facility：直接 import 会把 mcp-bridge /
// 生命周期一族牵进渲染面，形成循环依赖（构建门禁直接红）。宿主桥 windows.openWith
// 就是这条缝的正式出口（产物域与测试域同一形状）。
// `fs_cap stat` 走既有宿主面 `typedRpc`（本包本地图回读同款），不新增封面。

import { useEffect, useState } from 'react';
import {
  candidateFileRefs,
  isLocalFileReference,
  isOpenableDocumentPath,
  normalizeLocalPath,
} from '../../../paper/file-ref';
import { typedRpc, useShellStore } from './host';

type FileOpenBridge = { windows?: { openWith?: (path: string) => boolean } };

interface StatResult {
  path: string;
  is_dir: boolean;
}

interface CachedStat {
  at: number;
  result: StatResult | null;
}

interface CachedRef {
  at: number;
  /** 探针时的工具卡落定代（0 = 参数面先渲染；1 = 结果已到）。 */
  rev: number;
  value: OpenableRef;
}

export type OpenableState = 'pending' | 'openable' | 'unopenable';

/** 引用解析结果：`local` = 这串是不是本机文件形态（外部 URL 为 false）。 */
export interface OpenableRef {
  state: OpenableState;
  /** 已核实可打开的逻辑绝对路径（`openable` 时有值）。 */
  path: string | null;
  /** 本机文件形态（链接面据此保留外部 URL 的 `target=_blank`）。 */
  local: boolean;
}

const STAT_TTL = 10_000;
const REF_TTL = 30_000;
const statCache = new Map<string, CachedStat>();
const refCache = new Map<string, CachedRef>();

function tidyStatPath(p: string): string {
  const stripped = p.startsWith('\\\\?\\') ? p.slice(4) : p;
  return normalizeLocalPath(stripped);
}

async function statFile(path: string, fresh = false): Promise<StatResult | null> {
  const cached = statCache.get(path);
  if (!fresh && cached && Date.now() - cached.at < STAT_TTL) return cached.result;
  let result: StatResult | null = null;
  try {
    const raw = await typedRpc('fs_cap', { action: 'stat', file_path: path, is_agent: false });
    if (raw !== null && typeof raw === 'object') {
      const p = (raw as { path?: unknown }).path;
      const d = (raw as { is_dir?: unknown }).is_dir;
      if (typeof p === 'string' && p !== '') result = { path: tidyStatPath(p), is_dir: d === true };
    }
  } catch {
    // stat 失败 = 不存在 / 越界 / 目录被拒——调用方按「不可打开」处理（不静默：点击时
    // openReferencedFile 会补状态栏；渲染面只决定「不可点」）。
    result = null;
  }
  statCache.set(path, { at: Date.now(), result });
  return result;
}

/** 解析一份引用：依次试「直接路径 + 常见子根候选」，第一个 **存在的文本文档** 胜出。
 *  不做同名文件搜索（同名文件猜错比不可点更糟）；裸文件名只在工作区根存在时成立。 */
export async function probeFileRef(raw: string, root: string): Promise<OpenableRef> {
  if (raw.trim() === '' || root.trim() === '') return { state: 'unopenable', path: null, local: false };
  const local = isLocalFileReference(raw, root);
  if (!local) return { state: 'unopenable', path: null, local: false };
  for (const candidate of candidateFileRefs(raw, root)) {
    if (!isOpenableDocumentPath(candidate)) continue;
    const st = await statFile(candidate);
    if (st !== null && !st.is_dir && isOpenableDocumentPath(st.path)) {
      return { state: 'openable', path: st.path, local: true };
    }
  }
  return { state: 'unopenable', path: null, local: true };
}

/** 渲染期门禁：`openable` 才允许出可点签；`pending` 时按普通 code 渲染（不闪链接）。
 *  `revision` 是同一引用的「落定代」：工具卡参数面先渲染、结果后到——`fs(write)`
 *  在参数面时文件还不存在，结果落到后必须重探一次（否则「打开」签永远不出现）。 */
export function useOpenableRef(raw: string | null, revision = 0): OpenableRef {
  const root = useShellStore((s) => s.projectPath);
  const text = raw ?? '';
  const local = text !== '' && isLocalFileReference(text, root);
  const key = `${root}\u0000${text}`;
  const [value, setValue] = useState<OpenableRef>(() => {
    const hit = local ? refCache.get(key) : undefined;
    if (hit && hit.rev === revision && Date.now() - hit.at < REF_TTL) return hit.value;
    return { state: 'unopenable', path: null, local };
  });

  useEffect(() => {
    if (text === '' || !local) {
      setValue({ state: 'unopenable', path: null, local: false });
      return;
    }
    const hit = refCache.get(key);
    if (hit && hit.rev === revision && Date.now() - hit.at < REF_TTL) {
      setValue(hit.value);
      return;
    }
    let alive = true;
    setValue({ state: 'pending', path: null, local: true });
    void probeFileRef(text, root).then((next) => {
      refCache.set(key, { at: Date.now(), rev: revision, value: next });
      if (alive) setValue(next);
    });
    return () => {
      alive = false;
    };
  }, [key, text, root, local, revision]);

  // local 是同步派生量；缓存值里的 local 与之同源。保持返回形状一致。
  return value.local === local ? value : { ...value, local };
}

/** 把一份**已核实**的文件交给宿主窗口设施打开（没有宿主桥/文档插件时由宿主报可见错误）。 */
export function openReferencedFile(path: string): void {
  const host = (globalThis as { __lantai_plugin_host__?: FileOpenBridge }).__lantai_plugin_host__;
  const openWith = host?.windows?.openWith;
  if (typeof openWith !== 'function') {
    useShellStore.getState().pushStatus('宿主窗口设施未就绪，无法打开文件');
    return;
  }
  void (async () => {
    // 点击时强制 fresh：渲染期核实过的文件可能在这几秒内被删/移走——
    // 缓存成功不能作为「现在还能开」的证据。
    const st = await statFile(path, true);
    if (st === null || st.is_dir || !isOpenableDocumentPath(st.path)) {
      useShellStore.getState().pushStatus(`找不到可打开的文件：${path}`);
      return;
    }
    openWith(st.path);
  })();
}
