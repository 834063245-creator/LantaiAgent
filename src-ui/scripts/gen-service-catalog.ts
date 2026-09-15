// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 从组合层源码生成 ctx 服务目录（平台化 Phase 3 · D9 目录生成，2026-08-27）。
// 用法：node scripts/gen-service-catalog.cjs [--check]（根目录薄壳转发，经 tsx 运行）。
//
// 目录事实全部机械推导自源码（无手工双源——D9 纪律）：
//   - service 清单：grep `export class XxxService extends Service`；**ctx 键以类体
//     `super(ctx, '<键>')` 为准**（机械可推导且每类唯一，实测 19 类 ↔ 19 处一一对应）；
//   - 描述的取法：同文件 `declare module ... interface Context` 增广优先；同文件找不到
//     时**按 ctx 键全仓找**增广取 JSDoc。⚠ 2026-09-16 补口：增广的类型名**不必等于**
//     Service 类名——先例 `ctx.agentLoop` 的增广声明为 `AgentLoopServiceFace`（结构面），
//     旧规则「同文件按类名找增广」会让该服务在目录里**整个消失**；而 `doc-sync` 抓不到，
//     因为生成器对自身缺口是自洽的（生成物与生成器一致 = 检查通过）。
//   - kind 三分：ctx 键 ∈ SEAM_DOMAINS（seam-resolution.ts 单一真源，剔除
//     loopEvents 事件域）→ swappable seam；类体有 `register(def: *Contribution)`
//     → 贡献通道；其余 → 服务；
//   - 默认实现：全仓扫描 `*.register(` 调用块中的 `id: '...'` 字面量，
//     服务名段匹配 ctx 键的（root.fs.register / ctx.llm.register…）；
//   - 消费面：import 服务模块（或其 active*/Execute 消费入口）的 src 文件
//     + 含 `ctx.<键>` 的文件（去 owner/测试）。
// 输出不含时间戳——字节稳定是 --check 对拍的前提（model-tool-contract 同款纪律）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { SEAM_DOMAINS } from '../src/composition/seam-resolution';

const SRC_UI = path.resolve(import.meta.dirname ?? '.', '..');
const ROOT = path.resolve(SRC_UI, '..');
const OUT_MD = path.join(ROOT, 'docs', 'agents', 'service-catalog.md');
const SCAN_DIRS = [
  'src/composition',
  'src/agent',
  'src/ui',
  'src/app',
  'src/shell',
  'src/paper',
  'src/state',
  'src/plugins',
  'src/provider',
];

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

interface SourceFile {
  file: string;
  /** 原文（extractCtxKey 的 JSDoc 描述提取用）。 */
  text: string;
  /** 注释剥离后的代码文本（消费面/实现扫描用——注释里提及 ctx.<键> 不是消费）。 */
  code: string;
}

/** 排除清单：内容数据模块（非代码——字符串里的 ctx.* / *.register( 示例
 *  文案会误判成消费面/实现 id，机械扫描按设计不剥字符串字面量）。
 *  每收一个纯文档/数据模块必须在此登记，防目录虚胖。 */
const CONTENT_DATA_FILES = new Set(['src/agent/builtin-skills.ts']);

function scanSources(): Map<string, SourceFile> {
  const out = new Map<string, SourceFile>();
  for (const dir of SCAN_DIRS) {
    const abs = path.join(SRC_UI, dir);
    for (const file of walkTs(abs)) {
      const rel = path.relative(SRC_UI, file).replaceAll('\\', '/');
      if (CONTENT_DATA_FILES.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      out.set(rel, { file: rel, text, code: stripComments(text) });
    }
  }
  return out;
}

/** 保守注释剥离：块注释全剥；行注释只剥行首形态（不碰字符串里的 'http://…'）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface ServiceEntry {
  key: string;
  service: string;
  owner: string;
  kind: 'seam' | 'channel' | 'service';
  description: string;
  implementations: string[];
  consumers: string[];
}

/** ctx 键 → Service 名 + JSDoc 描述（同文件 declare module 增广）。
 *  ⚠ 只在增广的**类型名就是 Service 类名**时命中——`ctx.agentLoop` 声明为
 *  `AgentLoopServiceFace`（结构面）故不命中，由 ctor 取键 + 按键找描述兜住。 */
function extractCtxKey(text: string, service: string): { key: string; description: string } | null {
  // 形如「/** 注释 */\n  key: XxxService;」（注释可跨行）
  const re = new RegExp('/\\*\\*([^*]*(?:\\*(?!/)[^*]*)*)\\*/\\s*(\\w+):\\s*' + service + '\\s*;');
  const m = re.exec(text);
  if (!m) {
    const bare = new RegExp('(\\w+):\\s*' + service + '\\s*;');
    const b = bare.exec(text);
    const key = b?.[1];
    return key ? { key, description: '' } : null;
  }
  const description = (m[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
  const key = m[2];
  return key ? { key, description } : null;
}

/** ctx 键的**权威来源**：类体 `super(ctx, '<键>')` 字面量。
 *  机械可推导、每类唯一（实测 19 类 ↔ 19 处一一对应）；与增广的类型名**解耦**——
 *  这正是「按类名找同文件增广」漏掉结构面声明（`ctx.agentLoop`）的补口。 */
function extractCtxKeyFromCtor(classBody: string): string | null {
  const m = /super\(\s*ctx\s*,\s*'([^']+)'\s*\)/.exec(classBody);
  return m?.[1] ?? null;
}

/** 全仓按 **ctx 键**找 `declare module … interface Context` 增广并取 JSDoc 描述。
 *  按文件路径排序遍历（确定性——字节稳定是 --check 的前提）。 */
function extractKeyDescription(sources: Map<string, SourceFile>, key: string): string {
  const re = new RegExp('/\\*\\*([^*]*(?:\\*(?!/)[^*]*)*)\\*/\\s*' + key + ':\\s*[\\w.$]+\\s*;');
  for (const rel of [...sources.keys()].sort()) {
    const text = sources.get(rel)?.text ?? '';
    const m = re.exec(text);
    if (m) {
      return (m[1] ?? '')
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .filter(Boolean)
        .join(' ');
    }
  }
  return '';
}

function classifyKind(key: string, classBody: string): ServiceEntry['kind'] {
  const seamKeys = SEAM_DOMAINS.filter((d) => d !== 'loopEvents');
  if ((seamKeys as readonly string[]).includes(key)) return 'seam';
  if (/register\(def:\s*\w*Contribution\b/.test(classBody)) return 'channel';
  return 'service';
}

/** 模块级 const 标识符 → id 字面量（「register(标识符)」形态的解析表——
 *  builtin provider 常量定义在贡献插件之外，如 agent/fs-provider.ts 的
 *  builtinFsProvider）。 */
function buildConstIdMap(sources: Map<string, SourceFile>): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:const|let|var)\s+(\w+)[^=\n]*=\s*\{[\s\S]{0,400}?id:\s*'([^']+)'/g;
  for (const { code } of sources.values()) {
    for (const m of code.matchAll(re)) {
      const name = m[1];
      const id = m[2];
      if (name && id) map.set(name, id);
    }
  }
  return map;
}

/** 默认实现：`<key>.register(` 调用点的 id——两种形态都收：
 *  内联对象字面量（register({ id: 'x' …})）与标识符（register(builtinFsProvider)
 *  ——经 const→id 解析表）。 */
function extractImplementations(
  sources: Map<string, SourceFile>,
  constIds: Map<string, string>,
  key: string,
): string[] {
  const ids = new Set<string>();
  const prefix = key + '.register(';
  for (const { code } of sources.values()) {
    let idx = code.indexOf(prefix);
    while (idx >= 0) {
      const rest = code.slice(idx + prefix.length, idx + prefix.length + 400);
      const inline = /id:\s*'([^']+)'/.exec(rest.slice(0, 200));
      const ident = /^([\w$]+)/.exec(rest.trimStart());
      const inlineId = inline?.[1];
      const identName = ident?.[1];
      if (inlineId) {
        ids.add(inlineId);
      } else if (identName) {
        const resolved = constIds.get(identName);
        if (resolved) ids.add(resolved);
      }
      idx = code.indexOf(prefix, idx + prefix.length);
    }
  }
  return [...ids].sort();
}

function extractConsumers(sources: Map<string, SourceFile>, ownerModule: string, key: string, owner: string): string[] {
  const consumers = new Set<string>();
  const ownerBase = path.basename(ownerModule).replace(/\.tsx$/, '');
  for (const [rel, { code }] of sources) {
    if (rel === owner) continue;
    const importsOwner = new RegExp("from\\s+'[^']*" + ownerBase + "'").test(code);
    const usesCtx = new RegExp('ctx\\.' + key + '\\b').test(code);
    if (importsOwner || usesCtx) consumers.add(rel);
  }
  return [...consumers].sort();
}

function buildEntries(sources: Map<string, SourceFile>): ServiceEntry[] {
  const constIds = buildConstIdMap(sources);
  const entries: ServiceEntry[] = [];
  for (const [rel, { text }] of sources) {
    const re = /export class (\w+Service) extends Service \{/g;
    for (const m of text.matchAll(re)) {
      const service = m[1];
      if (!service) continue;
      const classBody = text.slice(m.index, text.indexOf('\n}', m.index) + 2);
      const sameFile = extractCtxKey(text, service);
      // 键以类体 `super(ctx, '<键>')` 为准；无字面量 super 时退回同文件增广（兼容旧形态）
      const key = extractCtxKeyFromCtor(classBody) ?? sameFile?.key ?? null;
      if (!key) continue;
      // 描述：同文件增广命中且键一致 → 用它；否则按**键**全仓找（结构面声明的服务走这条）
      const description = sameFile && sameFile.key === key ? sameFile.description : extractKeyDescription(sources, key);
      const kind = classifyKind(key, classBody);
      const ownerModule = rel.replace(/\.tsx$/, '');
      entries.push({
        key,
        service,
        owner: rel,
        kind,
        description,
        implementations: extractImplementations(sources, constIds, key),
        consumers: extractConsumers(sources, ownerModule, key, rel),
      });
    }
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

const KIND_LABEL: Record<ServiceEntry['kind'], string> = {
  seam: 'swappable seam（可换实现）',
  channel: '贡献通道',
  service: '服务',
};

function generate(sources: Map<string, SourceFile>): string {
  const entries = buildEntries(sources);
  const seams = entries.filter((e) => e.kind === 'seam');
  const channels = entries.filter((e) => e.kind === 'channel');
  const services = entries.filter((e) => e.kind === 'service');

  let md = '# ctx 服务目录（生成物）\n\n';
  md += '> 由 `scripts/gen-service-catalog.cjs`（经 tsx 运行 `src-ui/scripts/gen-service-catalog.ts`）\n';
  md += '> 从组合层源码机械推导生成 — 勿手改；服务面变更后重新生成并同 commit。\n';
  md += '> 不含时间戳：字节稳定是 `--check`（doc-sync 门禁）的前提。\n\n';
  md += `共 ${entries.length} 个 ctx 服务：seam ${seams.length} · 贡献通道 ${channels.length} · 服务 ${services.length}。\n`;
  md += 'kind 三分规则（机械推导）：ctx 键 ∈ SEAM_DOMAINS（seam-resolution.ts 单一真源）= seam；\n';
  md += '类体含 `register(def: *Contribution)` = 贡献通道；其余 = 服务。\n\n';

  for (const [title, list] of [
    ['swappable seam（能力契约层——可换实现）', seams],
    ['贡献通道', channels],
    ['服务', services],
  ] as const) {
    md += `## ${title}\n\n`;
    md += '| ctx 键 | Service | owner | 默认实现 / 贡献者 | 消费面 |\n';
    md += '|---|---|---|---|---|\n';
    for (const e of list) {
      const impls = e.implementations.map((i) => `\`${i}\``).join(' · ') || '—';
      md += `| \`ctx.${e.key}\` | \`${e.service}\` | \`${e.owner}\` | ${impls} | ${e.consumers.length} 文件 |\n`;
    }
    md += '\n';
    for (const e of list) {
      md += `### \`ctx.${e.key}\` — ${e.service}（${KIND_LABEL[e.kind]}）\n\n`;
      if (e.description) md += `${e.description}\n\n`;
      md += `- owner：\`${e.owner}\`\n`;
      md += `- 默认实现 / 贡献者 id：${e.implementations.map((i) => `\`${i}\``).join(' · ') || '—'}\n`;
      if (e.consumers.length > 0) {
        md += `- 消费面（${e.consumers.length}）：${e.consumers.map((c) => `\`${c}\``).join(' · ')}\n`;
      } else {
        md += '- 消费面：—（无直接 import/ctx 引用——运行时通道注入）\n';
      }
      md += '\n';
    }
  }
  return md;
}

/** 供守护测试（tests/service-catalog-doc.test.ts）直接调用：重生成内容与已提交 md 对拍。 */
export function buildServiceCatalog(): string {
  return generate(scanSources());
}

async function main() {
  const check = process.argv.includes('--check');
  const md = buildServiceCatalog();
  if (check) {
    let current: string;
    try {
      current = readFileSync(OUT_MD, 'utf8');
    } catch {
      console.error(`[service-catalog] 缺生成物：${OUT_MD}（先运行 npm run gen:catalogs:service）`);
      process.exit(1);
    }
    if (current !== md) {
      console.error('[service-catalog] 服务目录已漂移而文档未再生成 —— 运行 npm run gen:catalogs:service 并同 commit');
      process.exit(1);
    }
    console.log('[ok] service-catalog.md 与源码事实一致');
    return;
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT_MD, md, 'utf8');
  console.log(`[ok] service-catalog.md written (${md.length} chars)`);
}

if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
