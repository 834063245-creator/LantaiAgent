// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 开放面契约指纹生成/对拍（平台化 Phase 3 · P3-C4）。
// 用法：node scripts/gen-contract-fingerprint.cjs [--check]
//（根目录薄壳转发，经 tsx 运行；等价 npm script：gen:contract-fingerprint /
// check:contract-fingerprint）。
//
// 指纹 = OPEN_SURFACE_CONTRACT_FILES（contract-version.ts 单一真源）逐文件
// sha256 + 清单整体 sha256，写进 docs/agents/open-surface-contract.md 的
// `<!-- contract-fingerprint: … -->` 标记行（gen 模式原地更新；--check 模式
// 与已记录值对拍，漂移即非零退出）。版本号不由本脚本改——升版是人工决策，
// 流程见 contract-version.ts 头注。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OPEN_SURFACE_CONTRACT_FILES, OPEN_SURFACE_CONTRACT_VERSION } from '../src/composition/contract-version';

const SRC_UI = path.resolve(import.meta.dirname ?? '.', '..');
const ROOT = path.resolve(SRC_UI, '..');
const DOC = path.join(ROOT, 'docs', 'agents', 'open-surface-contract.md');
const MARKER_RE = /<!-- contract-fingerprint: ([0-9a-f]{64}|PLACEHOLDER) -->/;

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface ContractFingerprint {
  version: number;
  files: Array<{ path: string; hash: string }>;
  fingerprint: string;
}

/** 计算当前契约指纹（guard 测试与 CLI 共用）。 */
export function computeContractFingerprint(): ContractFingerprint {
  const files = OPEN_SURFACE_CONTRACT_FILES.map((rel) => {
    const abs = path.join(SRC_UI, rel);
    if (!existsSync(abs)) {
      throw new Error(`契约文件缺失: ${rel}——更新 contract-version.ts 的文件清单`);
    }
    return { path: rel, hash: sha256(readFileSync(abs)) };
  });
  // 整体指纹 = 版本 + 清单序 + 逐文件哈希的复合（任一变更 → 指纹变）
  const composite = sha256(
    JSON.stringify({ version: OPEN_SURFACE_CONTRACT_VERSION, files }) + OPEN_SURFACE_CONTRACT_VERSION,
  );
  return { version: OPEN_SURFACE_CONTRACT_VERSION, files, fingerprint: composite };
}

function recordedFingerprint(doc: string): string | null {
  return MARKER_RE.exec(doc)?.[1] ?? null;
}

function renderMarker(fp: ContractFingerprint): string {
  return `<!-- contract-fingerprint: ${fp.fingerprint} -->`;
}

function main() {
  const check = process.argv.includes('--check');
  const fp = computeContractFingerprint();
  if (!existsSync(DOC)) {
    console.error(`[contract-fingerprint] 缺对拍文档：${DOC}`);
    process.exit(1);
  }
  const doc = readFileSync(DOC, 'utf8');
  const recorded = recordedFingerprint(doc);
  const versionLine = /^当前版本：(\d+)$/m.exec(doc);
  if (check) {
    if (recorded !== fp.fingerprint) {
      console.error(
        '[contract-fingerprint] 开放面契约文件已变更而指纹未更新——' +
          '按 contract-version.ts 头注流程：bump 版本 + 变更记录加行 + npm run gen:contract-fingerprint',
      );
      process.exit(1);
    }
    const docVersion = versionLine?.[1] ? Number.parseInt(versionLine[1], 10) : null;
    if (docVersion !== fp.version) {
      console.error(
        `[contract-fingerprint] 版本不对拍：contract-version.ts = ${fp.version}，文档 = ${docVersion}` +
          '——同步 docs/agents/open-surface-contract.md 的「当前版本」行',
      );
      process.exit(1);
    }
    console.log(`[ok] 开放面契约 v${fp.version} 指纹对拍一致`);
    return;
  }
  if (recorded == null) {
    console.error('[contract-fingerprint] 文档缺 contract-fingerprint 标记行——人工补一行后重跑');
    process.exit(1);
  }
  writeFileSync(DOC, doc.replace(MARKER_RE, renderMarker(fp)), 'utf8');
  console.log(`[ok] contract-fingerprint 更新（v${fp.version}，${fp.files.length} 文件）`);
}

if (!process.env.VITEST) {
  main();
}
