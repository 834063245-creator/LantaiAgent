// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

/**
 * release-local.mjs — 本地发版：把本机构建出的安装包发成「国内用户能自动更新」的一版。
 *
 * 为什么有它（2026-09-26 实测结论）：GitHub 的美国 runner 往国内主机上传大文件只有
 * **29 KB/s**（4 次重试均如此，属系统性），所以「CI 自动往国内镜像」这条路不可用；
 * 而**本机在国内，上传是国内链路**，快得多。于是改成：本机构建+签名 → 上传 GitCode →
 * 把更新清单推到 Gitee。全程零跨境。
 *
 * 它做四件事：
 *   ① 检查本机构建产物（安装包 + .sig，必须是**带签名**构建出来的）
 *   ② 上传到 GitCode 发行版附件（两步：签名描述符 upload_url → PUT）
 *   ③ 生成 Tauri 更新清单 latest.json
 *   ④ 强推清单到 Gitee 的 updater-manifest 分支，并做无凭据公开读回校验
 *
 * 用法：
 *   node scripts/release-local.mjs
 *   node scripts/release-local.mjs --notes "修了 xxx" 
 *   node scripts/release-local.mjs --notes-file CHANGELOG_SECTION.md
 *   node scripts/release-local.mjs --with-msi          # 连 MSI 一起发（多 160MB 上传）
 *   node scripts/release-local.mjs --skip-verify       # 跳过公开读回校验（不推荐）
 *
 * 前置（缺哪样它会明确告诉你）：
 *   1. 环境变量 GITCODE_ACCESS_TOKEN = 一个 GitCode 私人令牌（对目标仓库有发行版写权限）
 *   2. 构建产物已存在，且是**带签名**构建的：
 *        $env:TAURI_SIGNING_PRIVATE_KEY = "D:\keys\lantai.key"
 *        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<你的密码>"
 *        cd src-tauri ; cargo tauri build
 *      ⚠️ 不要用 build.cmd —— 它带 --config no-updater.local.json，会关掉 updater 产物（没有 .sig）
 *   3. Gitee 侧走 SSH（~/.ssh/config 里已有 Host gitee.com），不需要令牌
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const GITCODE_REPO = process.env.GITCODE_REPOSITORY || 'gcw_aU7Q6cqH/LantaiAgent';
const GITEE_REPO = process.env.GITEE_REPOSITORY || 'jingwen-bing/lantai-agent';
const GITCODE_API = 'https://api.gitcode.com/api/v5/repos';
const MANIFEST_URL = `https://gitee.com/${GITEE_REPO}/raw/updater-manifest/latest.json`;
const UA = 'lantai-release-local/1.0';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const TOKEN = process.env.GITCODE_ACCESS_TOKEN || '';
const WITH_MSI = flag('--with-msi');
const SKIP_VERIFY = flag('--skip-verify');

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const step = (msg) => console.log(`\n=== ${msg} ===`);

// ---------------------------------------------------------------- 前置检查

function readVersion() {
  const conf = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  return { version: conf.version, productName: conf.productName };
}

function findArtifacts(version) {
  const nsisDir = path.join(REPO_ROOT, 'target', 'release', 'bundle', 'nsis');
  const msiDir = path.join(REPO_ROOT, 'target', 'release', 'bundle', 'msi');
  const pick = (dir, re, label) => {
    if (!fs.existsSync(dir)) return null;
    const hit = fs
      .readdirSync(dir)
      .filter((n) => re.test(n))
      .sort()
      .pop();
    if (!hit) return null;
    const file = path.join(dir, hit);
    const sig = `${file}.sig`;
    if (!fs.existsSync(sig)) {
      die(
        `${label} 没有配套的 .sig：\n  ${file}\n\n` +
          `说明这次构建**没带签名**。正确做法：\n` +
          `  $env:TAURI_SIGNING_PRIVATE_KEY = "D:\\keys\\lantai.key"\n` +
          `  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<你的密码>"\n` +
          `  cd src-tauri ; cargo tauri build\n\n` +
          `⚠️ 不要用 build.cmd —— 它带 --config no-updater.local.json，会把 updater 产物关掉。`,
      );
    }
    return { file, sig, name: hit };
  };
  const nsis = pick(nsisDir, /_x64-setup\.exe$/, 'NSIS 安装包');
  if (!nsis) {
    die(
      `没找到 v${version} 的 NSIS 安装包（在 target/release/bundle/nsis/）。\n` +
        `先跑一次带签名的构建：\n` +
        `  $env:TAURI_SIGNING_PRIVATE_KEY = "D:\\keys\\lantai.key"\n` +
        `  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<你的密码>"\n` +
        `  cd src-tauri ; cargo tauri build`,
    );
  }
  const msi = WITH_MSI ? pick(msiDir, /_x64_zh-CN\.msi$/, 'MSI 安装包') : null;
  if (WITH_MSI && !msi) die('加了 --with-msi 但没找到 MSI 产物');
  return { nsis, msi };
}

// ---------------------------------------------------------------- GitCode

const gcHeaders = () => ({ 'PRIVATE-TOKEN': TOKEN, 'User-Agent': UA });

async function gcJson(method, suffix, { query = {}, body } = {}) {
  const url = new URL(`${GITCODE_API}/${GITCODE_REPO}${suffix}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: body ? { ...gcHeaders(), 'Content-Type': 'application/json' } : gcHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GitCode ${method} ${suffix} → HTTP ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

async function ensureRelease(tag) {
  let rel = null;
  try {
    rel = await gcJson('GET', `/releases/tags/${encodeURIComponent(tag)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  if (rel) {
    console.log(`  发行版 ${tag} 已存在，复用`);
    return rel;
  }
  console.log(`  创建发行版 ${tag}（先置 pre，全部就绪后再提 latest）`);
  await gcJson('POST', '/releases', {
    body: { tag_name: tag, name: tag, body: `兰台 ${tag}（本机构建并签名）`, release_status: 'pre' },
  });
  return gcJson('GET', `/releases/tags/${encodeURIComponent(tag)}`);
}

async function uploadDescriptor(tag, fileName) {
  // 官方文档只成文了「下载附件」，上传端点是两步：先取签名描述符，再 PUT。
  // 认证：先用 PRIVATE-TOKEN 头，拿不到就回退 access_token query。
  const suffix = `/releases/${encodeURIComponent(tag)}/upload_url`;
  let desc = null;
  try {
    desc = await gcJson('GET', suffix, { query: { file_name: fileName } });
  } catch {
    desc = null;
  }
  if (!desc?.url) desc = await gcJson('GET', suffix, { query: { file_name: fileName, access_token: TOKEN } });
  if (!desc?.url) die(`拿不到上传描述符（${fileName}）。API 返回：${JSON.stringify(desc)}`);
  return { url: desc.url, headers: desc.headers || {} };
}

async function uploadAsset(tag, filePath, fileName) {
  const target = await uploadDescriptor(tag, fileName);
  const bytes = fs.readFileSync(filePath);
  const t0 = Date.now();
  console.log(`  上传 ${fileName}（${(bytes.length / 1048576).toFixed(1)} MB）…`);
  const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body: bytes });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res.ok) die(`上传失败 ${fileName}：HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
  const mbps = bytes.length / 1048576 / (secs / 1);
  console.log(`  上传完成：${secs}s（约 ${mbps.toFixed(1)} MB/s）`);
}

const attachUrl = (tag, fileName) =>
  `https://api.gitcode.com/api/v5/repos/${GITCODE_REPO}/releases/${tag}/attach_files/${fileName}/download`;

async function waitVisible(tag, fileName, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const rel = await gcJson('GET', `/releases/tags/${encodeURIComponent(tag)}`);
    if ((rel.assets || []).some((a) => a.name === fileName)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  die(`上传后 ${fileName} 在发行版资产列表里一直不可见`);
}

// ---------------------------------------------------------------- 清单

function buildManifest(version, notes, entries) {
  const platforms = {};
  // 客户端查找顺序是 [windows-x86_64-<bundle_type>, windows-x86_64]，
  // 所以 NSIS 那份同时挂到 windows-x86_64 与 windows-x86_64-nsis 两个键上。
  platforms['windows-x86_64'] = { signature: entries.nsis.sig.trim(), url: entries.nsis.url };
  platforms['windows-x86_64-nsis'] = { signature: entries.nsis.sig.trim(), url: entries.nsis.url };
  if (entries.msi) {
    platforms['windows-x86_64-msi'] = { signature: entries.msi.sig.trim(), url: entries.msi.url };
  }
  return {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

// ---------------------------------------------------------------- Gitee

function pushManifest(manifest, version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lantai-manifest-'));
  try {
    fs.writeFileSync(path.join(tmp, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const git = (a) => execFileSync('git', a, { cwd: tmp, stdio: ['ignore', 'inherit', 'inherit'] });
    git(['init', '-q', '-b', 'updater-manifest']);
    git(['add', 'latest.json']);
    git([
      '-c', 'user.email=release@lantai.local',
      '-c', 'user.name=lantai-release',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', `chore(updater): 发布 v${version}`,
    ]);
    git(['push', '--force', `git@gitee.com:${GITEE_REPO}.git`, 'HEAD:refs/heads/updater-manifest']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 校验

async function verifyPublic(localFile, expectVersion, expectUrl) {
  console.log('  等待 Gitee raw 的 CDN 生效（约 60s 缓存）…');
  for (let i = 1; i <= 20; i++) {
    try {
      const res = await fetch(MANIFEST_URL, { headers: { 'User-Agent': 'tauri-plugin-updater/2.10.1', Accept: 'application/json' } });
      if (res.ok) {
        const m = await res.json();
        const url = m?.platforms?.['windows-x86_64']?.url;
        if (m.version === expectVersion && url === expectUrl) {
          console.log(`  清单已公开可见且指向本次产物（第 ${i} 次探测）`);
          return;
        }
        console.log(`  第 ${i} 次：仍是旧清单（version=${m.version}）`);
      } else {
        console.log(`  第 ${i} 次：清单还取不到（HTTP ${res.status}）`);
      }
    } catch (e) {
      console.log(`  第 ${i} 次：探测失败 ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  die('5 分钟内清单未生效；附件已上传，但客户端暂时读不到新清单');
}

async function probeInstaller(url, localFile) {
  const res = await fetch(url, {
    headers: { Range: 'bytes=0-1023', 'User-Agent': 'tauri-plugin-updater/2.10.1' },
  });
  if (!res.ok) die(`公开地址取不到安装包：HTTP ${res.status} ${url}`);
  let got;
  if (res.status === 206) {
    got = Buffer.from(await res.arrayBuffer());
  } else {
    // 服务端忽略了 Range：只读第一块就断开，别把整包拉下来
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    got = Buffer.from(value || []).subarray(0, 1024);
  }
  const want = fs.readFileSync(localFile).subarray(0, got.length);
  if (!got.equals(want)) die('公开下载的首段字节与本地不一致（上传可能被截断）');
  console.log(`  公开可达，首 ${got.length} 字节逐字节一致（HTTP ${res.status}）`);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!TOKEN) {
    die(
      '缺少环境变量 GITCODE_ACCESS_TOKEN（GitCode 私人令牌）。\n' +
        '  PowerShell: $env:GITCODE_ACCESS_TOKEN = "<令牌>"\n' +
        '  令牌在 gitcode.com → 个人设置 → 访问令牌 里生成，权限勾发行版/代码写。',
    );
  }

  const { version } = readVersion();
  const tag = `v${version}`;
  console.log(`发版本地流程：${tag}`);
  console.log(`  GitCode 仓库：${GITCODE_REPO}`);
  console.log(`  Gitee  仓库：${GITEE_REPO}`);

  step('① 检查构建产物');
  const { nsis, msi } = findArtifacts(version);
  console.log(`  NSIS：${nsis.name}`);
  if (msi) console.log(`  MSI ：${msi.name}`);

  step('② 上传到 GitCode 发行版');
  await ensureRelease(tag);
  const existing = new Set(
    ((await gcJson('GET', `/releases/tags/${encodeURIComponent(tag)}`)).assets || []).map((a) => a.name),
  );
  const entries = {};
  const plan = [
    ['nsis', nsis, `Lantai_${version}_x64-setup.exe`],
    ...(msi ? [['msi', msi, `Lantai_${version}_x64_zh-CN.msi`]] : []),
  ];
  for (const [kind, art, asciiName] of plan) {
    if (existing.has(asciiName)) {
      console.log(`  ${asciiName} 已存在，跳过上传`);
    } else {
      await uploadAsset(tag, art.file, asciiName);
      await waitVisible(tag, asciiName);
    }
    const url = attachUrl(tag, asciiName);
    if (!SKIP_VERIFY) await probeInstaller(url, art.file);
    entries[kind] = { sig: fs.readFileSync(art.sig, 'utf8'), url };
  }

  step('③ 生成更新清单');
  const notes = opt('--notes') || (opt('--notes-file') ? fs.readFileSync(opt('--notes-file'), 'utf8').trim() : `兰台 ${tag}`);
  const manifest = buildManifest(version, notes, entries);
  console.log(JSON.stringify({ ...manifest, platforms: Object.fromEntries(Object.entries(manifest.platforms).map(([k, v]) => [k, { ...v, signature: `<${v.signature.length} 字符>` }])) }, null, 2));

  step('④ 推清单到 Gitee（updater-manifest 分支）');
  pushManifest(manifest, version);
  console.log('  已推送');

  if (!SKIP_VERIFY) {
    step('⑤ 公开读回校验');
    await verifyPublic(nsis.file, version, entries.nsis.url);
  }

  step('完成');
  console.log(`  清单：${MANIFEST_URL}`);
  console.log(`  安装包：${entries.nsis.url}`);
  console.log('\n用户侧：应用内「检查更新」会看到新版并自动下载安装。');
}

main().catch((e) => die(e?.stack || String(e)));
