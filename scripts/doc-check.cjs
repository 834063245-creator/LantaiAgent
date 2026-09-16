// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 文档面门禁 doc-check（文档面大重构 P0 · 立尺，2026-09-16）。
//
// 病症（本轮实测）：文档面缺的不是整理，而是代码面早就有的「单一权威源 + 门禁
// 对拍」——同一个数字在 N 份文档手抄，补丁打不全（AgentConfig 28 已改两处、
// ARCHITECTURE×2 与根 README 仍是 31）；入口文档在讲已退役的世界（graph/ops/lsp
// 域早已不存在）；CONVENTIONS §4 的体量纪律写了但没人执行（单行 4979 字符）。
//
// 五查（全部静态、秒级）：
//   1. facts   —— 文档里的数字断言与代码真源对拍（真源 = scripts/doc-facts.cjs）
//   2. links   —— 相对链接必须存在
//   3. size    —— 单行 ≤1000 字符；索引表格单元格 ≤500 字符（CONVENTIONS §4）
//   4. orphans —— docs/ 下每份 md 必须被别的文档引用（治「有正文没入口」）
//   5. archive —— plans/ 下挂着竣工/归档横幅的文档应移入 archive/（CONVENTIONS §4）
//   6. budget  —— L0 注入层字节预算（手册必须真的进得去上下文）
//
// 作用域分层（与目标形态一致）：L4 过程层（archive/research/plans 正文）是历史，
// **默认豁免事实对拍**；只看现在时口吻的层（根规则文档 / docs 顶层 / adr / agents /
// design / plugins / composition / cookbook / user / plans 索引）。
//
// 用法（src-ui 下 npm run doc-check / doc-check:report）：
//   node scripts/doc-check.cjs           门禁：非豁免违规即非零退出
//   node scripts/doc-check.cjs --report  漂移清单（含在册豁免，逐批清偿的工作单），exit 0
//   node scripts/doc-check.cjs --json    机器可读
//
// 在册豁免 = scripts/doc-check-exemptions.json（每条必须写 reason + payoff 批次；
// 「先绿再清偿」——豁免是账，不是免罪符）。

const fs = require('node:fs');
const path = require('node:path');
const { collectFacts } = require('./doc-facts.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXEMPTIONS_FILE = path.join(__dirname, 'doc-check-exemptions.json');

// ── 作用域 ────────────────────────────────────────────────────────────────

/** 事实对拍豁免目录（历史层：时态是过去，数字属于当时的真相）。 */
const FACT_EXEMPT_PREFIXES = ['docs/archive/', 'docs/research/'];

/** 计划正文豁免（plans/ 下只有索引页说现在时）。 */
const FACT_EXEMPT_UNLESS = /^docs\/plans\/(README|HISTORY)\.md$/;
const IN_PLANS = /^docs\/plans\//;

/** 索引页（体量纪律对表格单元格更严）。 */
const INDEX_FILES = new Set([
  'docs/README.md',
  'docs/plans/README.md',
  'docs/plans/HISTORY.md',
  'docs/archive/README.md',
  'docs/research/README.md',
]);

/** L0 注入层（每轮必读，字节预算硬上限）。 */
const L0_FILES = ['CLAUDE.md', 'AGENTS.md'];
const L0_TOTAL_BUDGET = 65536;
const L0_PER_FILE_TARGET = 32768;

const LINE_LIMIT = 1000;
const CELL_LIMIT = 500;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', '.workbuddy', '.codely']);

/** 树内 README（各源码目录下的目录契约文件）：**报道不上牙**的作用域。
 *  理由：它们同样会漂（实测先例 = src-ui/src/ui/README.md 自称 16 文件、引用已删模块），
 *  但把它们纳入硬门禁会让「改代码」的 commit 被文档债拦住 ⇒ 先做可见性，不动交付节奏。 */
const ADVISORY_ROOTS = ['src-ui/src', 'src-ui/tests', 'src-tauri/src', 'engine/src', 'hologram-graph/src', 'hologram-storage/src', 'hologram-vector/src', 'examples'];

function listAdvisoryReadmes() {
  const out = [];
  for (const root of ADVISORY_ROOTS) {
    const abs = path.join(ROOT, root);
    if (!fs.existsSync(abs)) continue;
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          walk(path.join(dir, ent.name));
        } else if (ent.isFile() && ent.name === 'README.md') {
          out.push(path.relative(ROOT, path.join(dir, ent.name)).split(path.sep).join('/'));
        }
      }
    };
    walk(abs);
  }
  return out.sort();
}

function listMarkdown() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(path.join(dir, ent.name));
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        out.push(path.relative(ROOT, path.join(dir, ent.name)).split(path.sep).join('/'));
      }
    }
  };
  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (ent.name === 'docs') walk(path.join(ROOT, 'docs'));
      continue;
    }
    if (ent.isFile() && ent.name.endsWith('.md')) out.push(ent.name);
  }
  return out.sort();
}

function inFactScope(rel) {
  if (FACT_EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) return false;
  if (IN_PLANS.test(rel)) return FACT_EXEMPT_UNLESS.test(rel);
  return true;
}

// ── 事实断言表 ────────────────────────────────────────────────────────────
//
// 每条 = 事实 id + 短语模式 + 误报护栏。
//   re            捕获数值的短语模式（宁窄勿宽：模式决定误报率）
//   files         只在这些文件里上牙（缺省 = 全部事实作用域）——用于「同一短语
//                 在别处是叙事、在这里才是现状断言」的事实（契约版本是典型）
//   contextSkip   命中处 ±40 字符窗口内出现即放行（历史语态：v36 起 / 升 v13 / v14-v17）
//   lineSkip      整行出现即放行（该行在讲沿革）
//   hint          违规时给作者的修法提示
//
// 诚实声明：本表**宁漏不误**。假阳性会把门禁变成噪声（没人再看），漏掉的由
// --report 的「未登记候选」兜（报道不上牙，人工归并进本表）。收紧一次 = 加一条
// contextSkip/lineSkip，而不是把整类事实关掉。

const HISTORY_ALLOW =
  /旧记|历史|曾是|曾记|当时|已改|已更正|勘误|归档|被取代|遗留|不再|尚未|计划|下次|将升|待升|（20\d\d-\d\d-\d\d）|20\d\d-\d\d-\d\d 起/;

/** 现在时断言的权威文件（契约版本等在此才以现状口吻出现）。 */
const VERSION_AUTHORITY_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONVENTIONS.md',
  'README.md',
  'ARCHITECTURE.md',
  'docs/README.md',
  'docs/agents/open-surface-contract.md',
];

const CLAIMS = [
  {
    fact: 'agent_config_fields',
    re: /AgentConfig[^\n]{0,12}?冻结\s*\*{0,2}\s*(\d+)\s*字段/g,
    hint: '字段数真源 = src-ui/src/agent/runtime/types.ts（gate.mjs T0 断言同口径）',
  },
  {
    fact: 'builtin_service_plugins',
    // 负向后顾排除节号误报（「2.4 内核工具面」不是「4 内核」）。
    re: /(?<![\d.])(\d+)\s*内核/g,
    hint: '内核插件数真源 = src-ui/src/plugins/loader.ts 的 BUILTIN_PLUGINS 表',
  },
  {
    fact: 'factory_products',
    re: /(\d+)\s*(?:个|件)?\s*出厂(?:产物|插件)/g,
    hint: '出厂产物数真源 = src-ui/src/plugins/builtin-roster.json 条目数',
  },
  {
    fact: 'tool_domains',
    re: /(\d+)\s*个(?:高内聚)?领域工具/g,
    hint: '域数真源 = src-ui/src/agent/tools/domains.ts 的 DOMAIN_SPECS',
  },
  {
    fact: 'open_surface_contract_version',
    // 「契约 vN」在散文里两义（组合层 / 引擎），且大量出现于沿革叙事——
    // 只权威文件上牙 + 上下文护栏（v36 起 / 升 v13 / v14-v17 逐版）。
    re: /契约(?:版本)?[^\n]{0,6}?v(\d+)/g,
    files: VERSION_AUTHORITY_FILES,
    contextSkip: /(?:升|到|至|补|增|登记|逐版|在案|退役|下架|废除|新增)[^\n]{0,12}?v\d+|v\d+\s*(?:起|前|时|内|后|之前|补登记|登记|新增|退役|下架|废除)/,
    lineSkip: /\d{4}-\d{2}-\d{2}/,
    // 「契约 vN」在引擎语境下合法等于引擎契约版本（docs/README 索引页一行里两义）。
    acceptFacts: ['engine_contract_version'],
    acceptWhen: /引擎|engine|壳专属|hidden tools/i,
    hint: '开放面契约版本真源 = src-ui/src/composition/contract-version.ts',
  },
  {
    fact: 'engine_contract_version',
    re: /引擎[^\n]{0,10}契约[^\n]{0,8}?v(\d+)/g,
    hint: '引擎契约版本真源 = engine/src/contract.rs 的 ENGINE_CONTRACT_VERSION',
  },
  {
    fact: 'engine_shell_methods',
    re: /(\d+)\s*(?:个)?壳(?:专属)?方法/g,
    hint: '壳方法数真源 = engine/src/contract.rs 的 SHELL_METHODS',
  },
  {
    fact: 'engine_default_tools',
    re: /MCP 工具面[^\n]{0,16}?(\d+)\s*schema/g,
    hint: '引擎默认工具数真源 = engine/src/tools/mod.rs 的 DEFAULT_MCP_TOOLS',
  },
];

// 未登记候选扫描（报道不上牙）：像「事实断言」但不在上面的短语表里的行。
const CANDIDATE_RE =
  /(\d+)\s*(?:个|条|份|段|族|域|字段|方法|内核|产物|用例|文件|语言|provider|adapter|工具|插件|面板)/g;

// ── 检查实现 ──────────────────────────────────────────────────────────────

/** 扫描期消失的文件（并发 git mv / 另一个窗口在写）——不静默：报告里点名。 */
const vanished = new Set();

function readText(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 文件列表在扫描开始时取好，扫描中途被并发移动/删除是正常竞态（本仓有多窗口并行纪律）。
      vanished.add(rel);
      return '';
    }
    throw e;
  }
}

function checkFacts(files, facts) {
  const violations = [];
  const skipped = [];
  for (const rel of files) {
    if (!inFactScope(rel)) continue;
    if (isGeneratedDoc(rel)) continue; // 生成物的真值由 doc-sync 逐字节对拍负责
    const lines = readText(rel).split('\n');
    for (const claim of CLAIMS) {
      if (claim.files && !claim.files.includes(rel)) continue;
      const expected = facts.get(claim.fact).value;
      lines.forEach((line, idx) => {
        const re = new RegExp(claim.re.source, claim.re.flags);
        for (const m of line.matchAll(re)) {
          const found = Number(m[1]);
          if (found === expected) continue;
          const head = `\`${claim.fact}\` 期望 ${expected}，文档写 ${found}`;
          if (HISTORY_ALLOW.test(line)) {
            skipped.push({ file: rel, line: idx + 1, message: `${head}（历史语态行，放行）` });
            continue;
          }
          const window = line.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
          if (claim.lineSkip?.test(line) || claim.contextSkip?.test(window)) {
            skipped.push({ file: rel, line: idx + 1, message: `${head}（沿革叙事，放行）` });
            continue;
          }
          const accepted = (claim.acceptFacts ?? []).some(
            (id) => found === facts.get(id).value && claim.acceptWhen?.test(line),
          );
          if (accepted) {
            skipped.push({ file: rel, line: idx + 1, message: `${head}（行内引擎语汇，按同值事实放行）` });
            continue;
          }
          violations.push({
            check: 'facts',
            file: rel,
            line: idx + 1,
            text: line.trim().slice(0, 160),
            message: `${head}——${claim.hint}`,
          });
        }
      });
    }
  }
  return { violations, skipped };
}

function scanCandidates(files) {
  const covered = new Set(CLAIMS.map((c) => c.fact));
  const out = [];
  for (const rel of files) {
    if (!inFactScope(rel)) continue;
    if (rel === 'CODELY.md') continue; // 第三方工具私有记忆（见豁免账 size-codely）——不参与候选归并
    if (isGeneratedDoc(rel)) continue; // 生成物的数字由 doc-sync 逐字节对拍负责
    const lines = readText(rel).split('\n');
    lines.forEach((line, idx) => {
      if (line.length < 40) return;
      if (HISTORY_ALLOW.test(line)) return;
      if (!CANDIDATE_RE.test(line)) return;
      // 已被某条 claim 覆盖的行不再重复报道。
      if (CLAIMS.some((c) => new RegExp(c.re.source, c.re.flags).test(line))) return;
      out.push({ file: rel, line: idx + 1, text: line.trim().slice(0, 140) });
    });
  }
  const byFile = new Map();
  for (const c of out) byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1);
  return {
    total: out.length,
    byFile: [...byFile.entries()].sort((a, b) => b[1] - a[1]),
    sample: out.slice(0, 20),
    covered: [...covered],
  };
}

/** 生成物文档（头部自述「生成物」）：体量与行宽由生成器负责，doc-sync 对拍。 */
function isGeneratedDoc(rel) {
  const head = readText(rel).split('\n').slice(0, 8).join('\n');
  return /生成物/.test(head);
}

const LINKABLE = /\.(md|markdown|json|jsonc|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|rs|py|sh|ps1|cmd|html?|css|scss|svg|png|jpe?g|gif|webp|txt|csv|db|exe|patch|diff)(#.*)?$/i;

function checkLinks(files) {
  const violations = [];
  for (const rel of files) {
    const dir = path.dirname(path.join(ROOT, rel));
    const lines = readText(rel).split('\n');
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
        if (!LINKABLE.test(target)) continue; // 只查像文件路径的目标（`url` / `http/https` 之类占位不是断链）
        const p = target.split('#')[0];
        if (!p) continue;
        if (!fs.existsSync(path.resolve(dir, decodeURIComponent(p)))) {
          violations.push({
            check: 'links',
            file: rel,
            line: idx + 1,
            text: target,
            message: `相对链接目标不存在：${target}`,
          });
        }
      }
    });
  }
  return { violations, skipped: [] };
}

function checkSize(files) {
  const violations = [];
  for (const rel of files) {
    if (isGeneratedDoc(rel)) continue;
    // 冻结层（坟场 + 证据）不重排：改历史文档的排版没有产出，只有 diff 噪声。
    if (rel.startsWith('docs/archive/') || rel.startsWith('docs/research/')) continue;
    const lines = readText(rel).split('\n');
    lines.forEach((line, idx) => {
      if (line.length > LINE_LIMIT && !line.trimStart().startsWith('|')) {
        // 表格是结构化数据（markdown 表格单元格不可换行）：行宽规则只管散文行，
        // 单元格宽度规则只对索引页上牙（INDEX_FILES）——两者分工明确，避免把
        // 版本变更记录表之类的合法宽表判成「排版事故」。
        violations.push({
          check: 'size',
          file: rel,
          line: idx + 1,
          text: line.slice(0, 120) + '…',
          message: `单行 ${line.length} 字符 > ${LINE_LIMIT}（CONVENTIONS §4：那是排版事故，不是详尽）`,
        });
      }
      if (INDEX_FILES.has(rel) && line.trimStart().startsWith('|')) {
        for (const cell of line.split('|')) {
          if (cell.length > CELL_LIMIT) {
            violations.push({
              check: 'size',
              file: rel,
              line: idx + 1,
              text: cell.trim().slice(0, 120) + '…',
              message: `索引单元格 ${cell.length} 字符 > ${CELL_LIMIT}（索引不是散文）`,
            });
            break;
          }
        }
      }
    });
  }
  return { violations, skipped: [] };
}

/**
 * 收集「谁引用了谁」——**把相对链接解析成仓库相对路径**再比（早期版本直接字符串
 * 匹配「docs/x/y.md」，于是 docs/README 里写 `research/README.md` 这种相对链接
 * 一律算没引用，误报成孤儿）。两种引用形态都算：
 *   ① markdown 链接 `](target)`（相对本文件解析）
 *   ② 反引号里的仓库相对路径 `` `docs/...` ``（本仓库既有的引用习惯）
 */
function collectReferences(files) {
  const refs = new Map();
  const add = (target, referrer) => {
    if (!refs.has(target)) refs.set(target, new Set());
    refs.get(target).add(referrer);
  };
  for (const rel of files) {
    const dir = path.posix.dirname(rel);
    const text = readText(rel);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const t = m[1];
      if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(t)) continue;
      const p = t.split('#')[0];
      if (!p || !p.endsWith('.md')) continue;
      add(path.posix.normalize(path.posix.join(dir, decodeURIComponent(p))), rel);
    }
    for (const m of text.matchAll(/`([^`\n]+\.md)`/g)) {
      const t = m[1].trim();
      if (!t.startsWith('docs/')) continue; // 仓库相对书写习惯：只认 docs/ 开头（避免歧义）
      add(path.posix.normalize(t), rel);
    }
  }
  return refs;
}

function checkOrphans(files) {
  // archive/ 是既定坟场（按目录可达 + archive/README 交代），不要求逐份被链接。
  const docs = files.filter((f) => f.startsWith('docs/') && !f.startsWith('docs/archive/'));
  const refs = collectReferences(files);
  const violations = [];
  for (const rel of docs) {
    const referrers = [...(refs.get(rel) ?? [])].filter((r) => r !== rel);
    if (referrers.length === 0) {
      violations.push({
        check: 'orphans',
        file: rel,
        line: 0,
        text: '',
        message: '没有任何文档引用它（有正文没入口）——挂到某个索引页或删除',
      });
    }
  }
  return { violations, skipped: [] };
}

function checkArchive(files) {
  // 规则：`plans/` 下的正文若自称 DONE（竣工/归档/作废/被取代）**且没有 ACTIVE 标记** ⇒ 红
  // （该 `git mv` 到 `docs/archive/`）。
  //
  // 语义裁定（2026-09-16，本轮实测后定死——这套语义是本仓先例）：
  //   **「竣工即归档」的判据是「过程文档是否还活着」，不是「验收跑没跑完」。**
  //   施工单/交接稿/评审/计划 = 过程文档 ⇒ 代码竣工就归档；**真机验收欠账由 `plans/README.md`
  //   的欠账表承载**（先例：`docs/archive/session-ledger-plan.md` 的欠账行早就指进 archive）。
  //   所以「待实机 / 验收 / 欠账」**不算**在办标记；只有「真的还在干活或还没定」才算：
  //   进行中 / 在办 / 在产（在产设计件）/ 待拍板（决策未定）/ 未执行 / Draft。
  //
  // 两处补强（2026-09-16 P3b 的 11 件就是被原规则漏掉的）：
  //   ① 观察窗 15 → 30 行；② 除横幅字面量外认「状态：… 竣工」句式。
  // **实测 recall 上限**：对那 11 件的归档前版本回放，新规则直接命中 3/11——其余 8 件头部同时
  // 含「验收/欠账/待」等词（按上面语义这些词不构成在办）。**这是散文分类的固有极限**：
  // 本查是「兜底网」，不是「完备判定」；完备判定要等给每个计划加机器可读状态行（见施工单 §4.6）。
  const DONE = /已归档|被取代|历史留存|本计划已|已竣工|已作废|全段竣工|全计划竣工|状态[：:][^\n]{0,60}竣工/;
  const ACTIVE = /进行中|在办|在产|拍板|待定|尚未开工|未执行|未开工|Draft|草稿|Proposed/;
  const violations = [];
  for (const rel of files) {
    if (!/^docs\/plans\//.test(rel)) continue;
    if (FACT_EXEMPT_UNLESS.test(rel)) continue;
    const head = readText(rel).split('\n').slice(0, 30).join('\n');
    const m = head.match(DONE);
    if (!m) continue;
    if (ACTIVE.test(head)) continue; // 有活跃标记 ⇒ 状态自洽，留在 plans/
    violations.push({
      check: 'archive',
      file: rel,
      line: 0,
      text: m[0],
      message: `自称「${m[0]}」且无活跃标记（前 30 行无「在办/在产/进行中/待拍板/未执行/Draft」）——CONVENTIONS §4「竣工即归档」：git mv 到 docs/archive/，或补一行显式状态（在办 / 在产设计件）`,
    });
  }
  return { violations, skipped: [] };
}

function checkBudget() {
  const violations = [];
  let total = 0;
  const sizes = [];
  for (const rel of L0_FILES) {
    const p = path.join(ROOT, rel);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    sizes.push(`${rel} ${size} B`);
    total += size;
    if (rel === 'CLAUDE.md' && size > L0_PER_FILE_TARGET) {
      violations.push({
        check: 'budget',
        file: rel,
        line: 0,
        text: `${size} B`,
        message: `L0 权威注入文件 ${size} B > 目标 ${L0_PER_FILE_TARGET} B——长表格外移，只留硬约束 + 指针`,
      });
    }
  }
  if (total > L0_TOTAL_BUDGET) {
    violations.push({
      check: 'budget',
      file: L0_FILES.join(' + '),
      line: 0,
      text: `${total} B`,
      message: `L0 合计 ${total} B > 指令预算 ${L0_TOTAL_BUDGET} B（本轮实测：AGENTS.md 已被 harness 丢弃 = 手册根本没进上下文）`,
    });
  }
  return { violations, skipped: [], note: sizes.join(' · ') };
}

// ── 豁免账 ────────────────────────────────────────────────────────────────

function loadExemptions() {
  try {
    return JSON.parse(fs.readFileSync(EXEMPTIONS_FILE, 'utf8'));
  } catch {
    return { note: '（无豁免账）', entries: [] };
  }
}

function globToRe(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
}

function matchExemption(v, entries) {
  return entries.find((e) => {
    if (e.check !== v.check) return false;
    if (e.file && !globToRe(e.file).test(v.file)) return false;
    if (e.line && e.line !== v.line) return false;
    if (e.contains && !(`${v.message} ${v.text}`).includes(e.contains)) return false;
    return true;
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const report = args.includes('--report');
  const asJson = args.includes('--json');

  const files = listMarkdown();
  const facts = collectFacts();
  // 树内 README：同一套查，但**只报道不上牙**（见 ADVISORY_ROOTS 注释）。
  const advisoryFiles = listAdvisoryReadmes();
  const advisory = [
    ...checkFacts(advisoryFiles, facts).violations,
    ...checkLinks(advisoryFiles).violations,
    ...checkSize(advisoryFiles).violations,
  ];
  const results = [
    checkBudget(),
    checkFacts(files, facts),
    checkLinks(files),
    checkSize(files),
    checkOrphans(files),
    checkArchive(files),
  ];

  const all = results.flatMap((r) => r.violations);
  const skipped = results.flatMap((r) => r.skipped);
  const exemptions = loadExemptions();
  const open = [];
  const waived = [];
  for (const v of all) {
    const e = matchExemption(v, exemptions.entries);
    if (e) waived.push({ ...v, payoff: e.payoff, reason: e.reason });
    else open.push(v);
  }
  const candidates = scanCandidates(files);

  const byPayoff = {};
  for (const w of waived) byPayoff[w.payoff ?? '(未标批次)'] = (byPayoff[w.payoff ?? '(未标批次)'] ?? 0) + 1;

  // 账目卫生：豁免条目若已不再命中任何违规 = 债务已清偿（或规则收紧后失效），条目该删。
  const usedIds = new Set();
  for (const v of all) {
    const e = matchExemption(v, exemptions.entries);
    if (e?.id) usedIds.add(e.id);
  }
  const unused = exemptions.entries.filter((e) => !usedIds.has(e.id));

  if (asJson) {
    console.log(JSON.stringify({ open, waived, skipped, byPayoff, candidates: { total: candidates.total } }, null, 2));
    return open.length === 0 ? 0 : 1;
  }

  const group = (list) => {
    const g = new Map();
    for (const v of list) {
      if (!g.has(v.check)) g.set(v.check, []);
      g.get(v.check).push(v);
    }
    return g;
  };

  console.log(`[doc-check] 扫描 ${files.length} 份文档 · 事实 ${facts.size} 条 · 豁免账 ${exemptions.entries.length} 条`);
  if (vanished.size > 0) {
    console.log(`[doc-check] ⚠ 扫描期消失 ${vanished.size} 份（并发移动/删除；本轮不计入结果）：${[...vanished].slice(0, 5).join(' · ')}${vanished.size > 5 ? ' …' : ''}`);
  }
  if (report) {
    console.log('\n── 全部问题（含在册豁免；这是逐批清偿的工作单）──');
    for (const [check, list] of group([...all])) {
      console.log(`\n## ${check}（${list.length}）`);
      for (const v of list) {
        const e = matchExemption(v, exemptions.entries);
        const tag = e ? `[豁免 ${e.payoff ?? '?'}]` : '[未豁免]';
        const loc = v.line ? `${v.file}:${v.line}` : v.file;
        console.log(`  ${tag} ${loc} — ${v.message}`);
      }
    }
    console.log(`\n── 树内 README 顾问查（${advisoryFiles.length} 份，只报道不上牙）──`);
    if (advisory.length === 0) {
      console.log('  无问题');
    } else {
      for (const v of advisory) console.log(`  ${v.line ? `${v.file}:${v.line}` : v.file} — ${v.message}`);
    }
    console.log('\n── 未登记候选（报道用，不上牙；按文件降序 + 样例）──');
    console.log(`  命中 ${candidates.total} 行；按文件：`);
    for (const [f, n] of candidates.byFile.slice(0, 12)) console.log(`    ${String(n).padStart(3)}  ${f}`);
    console.log('  样例：');
    for (const c of candidates.sample) console.log(`  ${c.file}:${c.line} — ${c.text}`);
    console.log(`\n── 历史语态放行 ${skipped.length} 条（时态豁免，不计违规）──`);
    for (const s of skipped.slice(0, 10)) console.log(`  ${s.file}:${s.line} — ${s.message}`);
    if (unused.length > 0) {
      console.log(`\n── 账目卫生：${unused.length} 条豁免已不再命中（债务已清偿或规则收紧后失效）——该删 ──`);
      for (const e of unused) console.log(`  [${e.payoff ?? '?'}] ${e.id}（${e.check}）`);
    }
    return 0;
  }

  if (open.length === 0) {
    const summary = Object.entries(byPayoff)
      .map(([k, n]) => `${k} ${n} 项`)
      .join(' · ');
    const advise = advisory.length > 0 ? `；树内 README 顾问查 ${advisory.length} 项（--report 看，不拦）` : '';
    console.log(`[ok] doc-check：无未豁免违规${summary ? `（在册豁免：${summary}）` : ''}${advise}`);
    return 0;
  }

  console.log(`\n✗ doc-check：${open.length} 项未豁免违规`);
  for (const [check, list] of group(open)) {
    console.log(`\n## ${check}（${list.length}）`);
    for (const v of list) console.log(`  ${v.line ? `${v.file}:${v.line}` : v.file} — ${v.message}`);
  }
  console.log('\n提示：本轮先绿靠 scripts/doc-check-exemptions.json 记账（每条须写 reason + payoff）；--report 看全量漂移清单。');
  return 1;
}

process.exit(main());
