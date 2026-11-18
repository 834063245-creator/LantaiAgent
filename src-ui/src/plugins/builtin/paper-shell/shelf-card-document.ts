// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// shelf-card-document — 架阁卡片详图的沙箱文档（docs/plans/entity-shelf-plan.md B4）
//
// 与 renderers 产物的 `buildHtmlCardDocument` **同规格**（CSP 三要素 / sandbox
// `allow-scripts` / 禁导航禁表单 / 高度回报逐字同款），差别只有一处：
// **状态桥对面是卡片库**（`card_state_write` RPC），不是会话级 `asset-state`——
// 入阁的卡不属任何会话，写回会话键就等于把库里的卡又绑回某一次对话。
//
// 为什么在 paper-shell 里自备一份而不是 import renderers 的：
// 两个都是产物，跨产物 import 会被 esbuild 内联成第二份实现（同一份模板两份状态桥），
// 而这份文档的**唯一差别**就是状态通道——共用一份反而要参数化注入函数，得不偿失。
// 两处 CSP 若有一处改动，`tests/shelf-card-document.test.ts` 会对拍 head 段。

/** 卡内代码上限（与 renderers 同值——同一类内容，同一个尺子）。 */
const HTML_CARD_MAX_BYTES = 512 * 1024;
/** 底部呼吸（投影场域，与 renderers 同值）。 */
const HTML_CARD_BOTTOM_BREATH = 72;

export const SHELF_CARD_RESIZE_NS = 'lantai.card-resize';
export const SHELF_CARD_PING = 'lantai.card-ping';
/** 状态桥协议（子 → 父 {type, req, op, patch?}；父 → 子 {type, req, ok, state?|error?}）。 */
export const SHELF_CARD_STATE_NS = 'lantai.card-state';
export const SHELF_CARD_STATE_TIMEOUT_MS = 2000;

/** 生成架阁卡片详图的 iframe 文档（HTML 片段 → 完整沙箱文档）。 */
export function buildShelfCardDocument(code: string): string {
  const safeCode = code.length > HTML_CARD_MAX_BYTES ? code.slice(0, HTML_CARD_MAX_BYTES) : code;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html { background: transparent; }
body { padding: 8px 12px ${HTML_CARD_BOTTOM_BREATH}px; font-family: var(--f-song, serif); color: var(--ink-1, #26221c); }
svg { display: block; max-width: 100%; }
</style>
</head>
<body>
${safeCode}
<script>
(function () {
  var NS = '${SHELF_CARD_RESIZE_NS}';
  var STATE_NS = '${SHELF_CARD_STATE_NS}';
  var last = 0;
  function report() {
    var h = document.documentElement.scrollHeight;
    if (h !== last) { last = h; window.parent.postMessage({ type: NS, height: h }, '*'); }
  }
  if (document.readyState === 'complete') report();
  else window.addEventListener('load', report);
  new ResizeObserver(function () { report(); }).observe(document.body);
  // 状态桥（架阁版）：window.lantai.state 的对面是**卡片库**——同一张卡无论从哪卷
  // 打开，读到/写回的都是库里的那一份（不是某次会话的 asset-state）。
  var reqSeq = 0;
  var pending = {};
  function stateRequest(op, patch) {
    return new Promise(function (resolve, reject) {
      var req = ++reqSeq;
      var timer = setTimeout(function () {
        delete pending[req];
        reject(new Error('宿主无响应（状态 ' + op + ' 超时）'));
      }, ${SHELF_CARD_STATE_TIMEOUT_MS});
      pending[req] = { resolve: resolve, reject: reject, timer: timer };
      var msg = { type: STATE_NS, req: req, op: op };
      if (op === 'patch') msg.patch = patch;
      window.parent.postMessage(msg, '*');
    });
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d === '${SHELF_CARD_PING}') { last = 0; report(); return; }
    if (d && typeof d === 'object' && d.type === STATE_NS && typeof d.req === 'number' && pending[d.req]) {
      var p = pending[d.req];
      delete pending[d.req];
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.state);
      else p.reject(new Error(typeof d.error === 'string' ? d.error : '卡片库拒绝'));
    }
  });
  window.lantai = window.lantai || {};
  window.lantai.state = {
    get: function () { return stateRequest('get'); },
    patch: function (patch) { return stateRequest('patch', patch); }
  };
})();
</script>
</body>
</html>`;
}
