#!/usr/bin/env node

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// motion-filmstrip — **动效定帧台架**（2026-11-15 化卷复修批立，取代 tmp/ 里的一次性脚本）。
//
// 为什么需要它：界面动效的「有没有播」不能靠读源码判断——CSS 里写得整整齐齐、浏览器
// 里一条动画都没有，是这一批实测到的**真实事故形态**（时长 token 自带 bezier，简写里
// 再叠一段曲线 = 解析失败 ⇒ 声明级联丢弃；全仓 10 处、8 条动效静默失效）。
// 测试查得的是**属性在不在**（\`data-morph\`），查不出**动画在不在**（\`getAnimations()\`）。
//
// 做法：把一窗 260ms 拆成若干时刻，**暂停全部动画并逐帧设 currentTime** 再截图——
// 拿到的是可逐帧复算的证据，不是「跑一遍看看」的偶然截图。
//
// 用法：
//   1. 先起 dev：cd src-ui && npm run dev（浏览器 mock 通道，见 src/bridge.ts）
//   2. 再起无头 WebView/Chrome 指向它（脚本不负责拉起浏览器，见文件尾注）
//   3. node scripts/motion-filmstrip.cjs --out tmp/strip --times 0,80,120,160,200,240 \
//        [--prep <file.js>] [--trigger <file.js>] [--url http://localhost:1420/] \
//        [--settle 9000] [--port 9333] [--keep-timers]
//
// 默认流程（不传 --prep/--trigger）= 本仓的「待题纸 → 发送」那一拍：
//   进画布 → 点「＋」落纸 → 纸面输入框写一句 → 点「拟文」。
//
// ⚠ 台架必须**冻住 >=150ms 的 setTimeout**：化卷窗的撤纸定时器（DRAFT_MORPH_MS=260）
// 会把纸提前拆掉，逐帧读数就全是 null。--keep-timers 关掉这一层（看真实收尾时用）。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/** 解析 --key value / --flag */
function parseArgs(argv) {
  const out = {
    out: 'tmp/strip',
    times: '0,65,130,195,260',
    port: 9333,
    prep: null,
    trigger: null,
    keepTimers: false,
    url: 'http://localhost:1420/',
    settle: 9000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--settle') out.settle = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--times') out.times = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--prep') out.prep = argv[++i];
    else if (a === '--trigger') out.trigger = argv[++i];
    else if (a === '--keep-timers') out.keepTimers = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const PORT = args.port;
const TIMES = args.times.split(',').map(Number);

/** 默认 prep：进画布 → 落纸 → 写一句（用户操作序列，不是 mock 内部态）。 */
const DEFAULT_PREP = `
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!document.querySelector('.pp-canvas')) {
    const row = document.querySelector('.sh-row .sh-row-main');
    if (row) { row.click(); await wait(7000); }
  }
  if (!document.querySelector('[data-draft-sheet]')) {
    const cta = document.querySelector('.pp-empty-cta');
    if (cta) { cta.click(); await wait(900); }
  }
  const ta = document.querySelector('[data-draft-sheet] textarea');
  if (!ta) return 'no draft textarea';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '测试转场：这是一句话。');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(300);
  return 'ok';
})()
`;

/** 默认 trigger：点「拟文」（= 发送即开卷）。 */
const DEFAULT_TRIGGER = `(() => { const b = document.querySelector('.pp-send'); if (!b) return 'no send button'; b.click(); return 'sent'; })()`;

/** 藏掉与本拍无关的浮层（toast / 首页），免得每次都要人眼过滤。 */
const HIDE_NOISE =
  '(() => { const s = document.createElement("style"); s.textContent = \'[class*="pp-toast"]{display:none !important} .sh-root{display:none !important}\'; document.head.appendChild(s); return "hidden"; })()';

/** 冻住长定时器（撤纸定时器会把窗口提前关掉，见头注）。 */
const FREEZE_TIMERS =
  '(() => { if (window.__frozen) return "already"; window.__frozen = true; const orig = window.setTimeout; window.setTimeout = function (fn, ms, ...rest) { if (typeof ms === "number" && ms >= 150) return 0; return orig.call(window, fn, ms, ...rest); }; return "patched"; })()';

const pauseAt = (t) =>
  '(() => { const as = document.getAnimations(); for (const a of as) { try { a.pause(); a.currentTime = ' +
  t +
  '; } catch (e) {} } return as.length; })()';

/** 逐帧读数：纸 / 卷各自的盒、不透明度、卷首文案、块位置（读数与截图同帧，才可对拍）。 */
const GEOM = `(() => {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const sheet = document.querySelector('[data-draft-sheet]');
  const region = [...document.querySelectorAll('.pp-region')].find((e) => !e.hasAttribute('data-draft-sheet'));
  const folio = (el) => (el ? box(el.querySelector('.pp-folio-head')) : null);
  const title = (el) => (el ? (el.querySelector('.pp-folio-eyebrow')?.textContent + ' | ' + el.querySelector('.pp-folio-title')?.textContent) : null);
  return JSON.stringify({
    sheet: sheet ? { box: box(sheet), op: +getComputedStyle(sheet).opacity, folio: folio(sheet), title: title(sheet) } : null,
    region: region ? { box: box(region), op: +getComputedStyle(region).opacity, cls: region.className, folio: folio(region), title: title(region), blocks: region.querySelectorAll('.pp-block').length } : null,
  });
})()`;

function getJson(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let targets;
  try {
    targets = await getJson('/json/list');
  } catch {
    throw new Error(
      `没有可连的浏览器调试口（127.0.0.1:${PORT}）——先起 dev 与无头浏览器：\n` +
        '  cd src-ui && npm run dev\n' +
        `  chrome --headless=new --remote-debugging-port=${PORT} --window-size=1600,1000 about:blank\n` +
        '  （并在其中打开 http://localhost:1420/）',
    );
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('浏览器里没有 page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1200));
    return r.result?.result?.value;
  };

  await send('Page.enable');

  const prep = args.prep ? fs.readFileSync(args.prep, 'utf8') : DEFAULT_PREP;
  const trigger = args.trigger ? fs.readFileSync(args.trigger, 'utf8') : DEFAULT_TRIGGER;

  /* 先**重新导航**：台架要的是「从首页进画布」的完整用户序列；用上一轮遗留的页面状态去
   * 跑 prep 会读到「已经在画布里、纸已经开过」的现场，读出来的帧不是这一拍。 */
  await send('Page.navigate', { url: args.url });
  await sleep(args.settle);

  console.log('prep →', String(await evaluate(prep)).slice(0, 300));
  await evaluate(HIDE_NOISE);
  if (!args.keepTimers) console.log('timers →', await evaluate(FREEZE_TIMERS));

  await evaluate(trigger);
  await sleep(50);

  fs.mkdirSync(args.out, { recursive: true });
  for (const f of fs.readdirSync(args.out)) fs.unlinkSync(path.join(args.out, f));

  const frames = [];
  for (const t of TIMES) {
    const running = await evaluate(pauseAt(t));
    await sleep(60);
    frames.push({ t, animations: running, ...JSON.parse(await evaluate(GEOM)) });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(args.out, `t${String(t).padStart(4, '0')}.png`), Buffer.from(shot.result.data, 'base64'));
  }
  console.log(JSON.stringify(frames, null, 1));
  ws.close();
})().catch((e) => {
  console.error(String(e).slice(0, 3000));
  process.exit(1);
});
