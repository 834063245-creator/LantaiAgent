// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 从事件表 + 调用点扫描生成事件目录（平台化 Phase 3 · D9 目录生成，2026-08-27）。
// 用法：node scripts/gen-event-catalog.cjs [--check]（根目录薄壳转发，经 tsx 运行）。
//
// 目录事实全部机械推导自源码（无手工双源——D9 纪律）：
//   - 事件清单 / mode / 载荷：import src/agent/events 的 AGENT_EVENT_MAP +
//     LOOP_EVENT_NAMES（运行时单一真源；载荷名 = LoopEventPayload 接口命名映射）；
//   - 发射点 / 监听点：全仓文本扫描调用点（emitLoopEvent / runGuard /
//     runPreflight / runAround / emitResult / emitError / onLoopEvent / .on('…'），
//     file:line 确定性排序。
// 输出不含时间戳——字节稳定是 --check 对拍的前提（model-tool-contract 同款纪律）。
//
// 取代 docs/agents/event-feature-map.md 的手写「事件目录」表（拆旧 T-P3-1）：
// 手写表与 AGENT_EVENT_MAP 双源漂移，生成物 + 对拍守护是单一事实源。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_UI = path.resolve(import.meta.dirname ?? '.', '..');
const ROOT = path.resolve(SRC_UI, '..');
const OUT_MD = path.join(ROOT, 'docs', 'agents', 'event-catalog.md');
const EVENTS_FILE = 'src/agent/events';

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTs(full);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

interface Site {
  file: string;
  line: number;
}

/** 全文正则扫描（跨行调用可中——`.on(\n  'tool/guard'` 多行形态）。 */
function scanSitesIn(fileRel: string, text: string, pattern: RegExp): Site[] {
  const sites: Site[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  for (const m of text.matchAll(re)) {
    const line = text.slice(0, m.index).split('\n').length;
    sites.push({ file: fileRel, line });
  }
  return sites;
}

function scanSites(pattern: RegExp): Site[] {
  const sites: Site[] = [];
  for (const file of walkTs(path.join(SRC_UI, 'src'))) {
    const rel = path.relative(SRC_UI, file).replaceAll('\\', '/');
    sites.push(...scanSitesIn(rel, readFileSync(file, 'utf8'), pattern));
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function pascal(name: string): string {
  return name
    .split('/')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

function renderSites(sites: Site[]): string {
  if (sites.length === 0) return '—';
  return sites.map((s) => `\`${s.file}:${s.line}\``).join(' · ');
}

interface EventRow {
  name: string;
  mode: string;
  payload: string;
  declaredLine: number;
  dispatch: Site[];
  listen: Site[];
}

async function collectRows(): Promise<EventRow[]> {
  // 运行时单一真源：AGENT_EVENT_MAP（mode）+ LOOP_EVENT_NAMES（emit 域镜像）。
  // 与 gen-tool-contract 同款：纯 node + tsx 环境，先垫 window/document/navigator。
  type RecordAny = Record<string, unknown>;
  const g = globalThis as unknown as RecordAny;
  g.window ??= {};
  g.document ??= { createElement: () => ({ style: {} }) };
  g.navigator ??= { userAgent: 'node' };
  const eventsMod = await import('../src/agent/events');
  const AGENT_EVENT_MAP = eventsMod.AGENT_EVENT_MAP as Record<string, { mode: string }>;
  const LOOP_EVENT_NAMES = eventsMod.LOOP_EVENT_NAMES as readonly string[];
  const eventsText = readFileSync(path.join(SRC_UI, EVENTS_FILE + '.ts'), 'utf8');
  const eventsLines = eventsText.split('\n');

  // 载荷列：loop 域 = LoopEventPayload 接口的类型名（机械映射）；tool 域 =
  // runner 方法签名参数类型的机械提取（内联对象类型先折叠成 'object' 再按
  // 逗号拆——emitResult 的 result: { … } 形态）。
  const signaturePayload = (method: string): string => {
    const m = new RegExp(method + '\\(([^)]*)\\)').exec(eventsText);
    const sig = m?.[1];
    if (!sig) return '—';
    return sig
      .replace(/\{[^}]*\}/g, 'object')
      .split(',')
      .map((p) => p.trim().split(/:\s+/)[1] ?? p.trim())
      .filter(Boolean)
      .join(' + ');
  };
  const toolPayload: Record<string, string> = {
    'tool/guard': signaturePayload('runGuard'),
    'tool/preflight': signaturePayload('runPreflight'),
    'tool/around': signaturePayload('runAround'),
    'tool/result': signaturePayload('emitResult'),
    'tool/error': signaturePayload('emitError'),
  };

  const dispatchPatterns: Record<string, RegExp> = {
    'tool/guard': /\.runGuard\(/,
    'tool/preflight': /\.runPreflight\(/,
    'tool/around': /\.runAround\(/,
    'tool/result': /\.emitResult\(/,
    'tool/error': /\.emitError\(/,
  };
  // 监听点 = .on('…' 注册（含跨行）+ attach* 适配层的接线调用点
  // （lookbehind 排除适配层自身的 export function 定义行）。
  const listenerPatterns: Record<string, RegExp> = {
    'tool/guard': /\.on\(\s*'tool\/guard'|(?<!function\s)attachPlanGate\(/,
    'tool/preflight': /\.on\(\s*'tool\/preflight'|(?<!function\s)attachPreflightRegistry\(/,
    'tool/around': /\.on\(\s*'tool\/around'|(?<!function\s)attachHookRegistry\(/,
    'tool/result': /\.on\(\s*'tool\/result'/,
    'tool/error': /\.on\(\s*'tool\/error'/,
  };

  return Object.keys(AGENT_EVENT_MAP)
    .sort()
    .map((name) => {
      const isLoop = (LOOP_EVENT_NAMES as readonly string[]).includes(name);
      const dispatchRe = isLoop
        ? new RegExp("\\.emitLoopEvent\\('" + name.replace('/', '\\/') + "'")
        : dispatchPatterns[name];
      const listenRe = isLoop
        ? new RegExp("\\.onLoopEvent\\('" + name.replace('/', '\\/') + "'")
        : listenerPatterns[name];
      const mode = AGENT_EVENT_MAP[name]?.mode;
      if (!dispatchRe || !listenRe || !mode) throw new Error('[event-catalog] 事件面提取表缺项: ' + name);
      const dispatch = scanSites(dispatchRe);
      const listen = scanSites(listenRe);
      const declaredLine = eventsLines.findIndex((l) => l.includes("'" + name + "':")) + 1;
      const payload = isLoop ? pascal(name) + 'Payload' : (toolPayload[name] ?? '—');
      return { name, mode, payload, declaredLine, dispatch, listen };
    });
}

async function generate(): Promise<string> {
  const rows = await collectRows();
  const loopCount = rows.length - 5; // tool 管道域 5 事件（guard/preflight/around/result/error）
  let md = '# 事件目录（生成物）\n\n';
  md += '> 由 `scripts/gen-event-catalog.cjs`（经 tsx 运行 `src-ui/scripts/gen-event-catalog.ts`）\n';
  md += '> 从 `src/agent/events.ts`（AGENT_EVENT_MAP / LOOP_EVENT_NAMES 运行时真源）+ 全仓调用点扫描生成 — 勿手改。\n';
  md += '> 事件面变更后重新生成并同 commit；不含时间戳——字节稳定是 `--check`（doc-sync 门禁）的前提。\n\n';
  md += `共 ${rows.length} 个事件（loop/能力域 ${loopCount} + 工具管道域 5）。\n\n`;
  md += '> R1 声明：loop/能力域事件是可观测监听面——非模型可见、不进 session log；\n';
  md += '> legacy tool/* 事件保持 executor 双发（bus + legacy sink），UI 零改动。\n';
  md += '> 事件面开关：`seam/loopEvents` 组合域可禁用 emit 观测事件的广播\n';
  md += '> （裁决域 tool/guard|preflight|around 不开放——见 docs/composition/README.md §seam 裁剪域）。\n\n';
  md += '| 事件 | mode | 载荷 | 声明处 | 发射点 | 监听点 |\n';
  md += '|---|---|---|---|---|---|\n';
  for (const r of rows) {
    md += `| \`${r.name}\` | ${r.mode} | ${r.payload} | \`${EVENTS_FILE}.ts:${r.declaredLine}\` | ${renderSites(r.dispatch)} | ${renderSites(r.listen)} |\n`;
  }
  md += '\n## feature → mechanism 叙事\n\n';
  md += '功能与机制的对照叙事见 `event-feature-map.md`（本文件是机械矩阵——两者分工：\n';
  md += '矩阵 = 代码事实对拍面，叙事 = 设计意图与重表达规划）。\n';
  return md;
}

/** 供守护测试（tests/event-catalog-doc.test.ts）直接调用：重生成内容与已提交 md 对拍。 */
export const buildEventCatalog = generate;

async function main() {
  const check = process.argv.includes('--check');
  const md = await generate();
  if (check) {
    let current: string;
    try {
      current = readFileSync(OUT_MD, 'utf8');
    } catch {
      console.error(`[event-catalog] 缺生成物：${OUT_MD}（先运行 npm run gen:catalogs:event）`);
      process.exit(1);
    }
    if (current !== md) {
      console.error('[event-catalog] 事件目录已漂移而文档未再生成 —— 运行 npm run gen:catalogs:event 并同 commit');
      process.exit(1);
    }
    console.log('[ok] event-catalog.md 与事件真源一致');
    return;
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT_MD, md, 'utf8');
  console.log(`[ok] event-catalog.md written (${md.length} chars)`);
}

if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
