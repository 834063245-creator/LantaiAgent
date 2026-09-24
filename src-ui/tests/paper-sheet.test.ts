// SPDX-License-Identifier: MIT

// paper/sheet 纯函数——同卷恒同纸（确定性）/ 值域合法 / 卷卷大概率不重样。

import { describe, expect, it } from 'vitest';
import { sheetCharacter } from '../src/plugins/builtin/paper-shell/sheet';

describe('paper/sheet 流区纸性', () => {
  it('同卷恒同纸（确定性——重启/换页不换脸）', () => {
    expect(sheetCharacter('session-abc')).toEqual(sheetCharacter('session-abc'));
  });

  it('值域合法：相位 [0,1024) 整数、j ∈ [0,1)', () => {
    for (const id of ['a', 'x-1', 'session-42', '卷一', '']) {
      const s = sheetCharacter(id);
      expect(s.ox).toBeGreaterThanOrEqual(0);
      expect(s.ox).toBeLessThan(1024);
      expect(Number.isInteger(s.ox)).toBe(true);
      expect(s.oy).toBeGreaterThanOrEqual(0);
      expect(s.oy).toBeLessThan(1024);
      expect(Number.isInteger(s.oy)).toBe(true);
      expect(s.j).toBeGreaterThanOrEqual(0);
      expect(s.j).toBeLessThan(1);
    }
  });

  it('卷卷大概率不重样：20 卷相位组合至多 1 对撞（1M 相位空间）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = sheetCharacter(`session-${i}`);
      seen.add(`${s.ox},${s.oy}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(19);
  });
});
