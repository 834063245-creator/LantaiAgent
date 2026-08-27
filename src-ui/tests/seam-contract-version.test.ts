// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// P3-C4 守护：开放面契约文件变更而版本/指纹未更新 = 红。
// 对拍对象：docs/agents/open-surface-contract.md（版本行 + 指纹标记行）；
// 计算逻辑与 CLI（gen:contract-fingerprint）共用 computeContractFingerprint。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeContractFingerprint } from '../scripts/gen-contract-fingerprint';
import { OPEN_SURFACE_CONTRACT_FILES, OPEN_SURFACE_CONTRACT_VERSION } from '../src/composition/contract-version';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_MD = path.resolve(HERE, '..', '..', 'docs', 'agents', 'open-surface-contract.md');

describe('开放面契约版本（P3-C4）', () => {
  it('契约文件清单全部存在（清单与仓库同步）', () => {
    for (const rel of OPEN_SURFACE_CONTRACT_FILES) {
      const abs = path.resolve(HERE, '..', rel);
      expect(
        (() => {
          try {
            readFileSync(abs);
            return true;
          } catch {
            return false;
          }
        })(),
        `契约文件缺失: ${rel}`,
      ).toBe(true);
    }
  });

  it('文档「当前版本」行与 OPEN_SURFACE_CONTRACT_VERSION 对拍', () => {
    const doc = readFileSync(DOC_MD, 'utf8');
    const recorded = Number.parseInt(/^当前版本：(\d+)$/m.exec(doc)?.[1] ?? '', 10);
    expect(
      recorded,
      `docs/agents/open-surface-contract.md 当前版本行（${recorded}）应与 contract-version.ts（${OPEN_SURFACE_CONTRACT_VERSION}）一致`,
    ).toBe(OPEN_SURFACE_CONTRACT_VERSION);
  });

  it('契约文件指纹与文档记录对拍（变更未升版/未更新指纹 = 红）', () => {
    const fp = computeContractFingerprint();
    const doc = readFileSync(DOC_MD, 'utf8');
    const recorded = /<!-- contract-fingerprint: ([0-9a-f]{64}) -->/.exec(doc)?.[1];
    expect(recorded, '文档缺 contract-fingerprint 标记行——运行 npm run gen:contract-fingerprint').toBeDefined();
    expect(recorded, '开放面契约文件已变更而指纹未更新——按 contract-version.ts 头注流程四步同 commit').toBe(
      fp.fingerprint,
    );
  });
});
