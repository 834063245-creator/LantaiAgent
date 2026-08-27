// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// P1/C2 守护：工具面（ToolRegistry 装配产物）漂移而
// docs/agents/model-tool-contract.md 未再生成时红。
//
// 与 C2 判据字面的偏差（如实记录，见 agent-plugin-architecture-plan §3 P1）：
// ci.yml 冻结且 frontend job 只跑 tsc --noEmit + vite build，「CI 红」字面不可达，
// 故守护落 vitest + 独立 npm script（check:tool-contract），不挂 CI、不进 build 链。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildContractMarkdown } from '../scripts/gen-tool-contract-md';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_MD = path.resolve(HERE, '..', '..', 'docs', 'agents', 'model-tool-contract.md');

describe('model-tool-contract 生成物守护', () => {
  // timeout 显式放宽：全量并行负载下 buildToolRegistry 装配可超 vitest 缺省 5s
  // （对拍本身是确定性的，只有时间是变量）。
  it('已提交文档与当前装配产物逐字节一致', { timeout: 60_000 }, async () => {
    const expected = await buildContractMarkdown();
    let current: string;
    try {
      current = readFileSync(DOC_MD, 'utf8');
    } catch {
      throw new Error(`缺生成物 ${DOC_MD} —— 运行 npm run gen:tool-contract`);
    }
    if (current !== expected) {
      throw new Error(
        'docs/agents/model-tool-contract.md 与 ToolRegistry 装配产物不一致 —— ' +
          '运行 npm run gen:tool-contract 并与工具面变更同 commit',
      );
    }
    expect(current).toBe(expected);
  });
});
