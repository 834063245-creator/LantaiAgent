// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// P3-C3 守护：ctx 服务面（组合层源码事实）漂移而
// docs/agents/service-catalog.md 未再生成时红（doc-sync 门禁的同型对拍）。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildServiceCatalog } from '../scripts/gen-service-catalog';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_MD = path.resolve(HERE, '..', '..', 'docs', 'agents', 'service-catalog.md');

describe('service-catalog 生成物守护', () => {
  it('已提交文档与当前源码事实逐字节一致', () => {
    const expected = buildServiceCatalog();
    let current: string;
    try {
      current = readFileSync(DOC_MD, 'utf8');
    } catch {
      throw new Error(`缺生成物 ${DOC_MD} —— 运行 npm run gen:catalogs:service`);
    }
    if (current !== expected) {
      throw new Error(
        'docs/agents/service-catalog.md 与组合层源码事实不一致 —— ' + '运行 npm run gen:catalogs:service 并同 commit',
      );
    }
    expect(current).toBe(expected);
  });
});
