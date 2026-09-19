// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// worker bootstrap 源码（字符串形态，自包含零依赖）。
//
// 为什么是字符串：P2 spike（docs/research/_r5-web-worker-csp-spike.md）实测
// webview 无 CSP，blob module worker 可行，但 worker 内无法 import 宿主模块
// （裸说明符不可解析）——bootstrap 必须自包含。字符串源码经 Blob → Worker
// 实例化，与 vite chunk 并行存在；本文件是它的单一事实源，测试在 fake port
// 上 eval 同一份源码做全链路验证（DSH bootstrap「plain functions over an
// injected port」哲学：逻辑全提成纯函数，真 worker 只是壳）。
//
// 执行形态：宿主发 {t:'run', code, names, maxOutputBytes} → worker 用
// AsyncFunction 构造器执行程序体（top-level await + return 可用），
// `tools`（null-prototype 绑定命名空间）与 `console`（五方法 shim）以参数
// 注入——程序体不接触 self.postMessage 原语（源码级隔离，纵深防御一层）。
//
// 完成值形态（2026-09-19）：字符串完成值原样出（文本本体——不再 JSON.stringify
// 那一层转义），其余值出无损 JSON 文本；两者都算「无损」才是合法落定。
// 日志渲染 = 有界 inspect（深度/条目封顶 + 循环标记 + Error 取栈）。
//
// 预算纪律（对齐 DSH LogBuffer）：logs + 完成值共享一个字节预算，
// JSON 序列化形态计账（含字符串转义），耗尽即截断并上报 output-limit；
// 日志先行——每条 log 即时 postMessage，中途被杀也不丢已发日志。

/** worker 源码。所有依赖闭包内自持；无任何 import。 */
export const WORKER_BOOTSTRAP_SOURCE = String.raw`
'use strict';
(function () {
  function post(msg) {
    try { self.postMessage(msg); } catch (e) { /* 通道死亡：宿主会 terminate */ }
  }

  var replied = new Set(); // 已结算的 call id（一次性纪律）
  var pending = new Map(); // id → {resolve, reject}
  var nextId = 1;
  var budget = Infinity;
  var limitReported = false;
  var started = false;
  var usedBytes = 2; // "[]" 空数组序列化形态
  var logEntries = 0;

  // 单一分发器：reply 与 run 共口（self.onmessage 只赋值一次——
  // 后赋覆盖前赋会把 reply 处理器丢掉，程序调用永不返回）
  self.onmessage = function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'reply') {
      if (typeof m.id !== 'number' || replied.has(m.id)) return; // 重复/未知 id 忽略（worker 侧对称纪律）
      replied.add(m.id);
      var entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id);
      if (m.ok) entry.resolve(m.value);
      else entry.reject(new Error(m.message || 'tool call failed'));
      return;
    }
    if (m.t === 'run') {
      if (started) return; // 只跑一次
      started = true;
      handleRun(m);
    }
  };

  function byteLen(s) {
    // UTF-8 计长：BMP 外按 4 字节（代理对），与宿主 TextEncoder 对齐
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c <= 0x7f) n += 1;
      else if (c <= 0x7ff) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else if (c >= 0xdc00 && c <= 0xdfff) n += 3; // 落单代理：宿主侧会替换 U+FFFD
      else n += 3;
    }
    return n;
  }

  function jsonLen(text) { return byteLen(JSON.stringify(text)); }

  // 日志缓冲：预算内逐条即发；耗尽发 fitting prefix + output-limit 一次
  function pushLog(text) {
    if (limitReported) return;
    var cost = jsonLen(text) + (logEntries > 0 ? 1 : 0);
    if (usedBytes + cost > budget) {
      var avail = budget - usedBytes - (logEntries > 0 ? 1 : 0);
      var t = text;
      while (t.length > 0 && jsonLen(t) > avail) t = t.slice(0, Math.max(0, t.length - 64));
      if (t.length > 0 && jsonLen(t) <= avail) { usedBytes += jsonLen(t) + (logEntries > 0 ? 1 : 0); logEntries++; post({ t: 'log', text: t }); }
      limitReported = true;
      post({ t: 'output-limit' });
      return;
    }
    usedBytes += cost;
    logEntries++;
    post({ t: 'log', text: text });
  }

  // console shim：五方法，有界 inspect 渲染（无 util.inspect——降级为自带的
  // renderValue：深度/条目封顶 + 循环标记 + Error 取栈 + 不可读值兜底）。
  // 2026-09-19 换代：旧实现是无封顶 JSON.stringify，注释承诺的「深度封顶」并不
  // 存在——深对象炸成单行巨串，循环引用掉进 String(a) 变 '[object Object]'
  // （信息静默丢失），Error 对象 stringify 成 '{}'（栈全丢）。
  var INSPECT_DEPTH = 4;
  var INSPECT_ITEMS = 50;
  function renderValue(v, depth, seen) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'undefined') return 'undefined';
    if (t === 'function') return '[Function]';
    if (t === 'symbol' || t === 'bigint') return String(v);
    if (seen.indexOf(v) >= 0) return '[Circular]';
    if (depth >= INSPECT_DEPTH) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen.push(v);
    var out;
    try {
      if (Array.isArray(v)) {
        var items = [];
        var n = Math.min(v.length, INSPECT_ITEMS);
        for (var i = 0; i < n; i++) items.push(renderValue(v[i], depth + 1, seen));
        if (v.length > n) items.push('… +' + (v.length - n));
        out = '[' + items.join(', ') + ']';
      } else if (v instanceof Error) {
        // Error 不是可枚举对象：取栈（模型最需要的诊断面）
        out = v.stack || (v.name + ': ' + v.message);
      } else {
        var keys = Object.keys(v);
        var kvs = [];
        var m = Math.min(keys.length, INSPECT_ITEMS);
        for (var j = 0; j < m; j++) {
          var k = keys[j];
          var s;
          try { s = renderValue(v[k], depth + 1, seen); } catch (e) { s = '[unreadable]'; }
          kvs.push(k + ': ' + s);
        }
        if (keys.length > m) kvs.push('… +' + (keys.length - m));
        out = '{' + kvs.join(', ') + '}';
      }
    } finally {
      seen.pop(); // 路径栈（非全局集合）：共享引用照常渲染，只有真环被标
    }
    return out;
  }
  function renderArg(a) {
    try {
      return renderValue(a, 0, []);
    } catch (e) {
      return '[unrenderable value]';
    }
  }
  var consoleShim = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
  function noop() {}
  function makeConsole() {
    function mk() { return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(renderArg(arguments[i]));
      pushLog(parts.join(' '));
    }; }
    consoleShim.log = mk(); consoleShim.info = mk(); consoleShim.warn = mk(); consoleShim.error = mk(); consoleShim.debug = mk();
  }
  makeConsole();

  // tools 命名空间：null-prototype，绑定名一律 defineProperty（防
  // __proto__/constructor 原型碰撞——DSH 同款纪律）
  function makeTools(names) {
    var ns = Object.create(null);
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        Object.defineProperty(ns, name, {
          enumerable: true,
          value: function (args) {
            // 参数无损 JSON 预检（宿主还会再验一次——纵深防御）
            var norm;
            try {
              var text = JSON.stringify(args === undefined ? {} : args);
              if (text === undefined) return Promise.reject(new Error('tool arguments must be lossless JSON'));
              norm = JSON.parse(text);
            } catch (e) {
              return Promise.reject(new Error('tool arguments must be lossless JSON: ' + (e && e.message)));
            }
            return new Promise(function (resolve, reject) {
              var id = nextId++;
              pending.set(id, { resolve: resolve, reject: reject });
              post({ t: 'call', id: id, name: name, args: norm });
            });
          },
        });
      })(names[i]);
    }
    return ns;
  }

  // run 指令处理：一次程序体执行（从分发器调入）
  function handleRun(m) {
    if (typeof m.code !== 'string' || !Array.isArray(m.names)) return;
    budget = typeof m.maxOutputBytes === 'number' && m.maxOutputBytes > 0 ? m.maxOutputBytes : Infinity;

    var AsyncFunction = (async function () {}).constructor;
    var tools = makeTools(m.names);
    var fn;
    try {
      fn = new AsyncFunction('tools', 'console', "'use strict';\n" + m.code);
    } catch (e) {
      post({ t: 'done', error: { kind: 'exception', message: 'SyntaxError: ' + (e && e.message) } });
      return;
    }

    fn(tools, consoleShim).then(
      function (value) {
        var out = {};
        if (value !== undefined) {
          // 字符串完成值 = 文本本体（2026-09-19 程文输出换代）：不再过
          // JSON.stringify——那一层把真换行编码成字面 \n、把引号编码成 \"、
          // Windows 路径 \?\D:\ 变 \\?\\D:\（真机实况：40 行目录清单塌成
          // 一行 2678 字符，模型与纸面双双白付 10.1% 字符的转义噪音）。
          // 非字符串仍走无损 JSON 文本（对象/数组/字面量的既有契约不变）。
          var text;
          if (typeof value === 'string') {
            text = value;
          } else {
            try {
              text = JSON.stringify(value);
            } catch (e) {
              post({ t: 'done', error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } });
              return;
            }
            if (text === undefined) {
              post({ t: 'done', error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } });
              return;
            }
          }
          // 完成值与日志共享预算：剩余不足 → output-limit
          if (jsonLen(text) > budget - usedBytes) {
            post({ t: 'done', error: { kind: 'output-limit', message: 'outer output exceeded ' + budget + ' bytes' } });
            return;
          }
          out.value = text;
        }
        post({ t: 'done', value: out.value });
      },
      function (err) {
        var msg;
        try {
          var detail = err instanceof Error ? (err.stack || err.message) : err;
          msg = typeof detail === 'string' ? detail : String(detail);
        } catch (e) { msg = 'program threw an unrenderable value'; }
        post({ t: 'done', error: { kind: 'exception', message: msg } });
      }
    );
  }
})();
`;

/**
 * 在 fake port 上引导 bootstrap 逻辑（测试通道 — 与真实 worker 同一份源码）。
 * 返回 port 适配器：入站经 post()（宿主 reply），出站经 onmessage 回调。
 */
export function evalBootstrapSource(source: string, onOut: (msg: unknown) => void): { post(msg: unknown): void } {
  const self = {
    postMessage: (msg: unknown) => onOut(msg),
    onmessage: null as ((ev: { data: unknown }) => void) | null,
  };
  const fn = new Function('self', source) as (selfObj: unknown) => void;
  fn(self);
  return {
    post(msg: unknown) {
      self.onmessage?.({ data: msg });
    },
  };
}
