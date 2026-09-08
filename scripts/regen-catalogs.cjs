// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 从社区模型数据源 + scripts/catalog-overrides.json（人工核实表）再生成
// src-ui/src/provider/catalog/*.json 的「缺失模型」。
//
// 用法：
//   node scripts/regen-catalogs.cjs [--vendors glm,deepseek] [--source <url|本地快照路径>] [--dry]
//
// 合并契约（本脚本存在的意义就是这三条，改动即 breaking）：
//   1. 已有条目一个字节都不改。数据源与目录冲突只打印 [review]/[override-conflict]，
//      由人工裁决后改文件或改表——静默替换是 provider-system-spec P14 要杀的东西。
//   2. 只新增 catalog-overrides.json 里声明过的模型；sources 只提供机械字段
//      （contextWindow/maxTokens），缺了就按覆盖表填，再缺就跳过并打印原因。
//   3. input 一律取 vendors.<v>.input。⚡ 2026-09-09（multimodal-image B5）起
//      image 声明合法——真实传图入口已落地（Message.images 旁挂引用 + 三适配器
//      wire），spec 裁决 #3 的「无传图入口」前提已失效；正/负清单由
//      tests/provider-catalog.test.ts 精确钉死（已知 vision 款 = anthropic/openai
//      全线 + deepseek vision-exp；新增 vision 声明须同步改该测试——显式表纪律）。
//      ⚡ 2026-09-06 价格表拆除：cost 字段不再写入目录（LiteLLM 价格数据只用于
//      对拍 contextWindow/maxTokens；价一律不进目录 JSON）。
//
// 数据源：LiteLLM 社区价格表（raw.githubusercontent.com）。models.dev 国内不通、
// GitHub raw 时好时坏——网络失败时把快照存本地用 --source 重跑，启动路径零依赖
// （裁决 #15：目录必须是自足的开箱层）。max_input_tokens 才是上下文窗口；
// 该表的 max_tokens 多数厂商语义是"总窗口"，禁止采信。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_DIR = path.join(ROOT, 'src-ui', 'src', 'provider', 'catalog');
const OVERRIDES_FILE = path.join(__dirname, 'catalog-overrides.json');

const DEFAULT_SOURCES = [
  // 依序尝试；国内网络 GitHub raw 时通时断，jsDelivr gh 镜像实测更稳（2026-08-27）。
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
];

/** 各 vendor 在数据源里的键前缀。键形如 "zhipu/glm-5.2"、"deepseek/deepseek-v4-pro"。 */
const SOURCE_PREFIXES = {
  glm: [/^zhipu\//i],
};

/** 思考档位词表镜像自 src-ui/src/provider/thinking.ts 的 ThinkingEffort（词表漂移由守护测试拦截）。 */
const THINKING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const onlyVendors = argValue('--vendors')?.split(',').map((s) => s.trim()).filter(Boolean);
const dry = args.includes('--dry');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function loadSource(urlOrPath) {
  if (!/^https?:\/\//i.test(urlOrPath)) return JSON.parse(fs.readFileSync(urlOrPath, 'utf8'));
  const res = await fetch(urlOrPath, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`数据源 HTTP ${res.status}：${urlOrPath}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    // 原样落盘便于离线复跑：--source <这个文件>
    const snap = path.join(__dirname, 'catalog-source.snapshot.json');
    fs.writeFileSync(snap, text);
    throw new Error(`数据源返回非 JSON（已存 ${snap}，可用 --source ${snap} 复跑）：${e.message}`);
  }
}

/** 默认源依序试；全部失败报错并提示离线路径（网络问题不静默吞）。 */
async function loadDefaultSource() {
  const failures = [];
  for (const url of DEFAULT_SOURCES) {
    try {
      return await loadSource(url);
    } catch (e) {
      failures.push(`${url} → ${e.message.split('：')[0]}`);
    }
  }
  throw new Error(`全部默认源不可用\n  ${failures.join('\n  ')}\n  离线复跑：本地存快照后 node scripts/regen-catalogs.cjs --source <快照路径>`);
}

/** 机械映射：一条 LiteLLM 条目 → 目录字段的「候选值」。拿不到的键为 undefined。
 *  ⚡ 2026-09-06 价格表拆除：不再取 cost——价格不进目录 JSON。 */
function mapSourceEntry(raw) {
  const ctxWindow =
    typeof raw.max_input_tokens === 'number' && raw.max_input_tokens > 0 ? raw.max_input_tokens : undefined;
  const maxOut =
    typeof raw.max_output_tokens === 'number' && raw.max_output_tokens > 0 ? raw.max_output_tokens : undefined;
  const reasoning = typeof raw.supports_reasoning === 'boolean' ? raw.supports_reasoning : undefined;
  return { contextWindow: ctxWindow, maxTokens: maxOut, reasoning };
}

/** 家法排版：短数组单行内联（对齐 anthropic.json 等）。 */
function serializeEntry(id, e) {
  const inlineArray = (arr) => `[${arr.map((v) => JSON.stringify(v)).join(', ')}]`;
  const f = [];
  f.push(`    "id": ${JSON.stringify(e.id)},`);
  f.push(`    "name": ${JSON.stringify(e.name)},`);
  f.push(`    "kind": ${JSON.stringify(e.kind)},`);
  f.push(`    "vendor": ${JSON.stringify(e.vendor)},`);
  f.push(`    "baseUrl": ${JSON.stringify(e.baseUrl)},`);
  f.push(`    "reasoning": ${e.reasoning},`);
  f.push(`    "input": ${inlineArray(e.input)},`);
  f.push(`    "contextWindow": ${e.contextWindow},`);
  f.push(`    "maxTokens": ${e.maxTokens}`);
  if (e.thinkingEfforts !== undefined) {
    f[f.length - 1] += ',';
    f.push(`    "thinkingEfforts": ${inlineArray(e.thinkingEfforts)}`);
  }
  if (e.thinkingOff !== undefined) {
    f[f.length - 1] += ',';
    f.push(`    "thinkingOff": ${e.thinkingOff}`);
  }
  return `  ${JSON.stringify(id)}: {\n${f.join('\n')}\n  }`;
}

/**
 * 文本级追加：在文件最后一个收口大括号前插入新条目，其余字节原封不动。
 * 整体重序列化会重排存量排版（实测把 ["text"] 单行拆成多行），违反契约 #1。
 */
function appendEntriesTextually(file, additions) {
  const raw = fs.readFileSync(path.join(CATALOG_DIR, file), 'utf8');
  const lastBrace = raw.lastIndexOf('}');
  const head = raw.slice(0, lastBrace).replace(/\s+$/, '');
  const isFirstEntry = head.endsWith('{');
  const block = additions
    .map(([id, e], i) => {
      const sep = isFirstEntry && i === 0 ? '' : ',';
      return `${sep}\n${serializeEntry(id, e)}`;
    })
    .join('');
  return `${head}${block}\n}\n`;
}

async function main() {
  const overridesAll = readJson(OVERRIDES_FILE);
  const vendorFilter = new Set(onlyVendors ?? Object.keys(SOURCE_PREFIXES));
  const wantedVendors = Object.keys(SOURCE_PREFIXES).filter((v) => vendorFilter.has(v));

  // 源解析：--source 显式指定 > 默认源链依序尝试 > 本地快照兜底（大声警告过期风险）。
  const snap = path.join(__dirname, 'catalog-source.snapshot.json');
  let db;
  const explicit = argValue('--source');
  if (explicit !== undefined) {
    try {
      db = await loadSource(explicit);
    } catch (e) {
      console.error(`[fatal] --source 数据源不可用：${e.message}`);
      process.exit(1);
    }
  } else {
    try {
      db = await loadDefaultSource();
    } catch (chainError) {
      if (fs.existsSync(snap) && fs.statSync(snap).size > 0) {
        console.warn(`[warn] 默认源链全败，回落本地快照 ${snap}（可能过期，建议核对后用）`);
        db = readJson(snap);
      } else {
        console.error(`[fatal] 数据源不可用：${chainError.message}`);
        process.exit(1);
      }
    }
  }

  // 人工核实表先于一切校验：thinkingEfforts 档位白名单（image 声明自 B5 起合法，
  // 无需拦截——正/负清单由 tests/provider-catalog.test.ts 精确钉死）。
  for (const [vendor, cfg] of Object.entries(overridesAll.vendors)) {
    for (const [id, m] of Object.entries(cfg.models ?? {})) {
      if ('thinkingEfforts' in m) {
        const bad = m.thinkingEfforts.filter((x) => !THINKING_EFFORTS.includes(x));
        if (bad.length > 0) {
          console.error(`[fatal] 覆盖表 ${vendor}/${id} thinkingEfforts 含非法档位：${bad.join(', ')}`);
          process.exit(1);
        }
      }
    }
  }

  const report = [];
  for (const vendor of wantedVendors) {
    const ovCfg = overridesAll.vendors[vendor];
    if (!ovCfg) continue;

    // 数据源里属于该 vendor 的条目按前缀收拢，replace 剥前缀得裸 id。
    const byId = new Map();
    for (const prefix of SOURCE_PREFIXES[vendor]) {
      for (const [key, raw] of Object.entries(db)) {
        if (!prefix.test(key)) continue;
        byId.set(key.replace(prefix, ''), raw);
      }
    }

    // ① 已有条目：只对拍，不落笔。
    const catalogFiles = fs.readdirSync(CATALOG_DIR).filter((f) => f.endsWith('.json'));
    let targetFile;
    let catalog;
    for (const f of catalogFiles) {
      const data = readJson(path.join(CATALOG_DIR, f));
      const sample = Object.values(data)[0];
      if (sample?.vendor === vendor) {
        targetFile = f;
        catalog = data;
        break;
      }
    }
    if (!targetFile) {
      report.push(`[skip] ${vendor}：catalog/ 下无归属文件，跳过（新增 vendor 请先手工建文件）`);
      continue;
    }

    for (const [id, ovr] of Object.entries(ovCfg.models ?? {})) {
      if (!(id in catalog)) continue;
      for (const field of ['contextWindow', 'maxTokens']) {
        const mine = catalog[id][field];
        const theirs = ovr[field];
        const theirsSrc = theirs !== undefined ? `${theirs}(覆盖表)` : undefined;
        const srcRaw = byId.get(id)?.[field === 'contextWindow' ? 'max_input_tokens' : 'max_output_tokens'];
        const candidates = [theirsSrc, srcRaw !== undefined ? `${srcRaw}(LiteLLM)` : undefined].filter(Boolean);
        const differs = candidates.filter((c) => Number.parseInt(c, 10) !== mine);
        if (differs.length > 0) {
          report.push(`[review] ${targetFile} ${id}.${field}: 现值 ${mine} ≠ ${differs.join(' / ')} —— 未改，人工裁决`);
        }
      }
    }

    // ② 新增条目：必须出自覆盖表（人工背书），字段 = 覆盖表 > 数据源 > 跳过。
    // 同时记录为文本级追加块——已有条目的字节一个都不许动（契约 #1）。
    const additions = [];
    for (const [id, ovr] of Object.entries(ovCfg.models ?? {})) {
      if (id in catalog) continue;
      const src = mapSourceEntry(byId.get(id) ?? {});
      const contextWindow = ovr.contextWindow ?? src.contextWindow;
      const maxTokens = ovr.maxTokens ?? src.maxTokens;
      const reasoning = ovr.reasoning ?? src.reasoning;
      const missing = [];
      if (!(contextWindow > 0)) missing.push('contextWindow');
      if (!(maxTokens > 0)) missing.push('maxTokens');
      if (typeof reasoning !== 'boolean') missing.push('reasoning');
      if (missing.length > 0) {
        report.push(`[skipped] ${vendor}/${id}：${missing.join('/')} 无来源（补覆盖表或换数据源后再跑）`);
        continue;
      }
      const entry = {
        id,
        name: ovr.name,
        kind: ovCfg.kind,
        vendor,
        baseUrl: ovCfg.baseUrl,
        reasoning,
        input: [...ovCfg.input],
        contextWindow,
        maxTokens,
        ...(ovr.thinkingEfforts === undefined ? {} : { thinkingEfforts: [...ovr.thinkingEfforts] }),
        ...(ovr.thinkingOff === undefined ? {} : { thinkingOff: ovr.thinkingOff }),
      };
      additions.push([id, entry]);
      catalog[id] = entry;
      report.push(`[added] ${targetFile} + ${id}（ctx=${contextWindow}, out=${maxTokens}）`);
    }

    if (!dry && additions.length > 0) {
      fs.writeFileSync(path.join(CATALOG_DIR, targetFile), appendEntriesTextually(targetFile, additions));
    }
  }

  for (const line of report) console.log(line);
  const added = report.filter((l) => l.startsWith('[added]')).length;
  console.log(`\n完成：新增 ${added} 条${dry ? '（--dry 未写盘）' : ''}。请 git diff 复核后提交——这一眼 diff 就是人审的全部成本。`);
}

main().catch((e) => {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
});
