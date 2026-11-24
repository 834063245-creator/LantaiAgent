// Copyright (c) 2026 Wenbing Jing. MIT License. SPDX-License-Identifier: MIT

// fs(list) 模型面整形（2026-11-24 B 案）——`{entries}` 树 → 逐行文本树。
//
// 钉四件事：
//   ① 形状：首行 `<root> — N 项`、目录尾 `/`、两空格一层、目录先且名字升序；
//   ② 路径卫生：`\\?\` 扩展前缀与反斜杠在模型面消失（根路径归一）；
//   ③ 预算：>FULL_TREE_LIMIT 收窄成两层地图，末行交代「已列 X / 共 N」；
//   ④ 违形不静默：非契约 JSON 返回 null（provider 直通原文，不改写）。

import { describe, expect, it } from 'vitest';
import { builtinFsProvider } from '../src/plugins/builtin/fs-builtin';
import { FULL_TREE_LIMIT, formatListPayload, MAP_CHILD_LIMIT } from '../src/plugins/builtin/fs-builtin/list-format';

type Entry = {
  name: string;
  path: string;
  is_dir: boolean;
  children: Entry[] | null;
  truncated?: boolean;
};

function file(name: string, dir = 'D:/ws/docs'): Entry {
  return { name, path: `${dir}/${name}`, is_dir: false, children: null };
}

function dir(name: string, children: Entry[] | null, dirPath = 'D:/ws/docs'): Entry {
  return { name, path: `${dirPath}/${name}`, is_dir: true, children };
}

const SMALL = JSON.stringify({
  entries: [file('landmine-map.md'), dir('adr', [file('b.md', 'D:/ws/docs/adr'), file('a.md', 'D:/ws/docs/adr')])],
});

describe('formatListPayload：小树全量展开', () => {
  it('首行根路径 + 条目数；目录先、名字升序；目录尾 `/`；两空格一层', () => {
    const out = formatListPayload(SMALL, 'D:/ws/docs');
    expect(out).toBe(['D:/ws/docs — 4 项', 'adr/', '  a.md', '  b.md', 'landmine-map.md'].join('\n'));
  });

  it('Windows 扩展前缀 `\\\\?\\` 与反斜杠不进模型面', () => {
    const out = formatListPayload(SMALL, '\\\\?\\D:\\ws\\docs');
    expect(out?.split('\n')[0]).toBe('D:/ws/docs — 4 项');
  });

  it('空目录：只有首行（0 项）', () => {
    expect(formatListPayload('{"entries":[]}', 'D:/ws/empty')).toBe('D:/ws/empty — 0 项');
  });

  it('缺省根：首行只报条目数（不编造路径）', () => {
    expect(formatListPayload(SMALL)?.split('\n')[0]).toBe('4 项');
  });
});

describe('formatListPayload：超预算收窄成两层地图', () => {
  /** 一棵超预算的树：一个目录 + 700 个文件 = 701 条。 */
  const WIDE_FILES = 700;
  const wide = JSON.stringify({
    entries: [
      dir(
        'src',
        Array.from({ length: WIDE_FILES }, (_, i) => file(`f${String(i).padStart(4, '0')}.ts`, 'D:/ws/docs/src')),
      ),
    ],
  });

  it('只展开两层，并在末行交代「已列 X / 共 N」', () => {
    const out = formatListPayload(wide, 'D:/ws/docs') ?? '';
    const rows = out.split('\n');
    expect(rows[0]).toBe(`D:/ws/docs — ${WIDE_FILES + 1} 项`);
    expect(rows[1]).toBe('src/');
    // 每目录封顶 MAP_CHILD_LIMIT，余量报数
    expect(rows).toHaveLength(2 + MAP_CHILD_LIMIT + 1 + 1); // 首行 + src/ + 子项 + 「… +K 项未列」 + 末行
    expect(rows[2 + MAP_CHILD_LIMIT]).toBe(`  … +${WIDE_FILES - MAP_CHILD_LIMIT} 项未列`);
    expect(rows[rows.length - 1]).toBe(
      `… 树较大：已列 ${1 + MAP_CHILD_LIMIT} / ${WIDE_FILES + 1} 项（只展开两层）；传更窄的 path 继续。`,
    );
  });

  it('正好等于上限时仍全量展开（边界不提前收窄）', () => {
    const atLimit = JSON.stringify({
      entries: Array.from({ length: FULL_TREE_LIMIT }, (_, i) => file(`f${i}.ts`)),
    });
    const out = formatListPayload(atLimit, 'D:/ws/docs') ?? '';
    expect(out.split('\n')).toHaveLength(FULL_TREE_LIMIT + 1);
    expect(out).not.toContain('树较大');
  });

  it('Rust 2000 条上限命中（entries[0].truncated）：末行交代「已截断」，读数不骗人', () => {
    const src = dir(
      'src',
      Array.from({ length: 700 }, (_, i) => file(`f${i}.ts`, 'D:/ws/docs/src')),
    );
    const capped = JSON.stringify({ entries: [{ ...src, truncated: true }] });
    const rows = (formatListPayload(capped, 'D:/ws/docs') ?? '').split('\n');
    expect(rows.at(-1)).toBe('… 目录树达 2000 条上限，已截断（更细的层级用更窄的 path 继续）。');
  });
});

describe('formatListPayload：违形回 null（调用方直通原文）', () => {
  it.each([
    ['非 JSON', 'not json at all'],
    ['非对象', '[]'],
    ['缺 entries', '{"tree":[]}'],
    ['entries 非数组', '{"entries":{}}'],
    ['条目缺 is_dir', '{"entries":[{"name":"x","children":null}]}'],
    ['children 既非 null 也非数组', '{"entries":[{"name":"x","is_dir":true,"children":"y"}]}'],
    ['嵌套条目违形', '{"entries":[{"name":"x","is_dir":true,"children":[{"name":"y"}]}]}'],
  ])('%s → null', (_label, raw) => {
    expect(formatListPayload(raw, 'D:/ws')).toBeNull();
  });
});

describe('builtinFsProvider(list)：整形在 provider 层，线格式违形直通', () => {
  const call = (raw: string, path = 'D:/ws/docs') =>
    builtinFsProvider.execute('list', { path }, { dispatch: async () => raw });

  it('fs_cap 的 {entries} → 文本树', async () => {
    await expect(call(SMALL)).resolves.toBe(
      ['D:/ws/docs — 4 项', 'adr/', '  a.md', '  b.md', 'landmine-map.md'].join('\n'),
    );
  });

  it('违形载荷原样返回（可见，不改写成空树）', async () => {
    const raw = '{"entries":[{"name":"x"}]}';
    await expect(call(raw)).resolves.toBe(raw);
  });

  it('dispatch 收到的是 fs_cap list + 原 path（整形不接管协议）', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    await builtinFsProvider.execute(
      'list',
      { path: 'D:/ws/docs', filterIgnored: false },
      {
        dispatch: async (name, args) => {
          seen.push({ name, args: args as Record<string, unknown> });
          return '{"entries":[]}';
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('fs_cap');
    expect(seen[0].args).toMatchObject({ action: 'list', path: 'D:/ws/docs', filter_ignored: false });
  });
});
