// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// manifest JSON Schema 生成/对拍（2026-11-23 契约工具包 · 批 2）。
// 用法：node scripts/gen-plugin-manifest-schema.cjs [--check]（根目录薄壳转发，经 tsx 运行）。
//
// 真源 = src/plugins/types.ts 的 PluginManifestSchema（zod）。产出 draft 2020-12
// 形状，给编辑器补全与第三方工具消费。
//
// **JSON Schema 只表达形状**：跨字段约束（governed 与 restart 的配对、app 入口
// 二态、环回 URL 白名单、退役字段的具名拒绝…）都在 refine / 前置守卫里，
// toJSONSchema 会丢弃——那些一律以 validateManifest / npm run plugin:validate
// 为准（docs/plugins/contract-card.md 写明这条分工）。
//
// 纪律：输出不含时间戳——字节稳定是 --check 守护的前提（同 gen-tool-contract-md）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PluginManifestSchema } from '../src/plugins/types';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..', '..');
const OUT = path.join(ROOT, 'docs', 'plugins', 'manifest.schema.json');

/** 生成物头部说明（放进 $comment：JSON 不允许注释，而这张表要自带「别手改」）。 */
const COMMENT =
  '兰台插件 manifest 形状（生成物，勿手改）。真源 = src-ui/src/plugins/types.ts 的 ' +
  'PluginManifestSchema；重新生成 = npm run gen:plugin-schema。只表达形状：跨字段约束' +
  '（governed 与 restart 的配对、app 入口二态、环回 URL 白名单、退役字段具名拒绝）' +
  '不在本文件里，以 validateManifest / npm run plugin:validate 为准。';

/** 渲染 schema 文本（--check 与写入共用同一份，杜绝两套拼法）。 */
function render(): string {
  const schema = z.toJSONSchema(PluginManifestSchema, { io: 'output' }) as Record<string, unknown>;
  return JSON.stringify({ $comment: COMMENT, ...schema }, null, 2) + '\n';
}

function main(): void {
  const check = process.argv.includes('--check');
  const next = render();
  const rel = path.relative(ROOT, OUT).split(path.sep).join('/');
  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
    if (current === next) {
      console.log(`[ok] plugin-manifest-schema：${rel} 与 schema 一致`);
      return;
    }
    console.error(
      `[plugin-manifest-schema] ${rel} 已漂移——跑 npm run gen:plugin-schema 生成并同 commit` +
        (current === null ? '（文件尚不存在）' : ''),
    );
    process.exit(1);
  }
  writeFileSync(OUT, next, 'utf8');
  console.log(`[ok] plugin-manifest-schema：写入 ${rel}（${next.length} 字节）`);
}

main();
