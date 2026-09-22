#!/usr/bin/env node
// 兰台 OfficeCLI 取件器（随包分发的取件端）。
//
// 背景：OfficeCLI 是 `office(action,…)` 域工具的后端二进制（上游 iOfficeAI/OfficeCLI，
// Apache-2.0，win-x64 单文件 ~32 MB）。它**不随 git 入库**（.gitignore 的 `*.exe`），
// 也**不能靠终端用户手动装**——用户只拿到安装包，没有本仓库目录，跑不了
// `examples/office-cli/install-officecli.ps1`。所以取件必须发生在**构建/打包期**，
// 由本脚本把 pin 住的资产落到 `src-tauri/bin/officecli.exe`，再由
// `tauri.conf.json` 的 `bundle.resources` 打进安装包、落到宿主 exe 同级。
//
// 这与 `model.onnx`（90 MB，同样不入库，CI 拉取 + sha256 校验）是同一套纪律。
//
// 用法：
//   node scripts/fetch-officecli.mjs                 取件（缺件/哈希不符才下载）
//   node scripts/fetch-officecli.mjs --check         只校验（打包前门禁用；缺件或哈希不符 = 非零退出）
//   node scripts/fetch-officecli.mjs --from-local <path>   离线取件（从本机已有二进制装，仍要过哈希）
//   node scripts/fetch-officecli.mjs --allow-unpinned      显式放行非 pin 哈希（**响警报**，仅开发排查用）
//   node scripts/fetch-officecli.mjs --upstream       查上游有无新版（**只提示**：不改 pin、不影响退出码、不阻断流程）
//
// 纪律（照 examples/office-cli/install-officecli.ps1 的成熟做法）：
//   - **哈希不符即拒绝**（错误不静默）——防篡改，也防「下到一半的截断文件」冒充成功；
//   - **原子落位**——先写 .tmp，校验通过才 rename，绝不留下半截件；
//   - **幂等**——目标哈希已对，直接报「无需取件」成功；
//   - 版本升级 = 换 tag + 换哈希，**同改本文件与 install-officecli.ps1 的 pin 表**。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';
import { argv, exit, platform } from 'node:process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── pin 表（升级此处 = 同改 install-officecli.ps1 的 $PINNED）────────────────────
// 版本与哈希两处独立来源互证：本表取自 install-officecli.ps1 的 $PINNED，而那份
// 是该脚本端到端实测过的值；同版本官方 SHA256SUMS 的 win-x64 行亦为此值。
const PINNED_VERSION = '1.0.149';
const PINNED_SHA256 = 'abd82dae417b66aae62d1ec8edbf88ba9d5be7442b55be470b34b764f10731e2';
const ASSET = 'officecli-win-x64.exe';
const RELEASE_URL =
  `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${PINNED_VERSION}/${ASSET}`;

/** 落点：tauri.conf.json `bundle.resources` 的源路径（映射到宿主 exe 同级的 `officecli.exe`）。 */
const TARGET = join(repoRoot, 'src-tauri', 'bin', 'officecli.exe');

/** 运行时要找的可执行名（与打包映射的目标名、process_cap 的候选名三处必须一致）。 */
const RUNTIME_NAME = 'officecli.exe';

// ── 参数 ──────────────────────────────────────────────────────────────────────
const args = argv.slice(2);
const checkOnly = args.includes('--check');
const upstreamOnly = args.includes('--upstream');
const allowUnpinned = args.includes('--allow-unpinned');
const fromLocalIdx = args.indexOf('--from-local');
const fromLocal = fromLocalIdx >= 0 ? args[fromLocalIdx + 1] : null;
if (fromLocalIdx >= 0 && !fromLocal) fail('--from-local 需要给一个文件路径');

function log(msg) {
  process.stdout.write(`[officecli-fetch] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[officecli-fetch] 拒绝：${msg}\n`);
  exit(1);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function human(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

/** 目标是否已经是 pin 住的那份（幂等判据）。 */
function targetState() {
  if (!existsSync(TARGET)) return { present: false };
  const digest = sha256File(TARGET);
  return { present: true, digest, pinned: digest === PINNED_SHA256, size: statSync(TARGET).size };
}

// ── --check：打包前门禁（缺件 / 哈希不符 = 非零退出）────────────────────────────
if (checkOnly) {
  const st = targetState();
  if (!st.present) {
    fail(
      `随包件缺席：${TARGET}\n` +
        `  安装包会缺 office 域工具后端（用户侧一调即报「未找到 officecli 可执行文件」）。\n` +
        `  取件：node scripts/fetch-officecli.mjs`,
    );
  }
  if (!st.pinned) {
    fail(
      `随包件哈希不符：${TARGET}\n` +
        `  实得 ${st.digest}\n  期望 ${PINNED_SHA256}（v${PINNED_VERSION} ${ASSET}）\n` +
        `  重取：node scripts/fetch-officecli.mjs --force`,
    );
  }
  log(`✓ 随包件就位且哈希相符（v${PINNED_VERSION}，${human(st.size)}）`);
  exit(0);
}

// ── --upstream：查上游有无新版（**只提示**，不改 pin、不影响退出码、不阻断流程）────────
//
// 为什么要它：pin 住版本是对的（哈希校验才有意义、上游改 CLI 不会打到用户），但副作用是
// **「该升级了」没有任何信号**——只能靠人记得。本开关补上信号，决定权仍在人手里：
// 它绝不改 PINNED_*、绝不落位、绝不因「有新版本」而失败。
//
// 何时跑：显式 `--upstream`（手动查），或 release.yml 里那条 continue-on-error 的提醒步。
// **刻意不挂进 build.cmd / `--check`**：那样每次构建都要联网，离线构建还得干等超时。
const UPSTREAM_API = 'https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest';

/** 版本号比较：a 比 b 新则 true（按点分数字段比，**不能按字典序**——'1.0.9' < '1.0.10'）。 */
function isNewer(a, b) {
  const parse = (v) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] ?? 0, pb[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}

/** 取上游最新 tag（返回 tag 字符串；两条通道都失败返回 null——**从不抛**）。 */
async function latestUpstreamTag() {
  // 通道 1：node https（自带 CA 包）
  try {
    const tag = await new Promise((res, rej) => {
      const req = get(
        UPSTREAM_API,
        { headers: { 'user-agent': 'lantai-build' }, timeout: 8000 },
        (r) => {
          if (r.statusCode !== 200) {
            r.resume();
            rej(new Error(`HTTP ${r.statusCode}`));
            return;
          }
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (c) => {
            body += c;
          });
          r.on('end', () => {
            try {
              res(JSON.parse(body).tag_name ?? null);
            } catch (e) {
              rej(e);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', rej);
    });
    if (tag) return { tag, via: 'node' };
  } catch {
    // 落到通道 2（常见于本机 TLS 链的根不在 node 自带 CA 包里的情形）
  }
  // 通道 2：curl 兜底（`--ssl-no-revoke` 绕开 schannel 吊销检查——受限网络下的常态）
  try {
    const out = execFileSync(
      'curl',
      [
        '-sS',
        '--ssl-no-revoke',
        '--max-time',
        '10',
        '-H',
        'user-agent: lantai-build',
        UPSTREAM_API,
      ],
      // stderr 一律丢弃：这只是"顺手查一下上游"的提醒通道，它的报错不该在构建日志里
      // 喧宾夺主（探测失败由下方统一降级为一句「无法查询…已跳过」）。
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const tag = JSON.parse(out).tag_name ?? null;
    if (tag) return { tag, via: 'curl' };
  } catch {
    // 两条都不通
  }
  return null;
}

if (upstreamOnly) {
  const found = await latestUpstreamTag();
  if (!found) {
    log('无法查询上游最新版（网络 / TLS 均不可达）——已跳过，不影响任何流程。');
    log(
      '  · 若报证书类错误，本机可试：node --use-system-ca scripts/fetch-officecli.mjs --upstream',
    );
    exit(0);
  }
  if (isNewer(found.tag, PINNED_VERSION)) {
    log(
      `⬆ 上游已发布 ${found.tag}（当前随包 pin 的是 v${PINNED_VERSION}；经 ${found.via} 查得）`,
    );
    log('  升级是**可选项**、不影响现有功能；要升再走下面四步（否则忽略本条即可）：');
    log('    ① 改本文件 PINNED_VERSION / PINNED_SHA256（从该 tag 的官方 SHA256SUMS 取）');
    log('    ② 同步 examples/office-cli/install-officecli.ps1 的 $PINNED（两处必须同改）');
    log('    ③ node scripts/fetch-officecli.mjs 取件（哈希不符会拒绝落位）');
    log('    ④ 重跑门禁——office 域工具的动词白名单要重验（上游可能改了命令行）');
  } else {
    log(`✓ 随包版本已是最新（v${PINNED_VERSION}；上游最新 ${found.tag}，经 ${found.via} 查得）`);
  }
  exit(0);
}

// ── 非 Windows：资产是 win-x64，明确跳过（不假装成功）────────────────────────────
if (platform !== 'win32' && !fromLocal) {
  log(`跳过：pin 的资产 ${ASSET} 是 win-x64；当前平台 ${platform} 不取件。`);
  log('（要跨平台打包需先在下方 pin 表补该平台资产 + 改 tauri.conf 的资源名。）');
  exit(0);
}

// ── 幂等：已是 pin 件则直接成功 ────────────────────────────────────────────────
const before = targetState();
if (before.present && before.pinned && !fromLocal) {
  log(`无需取件：已是 v${PINNED_VERSION} pin 件（${human(before.size)}）`);
  exit(0);
}
if (before.present && !before.pinned && !allowUnpinned && !fromLocal) {
  log(`现有随包件非 pin 件（实得 ${before.digest}），将重取 v${PINNED_VERSION}。`);
}

mkdirSync(dirname(TARGET), { recursive: true });
const tmp = `${TARGET}.tmp`;

/** 校验并原子落位。 */
function stageVerified(srcPath, sourceLabel) {
  const digest = sha256File(srcPath);
  if (digest !== PINNED_SHA256) {
    if (!allowUnpinned) {
      rmSync(tmp, { force: true });
      fail(
        `${sourceLabel} 哈希不符，拒绝落位：\n` +
          `  实得 ${digest}\n  期望 ${PINNED_SHA256}（v${PINNED_VERSION} ${ASSET}）\n` +
          `  若确系开发排查需放行非 pin 件：加 --allow-unpinned（会响警报，勿用于发布）`,
      );
    }
    process.stderr.write(
      `[officecli-fetch] ⚠ 警报：放行非 pin 件（实得 ${digest}，期望 ${PINNED_SHA256}）——` +
        '此件不得用于发布。\n',
    );
  }
  renameSync(srcPath, TARGET);
  const size = statSync(TARGET).size;
  log(`✓ 已落位 ${TARGET}（v${PINNED_VERSION}，${human(size)}）`);
}

// ── 离线取件：从本机已有二进制 ──────────────────────────────────────────────────
if (fromLocal) {
  const src = resolve(fromLocal);
  if (!existsSync(src)) fail(`--from-local 指的文件不存在：${src}`);
  const digest = sha256File(src);
  if (digest !== PINNED_SHA256 && !allowUnpinned) {
    fail(
      `本地件哈希不符：${src}\n  实得 ${digest}\n  期望 ${PINNED_SHA256}（v${PINNED_VERSION} ${ASSET}）\n` +
        '  注意：本机 %USERPROFILE%\\.lantai\\tools\\officecli\\ 下的件可能已被 officecli 自更新改写过，\n' +
        '  不再是 pin 版本——这种件不适合随包（要放行：--allow-unpinned，仅限开发排查）。',
    );
  }
  // 原子：先拷到 .tmp 再校验落位（**必须同步**——异步流 + 立即 exit 会
  // 在写完之前退出进程，症状是"脚本成功但文件没落位"的静默失败）
  rmSync(tmp, { force: true });
  writeFileSync(tmp, readFileSync(src));
  stageVerified(tmp, `本地件 ${src}`);
  exit(0);
}

// ── 默认：下载 → 校验 → 原子落位 ────────────────────────────────────────────────
log(`取件 v${PINNED_VERSION}：${RELEASE_URL}`);

/** 带重定向跟随的下载（GitHub release 会 302 到 objects.githubusercontent.com）。 */
function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = get(url, { headers: { 'user-agent': 'lantai-build' }, timeout: 120_000 }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          rejectPromise(new Error('重定向次数过多'));
          return;
        }
        const next = new URL(headers.location, url).toString();
        download(next, dest, redirectsLeft - 1).then(resolvePromise, rejectPromise);
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        rejectPromise(new Error(`HTTP ${statusCode}`));
        return;
      }
      const total = Number(headers['content-length'] ?? 0);
      let seen = 0;
      let lastPct = -10;
      const ws = createWriteStream(dest);
      res.on('data', (chunk) => {
        seen += chunk.length;
        if (total > 0) {
          const pct = Math.floor((seen / total) * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            log(`  ${pct}% (${human(seen)} / ${human(total)})`);
          }
        }
      });
      res.pipe(ws);
      ws.on('finish', () => resolvePromise(seen));
      ws.on('error', rejectPromise);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时（120s）')));
    req.on('error', rejectPromise);
  });
}

try {
  rmSync(tmp, { force: true });
  const got = await download(RELEASE_URL, tmp);
  log(`下载完成 ${human(got)}，校验哈希…`);
  stageVerified(tmp, '下载件');
} catch (err) {
  rmSync(tmp, { force: true });
  const code = err?.code ?? '';
  // 环境相关的两类下载拦路（2026-09-22 本机实测，均已验证有效）：
  //   · UNABLE_TO_VERIFY_LEAF_SIGNATURE —— node 用自带 CA 包，而本机的 TLS 链由本机信任的
  //     根签发（代理/安全软件介入的常见形态）：node 不认，浏览器/channel 认（schannel 走
  //     Windows 证书库）。修法 = `node --use-system-ca`（Node ≥22.15 支持用系统证书库）。
  //   · schannel 的 CRYPT_E_NO_REVOCATION_CHECK —— curl 走 Windows schannel 时连不上吊销
  //     服务器（受限网络下的常态）⇒ 加 `--ssl-no-revoke`。
  const hints = [
    '  · 若报「unable to verify the first certificate / UNABLE_TO_VERIFY_LEAF_SIGNATURE」：',
    '      本机 TLS 链用的根不在 node 自带 CA 包里。改用系统证书库重跑：',
    '        node --use-system-ca scripts/fetch-officecli.mjs',
    '  · 若本机 curl 也连不上（schannel 吊销检查失败 / 超时）：',
    '        curl -L --ssl-no-revoke -o officecli.exe \\',
    `          ${RELEASE_URL}`,
    '        node scripts/fetch-officecli.mjs --from-local officecli.exe',
    '    （哈希仍会校验：符合 pin 才落位，不符合即拒绝——绕过 TLS 不等于放弃完整性。）',
    '  · 离线环境：用本机已有的 pin 版二进制走 --from-local。',
    '    注意：本机安装位 %USERPROFILE%\\.lantai\\tools\\officecli\\ 下的件**可能已被 officecli',
    '    自更新改写**（不再是 pin 版本，哈希对不上），那种件不适合随包。',
  ].join('\n');
  fail(
    `下载失败：${err?.message ?? err}${code ? `（code=${code}）` : ''}\n${hints}`,
  );
}
