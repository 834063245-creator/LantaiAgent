// 版本号提升器 —— 单一落点表：一次改齐全部「锁步版本号」出现的地方。
//
// 用法：
//   node scripts/bump-version.mjs 1.0.1        # 显式指定目标版本
//   node scripts/bump-version.mjs patch        # patch | minor | major 递增
//   node scripts/bump-version.mjs 1.0.1 --dry-run
//
// 为什么要有这个脚本（2026-09-22 立）：旧 `bump-version.ps1` 只覆盖 2 个文件
// （tauri.conf.json + src-tauri/Cargo.toml），而真实落点有 11 个（五个 crate + 三份 lock
// + tauri.conf + dsh-bundle 两份）；它还用 `ConvertTo-Json` 整份重排 tauri.conf.json——
// 正是 CONVENTIONS §3 记录过的那类编码事故的形态。改名/加 crate 后无人改它，于是「版本号
// 只改了一半」是必然结局。本脚本取代它：落点表显式、逐条校验命中数、未命中即报错退出。
//
// 纪律：
//   · 文本一律 utf8 往返（不用 PowerShell 改文本，CONVENTIONS §3）。
//   · Cargo.lock 按**包名**定位（不是按版本字符串）——否则从 1.0.0 往上抬时会命中
//     满坑满谷的同版本第三方依赖；`[package]` 段同理，只认本包自己那条 version。
//   · 不做 git commit（由使用者决定怎么提交）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (rel) => join(ROOT, rel);

/** 工作区成员（根 Cargo.toml members）+ 壳。Cargo.lock 里只改这些包的 version。 */
const OUR_CRATES = ['hologram-engine', 'hologram-graph', 'hologram-storage', 'hologram-vector', 'lantai'];

/** 每 crate 一份 Cargo.toml（改 [package] 段里那条 version）。 */
const CARGO_TOMLS = [
  'engine/Cargo.toml',
  'hologram-graph/Cargo.toml',
  'hologram-storage/Cargo.toml',
  'hologram-vector/Cargo.toml',
  'src-tauri/Cargo.toml',
];

/**
 * 只有仓库根这一份 lock（真源）。`engine/Cargo.lock` 与 `src-tauri/Cargo.lock` 曾在表里
 * ——它们是工作区之前留下的化石，2026-09-22 已删（实测：把 engine/Cargo.lock 写成 garbage，
 * `cargo metadata --locked` 照样 exit 0 ⇒ cargo 根本不读它们）。删掉之后本表少维护两项，
 * 也不会再出现「三个 lock 三个版本号」的 grep 噪声。新增 crate 只改 Cargo.toml 段，
 * lock 由本脚本按包名改 + 收尾 `cargo metadata --locked` 校验。
 */
const CARGO_LOCKS = ['Cargo.lock'];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const spec = argv.find((a) => !a.startsWith('--'));

if (!spec) {
  console.error('用法：node scripts/bump-version.mjs <x.y.z|patch|minor|major> [--dry-run]');
  process.exit(2);
}

// ── 当前版本 = tauri.conf.json 的顶层 version（唯一权威读数）────────────────
const confPath = 'src-tauri/tauri.conf.json';
const confRaw = readFileSync(p(confPath), 'utf8');
const curMatch = confRaw.match(/^ {2}"version": "([^"]+)",$/m);
if (!curMatch) {
  console.error(`✗ ${confPath}: 找不到顶层 "version" 行——落点表的前提不成立，停手`);
  process.exit(1);
}
const from = curMatch[1];

const [maj, min, pat] = from.split('.').map(Number);
const to = /^\d+\.\d+\.\d+$/.test(spec)
  ? spec
  : spec === 'major'
    ? `${maj + 1}.0.0`
    : spec === 'minor'
      ? `${maj}.${min + 1}.0`
      : spec === 'patch'
        ? `${maj}.${min}.${pat + 1}`
        : null;
if (!to) {
  console.error(`✗ 无法解析目标版本 "${spec}"（要 x.y.z 或 patch|minor|major）`);
  process.exit(2);
}
if (to === from) {
  console.log(`· 目标版本与当前一致（${from}），无操作`);
  process.exit(0);
}
console.log(`${dryRun ? '[dry-run] ' : ''}${from} → ${to}\n`);

let changed = 0;
const write = (rel, text) => {
  if (!dryRun) writeFileSync(p(rel), text, 'utf8');
  changed++;
};
const mustExist = (rel) => {
  if (!existsSync(p(rel))) {
    console.error(`✗ ${rel}: 落点表里列了它，但文件不在——落点表过时了，先修脚本`);
    process.exit(1);
  }
};

// ── Cargo.toml：只改 [package] 段里那条 version ───────────────────────────
for (const rel of CARGO_TOMLS) {
  mustExist(rel);
  const text = readFileSync(p(rel), 'utf8');
  const pkgAt = text.indexOf('[package]');
  if (pkgAt < 0) {
    console.error(`✗ ${rel}: 没有 [package] 段`);
    process.exit(1);
  }
  const head = text.slice(0, pkgAt);
  const tail = text.slice(pkgAt);
  const m = tail.match(/^version = "([^"]+)"$/m);
  if (!m || m[1] !== from) {
    console.error(`✗ ${rel}: [package] version = ${m ? m[1] : '(缺失)'}，期望 ${from}`);
    process.exit(1);
  }
  write(rel, head + tail.replace(/^version = "[^"]+"$/m, `version = "${to}"`));
  console.log(`✓ ${rel}`);
}

// ── Cargo.lock：按包名定位，命中即改（不受第三方同版本号干扰）──────────────
for (const rel of CARGO_LOCKS) {
  mustExist(rel);
  const blocks = readFileSync(p(rel), 'utf8').split(/(?=\[\[package\]\])/);
  const hits = [];
  const out = blocks.map((b) => {
    const name = b.match(/^name = "([^"]+)"$/m)?.[1];
    if (!name || !OUR_CRATES.includes(name)) return b;
    const v = b.match(/^version = "([^"]+)"$/m);
    if (!v) return b;
    if (v[1] !== from) {
      console.error(`✗ ${rel}: 包 ${name} 是 ${v[1]}，期望 ${from}——三份 lock 已不同步，先对齐`);
      process.exit(1);
    }
    hits.push(name);
    return b.replace(/^version = "[^"]+"$/m, `version = "${to}"`);
  });
  if (hits.length === 0) {
    console.error(`✗ ${rel}: 一个本仓 crate 都没命中——落点表/包名过时了`);
    process.exit(1);
  }
  write(rel, out.join(''));
  console.log(`✓ ${rel}（${hits.length} 个包：${hits.join(', ')}）`);
}

// ── JSON：tauri.conf.json / dsh-bundle 的 package.json（顶层 version 行）──
for (const rel of [confPath, 'dsh-bundle/package.json']) {
  mustExist(rel);
  const text = readFileSync(p(rel), 'utf8');
  const re = new RegExp(`^ {2}"version": "${from.replace(/\./g, '\\.')}",$`, 'm');
  const hits = text.match(new RegExp(re.source, 'gm'))?.length ?? 0;
  if (hits !== 1) {
    console.error(`✗ ${rel}: 顶层 version 行命中 ${hits} 处，期望 1 处`);
    process.exit(1);
  }
  write(rel, text.replace(re, `  "version": "${to}",`));
  console.log(`✓ ${rel}`);
}

// ── dsh-bundle/package-lock.json：顶层 + packages[""] 两条 ────────────────
{
  const rel = 'dsh-bundle/package-lock.json';
  mustExist(rel);
  let text = readFileSync(p(rel), 'utf8');
  const esc = from.replace(/\./g, '\\.');
  const topRe = new RegExp(`^ {2}"version": "${esc}",$`, 'm');
  const rootRe = new RegExp(`("packages":\\s*\\{\\s*"":\\s*\\{[^}]*?"version": ")${esc}(")`);
  if (!topRe.test(text) || !rootRe.test(text)) {
    console.error(`✗ ${rel}: 顶层或 packages[""] 的 version 不是 ${from}`);
    process.exit(1);
  }
  text = text.replace(topRe, `  "version": "${to}",`).replace(rootRe, `$1${to}$2`);
  write(rel, text);
  console.log(`✓ ${rel}`);
}

console.log(`\n${dryRun ? '[dry-run] 未写盘。' : `已写入 ${changed} 份文件。`}`);

// ── 收尾校验：cargo 认不认这份锁（改了 Cargo.toml 却没同步 lock，--locked 构建会红）──
if (!dryRun && existsSync(p('Cargo.lock'))) {
  try {
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--no-deps'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    console.log('✓ cargo metadata --locked：锁文件与 manifests 一致');
  } catch {
    console.error('✗ cargo metadata --locked 失败——Cargo.lock 没跟上，先修再 commit');
    process.exit(1);
  }
}
