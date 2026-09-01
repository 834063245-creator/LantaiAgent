// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// P3-C3 守护：事件面（AGENT_EVENT_MAP + 调用点）漂移而
// docs/agents/event-catalog.md 未再生成时红（doc-sync 门禁的同型对拍）。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEventCatalog } from '../scripts/gen-event-catalog';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_MD = path.resolve(HERE, '..', '..', 'docs', 'agents', 'event-catalog.md');

describe('event-catalog 生成物守护', () => {
  // buildEventCatalog 全量扫描事件真源，单跑即 ~5s（默认 5s 预算在套件负载下必炸）——
  // 2026-09-01 目次带窗全量实测假红，放宽预算；逐字节断言不变。
  it('已提交文档与当前事件真源逐字节一致', async () => {
    const expected = await buildEventCatalog();
    let current: string;
    try {
      current = readFileSync(DOC_MD, 'utf8');
    } catch {
      throw new Error(`缺生成物 ${DOC_MD} —— 运行 npm run gen:catalogs:event`);
    }
    if (current !== expected) {
      throw new Error('docs/agents/event-catalog.md 与事件真源不一致 —— 运行 npm run gen:catalogs:event 并同 commit');
    }
    expect(current).toBe(expected);
  }, 30_000);
});
