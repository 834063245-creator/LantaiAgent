#!/usr/bin/env node

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// motion-bench — 动效**实测台架**（2026-11-17 立）。
//
// 为什么另起一件而不是改 motion-filmstrip.cjs：
//   ① filmstrip 只测「CSS 动画在不在播」——它靠 getAnimations() + currentTime 定帧。
//      而兰台最要紧的手势动效（画布平移、坞拖动）是 **JS rAF 驱动**的：没有
//      Animation 对象，getAnimations() 返回零条 ⇒ 那条路径它天生看不见。
//   ② 帧率/jank/松手行为要的是**实时采样**，不是定格。定格能证明「动画在播」，
//      证明不了「播得顺」。
//   ③ 它不能自己拉起环境（要求人手起 dev、手起浏览器、手敲 URL）——那不叫门禁。
//
// 本件三件事：
//   A. 自足：探测 dev server，不通则拉起；拉起 headless Chrome；退出全清。
//   B. 场景化：一个场景 = setup（到临战位）+ act（真实输入事件）+ sample（采样）。
//   C. 两种证据：帧（png，逐时刻截图）+ 数（每帧时间戳、几何、松手后滑行距离）。
//
// 用法：
//   node scripts/motion-bench.cjs <scenario|all> [--out tmp/bench] [--mode frame|perf|both]
//                                  [--times 0,60,120,200,320] [--url http://localhost:1420/]
//                                  [--port 9333] [--no-server] [--keep]
//
// 场景：
//   canvas-pan     画布平移：拖拽 → 松手。量「跟随期帧率」与「松手后是否滑行」。
//   draft-volume   待题纸 → 卷（落纸、化卷那一拍）。
//   composer-drag  创作坞解锁拖动 → 松手。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 候选浏览器（Windows 三选一，按序探测）。 */
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function parseArgs(argv) {
  const out = {
    scenario: argv[2] && !argv[2].startsWith('--') ? argv[2] : 'canvas-pan',
    out: 'tmp/bench',
    mode: 'both',
    times: '0,60,120,200,320',
    url: 'http://localhost:1420/',
    port: 9333,
    noServer: false,
    keep: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--times') out.times = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--no-server') out.noServer = true;
    else if (a === '--keep') out.keep = true;
  }
  return out;
}

const ARGS = parseArgs(process.argv);
const TIMES = ARGS.times.split(',').map(Number);
const ROOT = path.resolve(__dirname, '..');

// ── 环境：dev server ────────────────────────────────────────────────────────

function ping(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** 起 dev server（只在没通时起）；返回 { child, started }。 */
async function ensureDevServer() {
  if (await ping(ARGS.url)) return { child: null, started: false };
  if (ARGS.noServer) throw new Error('dev server 不通且要求 --no-server：' + ARGS.url);
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
    cwd: path.join(ROOT, 'src-ui'),
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await ping(ARGS.url)) return { child, started: true };
  }
  child.kill();
  throw new Error('dev server 60s 内没起来');
}

// ── 环境：浏览器 ────────────────────────────────────────────────────────────

function pickBrowser() {
  const hit = BROWSERS.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('找不到 Chrome/Edge，候选：\n  ' + BROWSERS.join('\n  '));
  return hit;
}

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function launchBrowser(port) {
  const bin = pickBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lantai-bench-'));
  const child = spawn(
    bin,
    [
      '--headless=new',
      // ⚠ 不传 --disable-gpu：要测的就是合成器路径，禁了 GPU 测出来的帧率没有意义。
      '--remote-debugging-port=' + port,
      '--window-size=1600,1000',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      targets = await getJson(port, '/json/list');
      if (targets.some((t) => t.type === 'page')) break;
    } catch {}
  }
  const page = (targets || []).find((t) => t.type === 'page');
  if (!page) {
    child.kill();
    throw new Error('浏览器起来了但拿不到 page target');
  }
  return { child, profile, page, bin };
}

// ── CDP 客户端 ──────────────────────────────────────────────────────────────

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); // Node >= 22 全局；本仓实测 Node 24
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message + ' (' + m.error.code + ')'));
      else p.resolve(m.result);
    }
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  /** 页面内求值。**异常必须冒泡**（上一代台架的坑：SyntaxError 被吞，帧读数静默丢光）。 */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(('页面求值异常：' + d.text + ' ' + (d.exception && d.exception.description)).slice(0, 2000));
    }
    return r.result && r.result.value;
  };
  return { ws, ready, send, evaluate };
}

// ── 页面内采样器（注入一次，随处复用）────────────────────────────────────────

/** 读「世界层」的平移量：.pp-world 的内联 transform 就是视口真值（单一真源在
 *  canvas-view-store，但渲染面落在这一条内联样式上——台架读渲染面，不读 store，
 *  避免「store 对了但没画出来」这种看不见的错）。 */
const READ_PAN = "(() => {\n" +
  "  const w = document.querySelector('.pp-world');\n" +
  "  if (!w) return null;\n" +
  "  const t = w.style.transform || '';\n" +
  '  const open = t.indexOf("translate(");\n' +
  "  if (open < 0) return null;\n" +
  '  const close = t.indexOf(")", open);\n' +
  "  if (close < 0) return null;\n" +
  '  const parts = t.slice(open + 10, close).split(",");\n' +
  "  if (parts.length < 2) return null;\n" +
  '  const x = parseFloat(parts[0]);\n' +
  '  const y = parseFloat(parts[1]);\n' +
  "  if (!isFinite(x) || !isFinite(y)) return null;\n" +
  "  return { x: x, y: y };\n" +
  "})";

const SAMPLER_START =
  "(() => {\n" +
  '  const readPan = ' + READ_PAN + ';\n' +
  "  const S = { t0: 0, samples: [], stop: false, marks: {} };\n" +
  "  window.__bench = S;\n" +
  "  S.mark = (name) => { S.marks[name] = +(performance.now() - S.t0).toFixed(1); return S.marks[name]; };\n" +
  "  S.start = () => {\n" +
  "    S.t0 = performance.now();\n" +
  "    S.samples = [];\n" +
  "    S.stop = false;\n" +
  "    S.marks = {};\n" +
  "    const tick = () => {\n" +
  "      try {\n" +
  "        S.samples.push([+(performance.now() - S.t0).toFixed(1), readPan(), document.getAnimations().length]);\n" +
  "      } catch (err) { S.errors = (S.errors || 0) + 1; S.lastError = String(err); }\n" +
  "      if (!S.stop) requestAnimationFrame(tick);\n" +
  "    };\n" +
  "    requestAnimationFrame(tick);\n" +
  "  };\n" +
  "  S.start();\n" +
  "  return 'sampling';\n" +
  "})()";

const SAMPLER_STOP = "(() => { window.__bench.stop = true; return JSON.stringify({ n: window.__bench.samples.length, errors: window.__bench.errors || 0, lastError: window.__bench.lastError || null, marks: window.__bench.marks }); })()";
const SAMPLER_READ = "JSON.stringify(window.__bench.samples)";

// ── 场景 ────────────────────────────────────────────────────────────────────

/** 进入画布（首页 → 点第一行工作区 → 等画布）。 */
/** 轮询等待某条件为真（比死等秒数稳：首屏是异步装配的）。 */
async function waitFor(cdp, expr, label, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cdp.evaluate(expr)) return true;
    await sleep(400);
  }
  throw new Error('等待超时（' + timeoutMs + 'ms）：' + label);
}

async function enterCanvas(cdp) {
  await cdp.send('Page.navigate', { url: ARGS.url });
  // 首页 → 工作区行出现（首屏异步装配，实测冷启动约 10s）
  await waitFor(cdp, "!!document.querySelector('.sh-row .sh-row-main')", '首页工作区行');
  const ok = await cdp.evaluate(
    "(() => { const r = document.querySelector('.sh-row .sh-row-main'); if (!r) return false; r.click(); return true; })()",
  );
  if (!ok) throw new Error('点不动工作区行');
  // 画布 → .pp-canvas 出现且世界层已落 transform
  await waitFor(cdp, "!!document.querySelector('.pp-canvas')", '画布');
  await waitFor(cdp, "!!(document.querySelector('.pp-world') && document.querySelector('.pp-world').style.transform)", '世界层 transform');
  await sleep(600); // 让首屏动画收尾
}

/** 鼠标事件三元组（CDP Input 域：真实派发，走浏览器输入管线，不是 JS click）。 */
async function mouse(cdp, type, x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

/**
 * canvas-pan：在空白画布上按住拖 300px，再松手。
 * 采样窗覆盖「跟手期 + 松手后 420ms」，同时回答两件事：
 *   - 跟手期每帧是否 <=16.7ms（掉帧 = 这个手势本身就不顺）；
 *   - 松手后 pan 是否继续变化（= 现在有没有惯性）。
 */
const SCENARIOS = {
  'canvas-pan': {
    title: '画布平移（拖拽 → 松手）',
    async act(cdp) {
      await cdp.evaluate(SAMPLER_START);
      const vw = await cdp.evaluate('innerWidth');
      const vh = await cdp.evaluate('innerHeight');
      const sx = Math.round(vw * 0.5);
      const sy = Math.round(vh * 0.28);
      await mouse(cdp, 'mousePressed', sx, sy);
      for (let i = 1; i <= 12; i++) {
        await mouse(cdp, 'mouseMoved', sx + i * 25, sy + i * 8);
        await sleep(16);
      }
      await cdp.evaluate("window.__bench.mark('release')");
      await mouse(cdp, 'mouseReleased', sx + 300, sy + 96);
      await sleep(420);
      const sampler = JSON.parse(await cdp.evaluate(SAMPLER_STOP));
      if (sampler.errors) throw new Error('采样器自报 ' + sampler.errors + ' 次异常：' + sampler.lastError);
      const samples = JSON.parse(await cdp.evaluate(SAMPLER_READ));
      return { samples, marks: sampler.marks, samplerErrors: sampler.errors, meta: { steps: 12, stepPx: 25, vw, vh } };
    },
  },

  'draft-volume': {
    title: '待题纸 → 卷（落纸 / 化卷）',
    async act(cdp) {
      await cdp.evaluate(
        "(() => { const b = document.querySelector('.pp-empty-cta'); if (b) b.click(); return !!b; })()",
      );
      await sleep(900);
      const typed = await cdp.evaluate(
        "(() => {\n" +
          "  const ta = document.querySelector('[data-draft-sheet] textarea');\n" +
          "  if (!ta) return false;\n" +
          "  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;\n" +
          "  setter.call(ta, '台架测试：这一句用来触发化卷。');\n" +
          "  ta.dispatchEvent(new Event('input', { bubbles: true }));\n" +
          '  return true;\n' +
          '})()',
      );
      if (!typed) throw new Error('落纸后没找到题签输入框');
      await sleep(400);
      await cdp.evaluate(SAMPLER_START);
      await cdp.evaluate(
        "(() => { const b = document.querySelector('.pp-send'); if (!b || b.disabled) return false; b.click(); return true; })()",
      );
      await sleep(520);
      const sampler = JSON.parse(await cdp.evaluate(SAMPLER_STOP));
      if (sampler.errors) throw new Error('采样器自报 ' + sampler.errors + ' 次异常：' + sampler.lastError);
      const samples = JSON.parse(await cdp.evaluate(SAMPLER_READ));
      const anims = await cdp.evaluate(
        "JSON.stringify(document.getAnimations().map(function (a) { return { n: a.animationName || a.transitionProperty || a.constructor.name, d: a.effect && a.effect.getTiming().duration }; }))",
      );
      return { samples, marks: sampler.marks, samplerErrors: sampler.errors, animations: JSON.parse(anims) };
    },
  },

  'composer-drag': {
    title: '创作坞拖动（解锁 → 拖 → 松手）',
    async act(cdp) {
      const unlocked = await cdp.evaluate(
        "(() => {\n" +
          "  const b = [...document.querySelectorAll('.pp-tool-btn')].find(function (x) { return /移|锁/.test(x.textContent || ''); });\n" +
          "  if (!b) return 'no-btn';\n" +
          "  if (/移/.test(b.textContent)) b.click();\n" +
          '  return b.textContent;\n' +
          '})()',
      );
      await sleep(200);
      const box = await cdp.evaluate(
        "(() => {\n" +
          "  const el = document.querySelector('.pp-composer');\n" +
          "  if (!el) return null;\n" +
          '  const r = el.getBoundingClientRect();\n' +
          '  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 6) };\n' +
          '})()',
      );
      if (!box) throw new Error('找不到创作坞');
      await cdp.evaluate(SAMPLER_START);
      await mouse(cdp, 'mousePressed', box.x, box.y);
      for (let i = 1; i <= 8; i++) {
        await mouse(cdp, 'mouseMoved', box.x + i * 18, box.y - i * 14);
        await sleep(16);
      }
      await mouse(cdp, 'mouseReleased', box.x + 144, box.y - 112);
      await sleep(420);
      const sampler = JSON.parse(await cdp.evaluate(SAMPLER_STOP));
      if (sampler.errors) throw new Error('采样器自报 ' + sampler.errors + ' 次异常：' + sampler.lastError);
      const samples = JSON.parse(await cdp.evaluate(SAMPLER_READ));
      const pos = await cdp.evaluate(
        "JSON.stringify((() => { const el = document.querySelector('.pp-composer'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })())",
      );
      return { samples, marks: sampler.marks, samplerErrors: sampler.errors, meta: { unlocked, pos: JSON.parse(pos) } };
    },
  },
};

// ── 分析：帧间隔 + 松手滑行 ─────────────────────────────────────────────────

function analyzePan(samples, marks) {
  const ts = samples.map((s) => s[0]);
  const frames = [];
  for (let i = 1; i < ts.length; i++) frames.push(+(ts[i] - ts[i - 1]).toFixed(1));
  const sorted = [...frames].sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  const median = q(0.5);
  const jank = frames.filter((f) => f > (median || 16.7) * 1.5 && f > 20);

  const pts = samples.filter((s) => s[1]);
  const moves = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][1].x - pts[i - 1][1].x;
    const dy = pts[i][1].y - pts[i - 1][1].y;
    if (dx || dy) moves.push([pts[i][0], Math.hypot(dx, dy)]);
  }
  const totalMove = +moves.reduce((a, m) => a + m[1], 0).toFixed(1);
  const lastMoveAt = moves.length ? moves[moves.length - 1][0] : null;
  // 松手之后的位移 = 惯性。**这一条是台架的核心读数**：0 = 松手即停（当前仓里的实况）。
  const rel = marks && marks.release != null ? marks.release : null;
  const afterRelease = rel === null ? [] : moves.filter((m) => m[0] > rel);

  return {
    frames: {
      count: frames.length,
      median,
      p90: q(0.9),
      max: sorted.length ? sorted[sorted.length - 1] : null,
      jankCount: jank.length,
      jankFrames: jank.slice(0, 20),
    },
    pan: {
      totalMove,
      movingFrames: moves.length,
      lastMoveAt,
      releaseAt: rel,
      afterReleasePx: +afterRelease.reduce((a, m) => a + m[1], 0).toFixed(1),
      afterReleaseFrames: afterRelease.length,
      afterReleaseMs: afterRelease.length ? +(afterRelease[afterRelease.length - 1][0] - rel).toFixed(1) : 0,
    },
    animationsMax: samples.reduce((a, s) => Math.max(a, s[2] || 0), 0),
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const names = ARGS.scenario === 'all' ? Object.keys(SCENARIOS) : ARGS.scenario.split(',');
  for (const n of names) {
    if (!SCENARIOS[n]) throw new Error('未知场景 ' + n + '；可选：' + Object.keys(SCENARIOS).join(' / '));
  }

  const server = await ensureDevServer();
  const browser = await launchBrowser(ARGS.port);
  const report = { url: ARGS.url, at: new Date().toISOString(), mode: ARGS.mode, browser: browser.bin, scenarios: {} };

  try {
    const cdp = connect(browser.page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    for (const name of names) {
      const sc = SCENARIOS[name];
      const outDir = path.join(ROOT, ARGS.out, name);
      fs.mkdirSync(outDir, { recursive: true });
      for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));

      process.stdout.write('\n> ' + name + ' · ' + sc.title + '\n');
      await enterCanvas(cdp);
      const run = await sc.act(cdp);

      if (ARGS.mode !== 'perf') {
        for (const t of TIMES) {
          const n = await cdp.evaluate(
            '(() => {\n' +
              '  const as = document.getAnimations();\n' +
              '  for (const a of as) { try { a.pause(); a.currentTime = ' + t + '; } catch (e) {} }\n' +
              '  return as.length;\n' +
              '})()',
          );
          await sleep(60);
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(
            path.join(outDir, 't' + String(t).padStart(4, '0') + '.png'),
            Buffer.from(shot.data, 'base64'),
          );
          process.stdout.write('   frame t=' + t + 'ms  animations=' + n + '\n');
        }
      }

      const analysis = analyzePan(run.samples, run.marks);
      report.scenarios[name] = {
        title: sc.title,
        analysis,
        marks: run.marks || null,
        meta: run.meta || null,
        animations: run.animations || null,
      };
      fs.writeFileSync(path.join(outDir, 'samples.json'), JSON.stringify(run.samples, null, 1));

      const f = analysis.frames;
      const p = analysis.pan;
      process.stdout.write(
        '   frames: n=' + f.count + ' median=' + f.median + 'ms p90=' + f.p90 + 'ms max=' + f.max + 'ms jank=' + f.jankCount + '\n' +
          '   pan: move=' + p.totalMove + 'px frames=' + p.movingFrames + '\n' +
          '   handoff: 松手后 ' + p.afterReleasePx + 'px / ' + p.afterReleaseFrames + ' 帧 / ' + p.afterReleaseMs + 'ms' +
          (p.afterReleasePx === 0 ? '  ← 零惯性（松手即停）' : '') + '\n',
      );
    }

    cdp.ws.close();
  } finally {
    if (!ARGS.keep) {
      browser.child.kill();
      await sleep(300);
      try {
        fs.rmSync(browser.profile, { recursive: true, force: true });
      } catch {}
    }
    if (server.started && !ARGS.keep) server.child.kill();
  }

  fs.mkdirSync(path.join(ROOT, ARGS.out), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ARGS.out, 'report.json'), JSON.stringify(report, null, 1));
  console.log('\n报告 -> ' + path.join(ARGS.out, 'report.json'));
}

main().catch((e) => {
  console.error(String(e.stack || e).slice(0, 4000));
  process.exit(1);
});
