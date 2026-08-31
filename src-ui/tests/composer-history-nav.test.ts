// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// B5（2026-08-27）：输入历史导航纯函数——原实现每次 ↑ 都取
// history[length-1]（永远同一条），inputHistoryIdx 全工程无读者。
// navigateHistory 接管：↑ 回退 / ↓ 前进 / 越出最新恢复草稿（由调用方处理）。

import { describe, expect, it } from 'vitest';
import { navigateHistory } from '../src/plugins/builtin/compose-dock/ComposerDock';

describe('navigateHistory（输入历史导航）', () => {
  const history = ['first', 'second', 'third']; // 旧 → 新（尾部 = 最近）

  it('live 态（idx=-1）按 ↑ → 最新一条', () => {
    const { entry } = navigateHistory(history, -1, -1);
    expect(entry).toEqual({ idx: 2, text: 'third' });
  });

  it('连续 ↑ 逐条回退', () => {
    expect(navigateHistory(history, 2, -1).entry).toEqual({ idx: 1, text: 'second' });
    expect(navigateHistory(history, 1, -1).entry).toEqual({ idx: 0, text: 'first' });
  });

  it('最老一条再 ↑ → null（不动）', () => {
    expect(navigateHistory(history, 0, -1).entry).toBeNull();
  });

  it('↓ 前进：旧 → 新方向', () => {
    expect(navigateHistory(history, 0, 1).entry).toEqual({ idx: 1, text: 'second' });
  });

  it('最新一条再 ↓ → null（调用方恢复草稿、退出历史浏览）', () => {
    expect(navigateHistory(history, 2, 1).entry).toBeNull();
  });

  it('空历史 → 恒 null', () => {
    expect(navigateHistory([], -1, -1).entry).toBeNull();
    expect(navigateHistory([], 0, 1).entry).toBeNull();
  });

  it('单条历史：live ↑ 命中，再 ↓ 越出', () => {
    const one = ['only'];
    expect(navigateHistory(one, -1, -1).entry).toEqual({ idx: 0, text: 'only' });
    expect(navigateHistory(one, 0, 1).entry).toBeNull();
  });
});
