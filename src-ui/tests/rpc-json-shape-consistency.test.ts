// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// RPC 返回形状 · **跨语言一致性守卫**（2026-09-24 立，源起实机缺陷「引擎开关拨不开」）。
//
// 病灶（真发生过）：`engine_bundled_info` 在 TS 契约里声明了结构化 result
// （`{path,dir,available}`），但 **Rust 出口的 `rpc_result_shape()` 表里没有它**
// ⇒ 落默认臂 `Text` ⇒ 出口把 JSON 当字符串直通；消费面用 `typedRpc`（直通、不 parse）
// 读属性 ⇒ `available` 恒 false ⇒ 设置页开关置灰。既有守卫全绿，因为它守的是
// 名册/桥/契约版本，**没有一条把「契约声明的形状」与「出口的分类」对拍**。
//
// 本守卫钉两条不变量（静态、秒级，读两侧源码文本）：
//   ① 结构化 result 的命令：必须在 Rust JsonValue 表**或**已收编进 rpcResultSchemas
//      （后者消费面走 typedJsonRpc，双形态兼容 ⇒ 字符串线形也不会读成 false）；
//   ② rpcResultSchemas 的每个键都必须在 Rust JsonValue 表内（收编了却没在出口展开
//      = 每次都走 parse 慢路径，且是分类漂移的先兆）。
//
// 反向（有意不钉）：`// JSON` 标注但落 Text 的少数命令（oauth_* / agent_isolation_*）
// 消费面已显式 `parseJson`，属**允许的慢路径**——钉死会把「表外字符串」这条
// 已立法语义（rpc-contract.ts 头部「表外 JSON 命令仍返 JSON 字符串」）判成违规。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rpcResultSchemas } from '../src/rpc-contract';

const CONTRACT = resolve(__dirname, '..', 'src', 'rpc-contract.ts');
const RUST_RPC = resolve(__dirname, '..', '..', 'src-tauri', 'src', 'rpc.rs');

/** 从 Rust `rpc_result_shape()` 表提取形状分类（含多行臂：形状与名字可跨行）。 */
function rustShapeTable(): { json: Set<string>; text: Set<string> } {
  const lines = readFileSync(RUST_RPC, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /fn rpc_result_shape/.test(l));
  if (start < 0) throw new Error('rpc.rs 里找不到 rpc_result_shape()');
  const json = new Set<string>();
  const text = new Set<string>();
  for (let i = start; i < lines.length; i++) {
    if (/^\}/.test(lines[i]) && i > start + 2) break;
    const m = /RpcResultShape::(JsonValue|Text)/.exec(lines[i]);
    if (!m) continue;
    // 名字可出现在本行或紧邻的上一行（多行臂形态）。
    for (let k = Math.max(start, i - 1); k <= i; k++) {
      for (const q of lines[k].matchAll(/"([a-z_][a-z0-9_]*)"/g)) {
        (m[1] === 'JsonValue' ? json : text).add(q[1]);
      }
    }
  }
  return { json, text };
}

/** 契约里各命令声明的 result 类型（块级解析：只在方法块内取 `result:` 段）。 */
function contractResultTypes(): Map<string, string> {
  const lines = readFileSync(CONTRACT, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /interface RpcContract/.test(l));
  if (start < 0) throw new Error('rpc-contract.ts 里找不到 interface RpcContract');
  const out = new Map<string, string>();
  let depth = 0;
  let cur: string | null = null;
  let buf: string[] = [];
  const finish = () => {
    if (!cur) return;
    const block = buf.join(' ');
    const t = /result:\s*([^;]+)/.exec(block);
    if (t) out.set(cur, t[1].replace(/\}[\s}]*$/, '').trim());
    cur = null;
    buf = [];
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (cur === null) {
      const m = /^\s{2}([a-z_][a-z0-9_]*):\s*\{/.exec(line);
      if (m && depth === 1) {
        cur = m[1];
        buf = [line];
        depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
        if (depth <= 1) finish();
        continue;
      }
      const m2 = /^\s{2}([a-z_][a-z0-9_]*):.*?result:\s*([^;]+);/.exec(line);
      if (m2) out.set(m2[1], m2[2].trim());
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      continue;
    }
    buf.push(line);
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (depth <= 1) finish();
  }
  return out;
}

/** 结构化 = 对象/数组字面量类型（字符串、number、void、联合了 null 的标量都算非结构化）。 */
function isStructured(type: string): boolean {
  const t = type.replace(/\s+/g, ' ').trim();
  if (t.startsWith('{') || t.startsWith('[')) return true;
  return /[|&]\s*\{/.test(t) || /Array</.test(t) || /\[.*\]\s*$/.test(t);
}

describe('RPC 形状跨语言一致性（engine_bundled_info 实机缺陷守卫）', () => {
  const { json, text } = rustShapeTable();
  const types = contractResultTypes();

  it('两侧源码都被解析到（解析器本身不许静默空转）', () => {
    expect(json.size, 'Rust JsonValue 表解析为空').toBeGreaterThan(5);
    expect(types.size, '契约方法解析为空').toBeGreaterThan(30);
  });

  it('① 结构化 result 的命令：必须在 Rust JsonValue 表，或已收编进 rpcResultSchemas', () => {
    const offenders: string[] = [];
    for (const [name, type] of types) {
      if (!isStructured(type)) continue;
      if (json.has(name)) continue;
      if (name in rpcResultSchemas) continue;
      offenders.push(`${name}: ${type.slice(0, 60)}`);
    }
    expect(
      offenders,
      '这些命令声明了结构化返回，却既没在 Rust rpc_result_shape() 里展开、也没收编进 ' +
        'rpcResultSchemas ⇒ 出口按 Text 直通字符串，消费面读属性会静默得到 undefined' +
        '（= 「随包引擎开关拨不开」同款）。修法二选一：加 Rust 表项 / 收编 typedJsonRpc。',
    ).toEqual([]);
  });

  it('② rpcResultSchemas 的每个键都在 Rust JsonValue 表内', () => {
    const missing = Object.keys(rpcResultSchemas).filter((k) => !json.has(k));
    expect(missing, '收编了却没在出口展开 ⇒ 恒走 parse 慢路径，且是分类漂移先兆').toEqual([]);
  });

  it('③ 已知 JSON 命令的抽样分类不回退（钉住 engine_bundled_info 的修复）', () => {
    for (const name of ['engine_bundled_info', 'workspace_list', 'plugin_data_ensure', 'plugin_data_list']) {
      expect(json.has(name), `${name} 必须分类为 JsonValue`).toBe(true);
      expect(text.has(name), `${name} 不该出现在 Text 显式列`).toBe(false);
    }
  });
});
