// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 产物归家账（插件化欠账总账 §1 / §5 第 1 条 · 批 0b）——**销账制**。
//
// 病灶：账①（通道迁移 ✅）只证明「实现经 ctx.* 通道贡献」，**不证明实现住在产物包里**。
// 于是 `plugins/builtin/` 里 21 个包看着像已完成插件化（门禁全绿），实现却还躺在
// `agent/`、`provider/`、`composition/` 里 ≈10,052 行——两本账各自为真，读哪一本都
// 得到相反的印象（这就是「搞不清还剩多少」的直接来源）。
//
// **真源**：名册 `plugins/builtin-roster.json` 各条目的 `impl`（= 尚未归家的实现真源，
// 搬一条删一条，清空即实心化）。本测试只做**机制**：磁盘实测的空壳必须已登记；
// 登记的必须仍真的是空壳/仍被引用（实心化后不销账 = 红）；登记的实现文件必须还在。
// 人读视图 = `npm run plugin-home:report`（三色对账）。
//
// 判据（机械，非手抄）——一个产物包算「空壳」当且仅当：
//   ① **薄**：包内 .ts/.tsx 物理行 < THIN_LINES；且
//   ② **转发**：包内存在逃出包外的 import，且目标不是平台面（cordis / seam service /
//      装载链 / rpc-contract）。
// 两条都由磁盘实测（不读清单），因此**新造的空壳当场红**。
//
// 修复纪律（照 tests/paper-interaction-handoff.test.ts 的 KNOWN_DEAD）：搬一个，销一条。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROSTER } from '../src/plugins/builtin-roster';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const BUILTIN_SRC = join(SRC, 'plugins', 'builtin');

/** 薄包行数上限（2026-09-24 实测：空壳最长 124 行（llm-adapters），
 *  最薄的合格实心样板 170 行（sessions-builtin）/ 418 行（paper-minimap）——
 *  200 是两者之间的安全带）。 */
const THIN_LINES = 200;

/** 平台面（薄包合法依赖的「机制」目标——不算「实现仍在内核」的证据）。 */
const PLATFORM_TARGETS: RegExp[] = [
  /^cordis\//, // cordis 框架本体（vendored）
  /^composition\/[\w-]+-service\.tsx?$/, // seam service 定义（dispatcher，不是实现）
  /^plugins\//, // 装载链 / 平台类型 / contribution-helpers
  /^rpc-contract\.ts$/, // 强制层 RPC 面
];

/** 账本 §1 的备注（人读；键 = 产物 dir）。与名册 impl 一起构成归家账。 */
const NOTES: Record<string, string> = {
  'fs-domain': 'coding.ts 一文件载五族（fs/shell/git/ask/agent-isolation），须先按域拆',
  'shell-domain': '同上（coding.ts 五族之一）',
  'git-domain': '同上；随行 git-porcelain.ts 126 · sticky-cwd.ts 138',
  'ask-domain': '同上；随行 session-context.ts 122 · structured-error.ts 24',
  'agent-isolation-domain': '同上（coding.ts 五族之一）',
  'search-domain': 'manifest-tools 187；随行 tools/search-assembly.ts 169；输出形状须与 Rust 逐字节等价',
  'web-domain': '同上（同文件两域）',
  'agent-domain': 'agent/tools/subagent.ts 265 行',
  'asset-domain': '294 行；随行 asset-store.ts 137 · confirm-registry.ts 80',
  'memory-domain':
    '733 行；随行 memory-bundle-client.ts 134（批 3 复核：内核 `workspace.ts` 构造 MemoryManager ⇒ 宿主→插件方向禁反，待批 9）',
  'skill-domain':
    'skills.ts 377 + builtin-skills.ts 358（出厂技能内容；批 3 复核：内核 runtime/agent-builder/workspace 用 SkillRegistry ⇒ 待批 7/9）',
  'task-domain':
    'task.ts 178 + task-board.ts 319；随行 board-persistence.ts 121 · tools/board-status.ts 78（批 3 复核：TaskBoard 11 处内核消费者 ⇒ 待批 7）',
  'capability-segments': '389 行（14 项 capability 定义；AgentBlueprint 类=机制留内核）',
  'prompt-segments': '244 行（9 段文案真源；拼装序 = 字节契约）',
  'subagent-in-process': '543 行；搬前须先解 agent.ts 的值 re-export 桥（批 2 复核后并入批 7 同族一次搬完）',
  'agent-loop-service':
    '469 行；搬前须先解 agent.ts 的 opts.agentLoop ?? defaultAgentLoop 内核回落（agent-loop-active.ts 是内核桥，留）',
  // 半迁移（实心包里的残余——不是薄包，故不进空壳集，但同样按 impl 销账）
  'settings-domain': '门牌 + 面板壳已在包内；Provider 控制台 8 件 2,740 行仍在内核（账本 §2.1）',
  'paper-shell':
    '批 5a 已收 4 件（provenance/sel-ink/focus-flight/sheet）；余 `paper/type-tokens.ts` 806 行——它被内核 `paper/measure.ts` 引用（宿主→插件禁反）⇒ 随批 9',
};

// ── 磁盘判据 ──

function pkgTsFiles(dir: string): string[] {
  const root = join(BUILTIN_SRC, dir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** 物理行数（口径 = 账本：`(Get-Content).Count` 语义——末尾换行不算一行）。 */
function physicalLines(p: string): number {
  const text = readFileSync(p, 'utf8');
  if (text === '') return 0;
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** 包**逃出包外**的 import 目标（相对 src/ 的 posix 路径）。 */
function packageExternalImports(dir: string): Set<string> {
  const pkgRoot = join(BUILTIN_SRC, dir);
  const out = new Set<string>();
  for (const f of pkgTsFiles(dir)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const r = resolveSpecifier(f, m[1]!);
      if (r && !r.startsWith(pkgRoot + (process.platform === 'win32' ? '\\' : '/'))) {
        out.add(relative(SRC, r).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

/** 包内**自有实现**行数（排除注册面 `index.ts` / 两张宿主面 / 生成的 manifest.json / CSS）
 *  ——空壳的实质判据：一个包自己一行实现都没有，实现只可能在别处。 */
const BRIDGE_FILES = new Set(['index.ts', 'index.tsx', 'host.ts', 'host.aliased.ts', 'manifest.json']);
function selfImplLines(dir: string): number {
  return pkgTsFiles(dir)
    .filter((f) => !BRIDGE_FILES.has(basename(f)))
    .reduce((a, f) => a + physicalLines(f), 0);
}

/** 机械判据：这个包是「薄 + 自有实现为空 + 转发内核实现」的空壳吗？
 *  ⚠ 三条缺一不可（2026-09-24 批 3a 校准）：归家后的包**仍会**依赖内核平台面
 *  （`defineTool` / `Tool` 类型 / `rpc-contract`）——只看「有逃出包外的 import」
 *  会把 wait-domain 这类**刚搬完**的包重新判成空壳。 */
function looksLikeShell(dir: string): { shell: boolean; why: string } {
  const files = pkgTsFiles(dir);
  const lines = files.reduce((a, f) => a + physicalLines(f), 0);
  if (lines >= THIN_LINES) return { shell: false, why: `包内 ${lines} 行（≥ ${THIN_LINES}，不是薄包）` };
  const self = selfImplLines(dir);
  if (self > 0) return { shell: false, why: `薄（${lines} 行）但自有实现 ${self} 行（= 已实心化）` };
  const implTargets = [...packageExternalImports(dir)].filter((t) => !PLATFORM_TARGETS.some((re) => re.test(t)));
  if (implTargets.length === 0) return { shell: false, why: `薄（${lines} 行）且自有实现为空，但只桥平台面` };
  return { shell: true, why: `薄（${lines} 行）+ 自有实现为空 + 转发 ${implTargets.join(', ')}` };
}

/** 名册里的归家认领（impl 非空 = 该产物仍有实现留在内核）。 */
const CLAIMS = BUILTIN_ROSTER.filter((e) => (e.impl?.length ?? 0) > 0).map((e) => ({
  dir: e.dir,
  impl: e.impl ?? [],
  isShell: looksLikeShell(e.dir).shell,
}));
const SHELL_DIRS = CLAIMS.filter((c) => c.isShell).map((c) => c.dir);

describe('产物归家账（销账制：搬一个销一条，清空即全绿）', () => {
  it('机械判据自检：真空壳命中、已归家/合格样板不命中（防守卫自身失灵）', () => {
    expect(looksLikeShell('fs-domain').shell, 'fs-domain 应判为空壳').toBe(true);
    expect(looksLikeShell('memory-domain').shell, 'memory-domain 应判为空壳').toBe(true);
    expect(looksLikeShell('wait-domain').shell, 'wait-domain 批 3a 已归家（自有实现 102 行）').toBe(false);
    expect(looksLikeShell('office-domain').shell, 'office-domain 批 3a 已归家（自有实现 576 行）').toBe(false);
    expect(looksLikeShell('llm-adapters').shell, 'llm-adapters 批 2a 已归家').toBe(false);
    expect(looksLikeShell('fs-builtin').shell, 'fs-builtin 是合格样板（provider 本体在包内）').toBe(false);
    expect(looksLikeShell('shell-builtin').shell, 'shell-builtin 同上').toBe(false);
    expect(looksLikeShell('sessions-builtin').shell, 'sessions-builtin 同上（只桥 rpc-contract 强制层）').toBe(false);
    expect(looksLikeShell('paper-shell').shell, 'paper-shell 实现自持（不是薄包）').toBe(false);
  });

  it('磁盘实测的空壳集 ⊆ 名册已登记的归家认领（新造空壳没登记 impl = 红）', () => {
    const claimed = new Set(CLAIMS.map((c) => c.dir));
    const unknown = BUILTIN_ROSTER.map((e) => e.dir)
      .filter((dir) => looksLikeShell(dir).shell)
      .filter((dir) => !claimed.has(dir));
    expect(
      unknown,
      `这些产物包是空壳但名册没登记 impl（新欠账要么当场实心化，要么在 builtin-roster.json 该条目加 impl 写清实现真源）：\n${unknown
        .map((d) => `${d}：${looksLikeShell(d).why}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('登记为空壳的每条都仍真的是空壳（实心化后必须销账，否则红）', () => {
    const stale = CLAIMS.filter((c) => c.isShell && !looksLikeShell(c.dir).shell).map(
      (c) => `${c.dir}（${looksLikeShell(c.dir).why}）`,
    );
    expect(
      stale,
      `这些包已不再满足空壳判据（多半是实心化完成了）——请从名册该条目的 impl 删掉对应路径销账：\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('每条登记的实现真源文件仍在（账不腐：路径改名/搬迁后必须同步更新名册）', () => {
    const missing: string[] = [];
    for (const c of CLAIMS) {
      for (const rel of c.impl) {
        if (!existsSync(join(SRC, rel))) missing.push(`${c.dir} → src/${rel}`);
      }
    }
    expect(missing, `名册 impl 登记的实现真源已不存在（账本腐化，请改路径或销账）：\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  it('每条登记的实现真源仍被该包引用（全部不再引用 = 已搬完，必须销账）', () => {
    const done: string[] = [];
    for (const c of CLAIMS) {
      const ext = packageExternalImports(c.dir);
      const still = c.impl.filter((rel) => ext.has(rel));
      if (still.length === 0) done.push(`${c.dir} → 已不再 import ${c.impl.join(', ')}`);
    }
    expect(done, `这些包的实现已不在内核（搬运完成）——请从名册该条目的 impl 销账：\n${done.join('\n')}`).toEqual([]);
  });

  it('账本口径自洽：空壳 16 条（14 纯壳 + 2 半壳），且每条都有备注文本', () => {
    // 口径：账本 §1 立账 21 条；批 2a 销 `llm-adapters`、批 3a 销 wait/office/cordis、
    // 批 4a 销 `browser-desktop-domain` ⇒ 销 5 条。数字再变 = 要么又销了账（改这条），要么漏登记。
    expect(SHELL_DIRS.length, `空壳集 = ${SHELL_DIRS.join(', ')}；立账 21 − 已销 5 = 16`).toBe(16);
    for (const dir of SHELL_DIRS) expect(NOTES[dir], `${dir} 缺账本备注`).toBeTruthy();
    // 反向：备注表不许留已销账的条目（防文本腐烂）
    const ghost = Object.keys(NOTES).filter((d) => !CLAIMS.some((c) => c.dir === d));
    expect(ghost, `NOTES 里有名册未认领的条目（销账时忘了删备注）：\n${ghost.join('\n')}`).toEqual([]);
  });
});
