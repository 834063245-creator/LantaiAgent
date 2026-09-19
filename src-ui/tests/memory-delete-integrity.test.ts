// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 记忆删除完整性（2026-09-20 事故复现）：删掉的记忆不死。
//
// 用户可见症状两条：
//   ① 盘上 —— `.lantai/memory/<name>.md` 没被删，只被改写成墓碑
//      `{"deleted":true}`（16 字节），永久留在盘上；
//   ② 提示面 —— 墓碑残渣混进**每次会话**的记忆注入：新会话的 system prompt
//      记忆段里挂着 `- **** — {"deleted":true}`（索引行还在 → loadPromptSection
//      照索引读墓碑文件 → 无 frontmatter → 走 parseFrontmatter 兜底
//      confidence='reference' ≠ 'suppressed' → 进注入）。
//
// 真机证据（.lantai/sessions/19.ndjson，2026-09-19）：
//   seq=379..384 六条 `memory delete` 落在同一毫秒 22:38:14.423/424（同一批
//   工具调用，StreamingToolExecutor.addTool 立即并发派发，无写串行化）；
//   .lantai/memory 里同秒落下 6 枚 16 字节墓碑，而 MEMORY.md 索引只掉了 1 行
//   —— 6 个并发「读索引 → 删自己那行 → 全量写回」互相覆盖，最后一个写者赢。
//
// 本文件锁死两条不变量：删除必须真删（文件消失）；批量删除后索引不得复活。
// mock 站到 rpc-contract 具名 helper 层（内存 fs，契约见 tests/helpers/kernel-fs.ts）。
//
// 修复（2026-09-20，同批）：delete 改真删（kernelDeleteFile，与全仓已退役的墓碑
// 语义对齐）；MEMORY.md 读-改-写经 enqueueIndexWrite 串行化；读侧加记忆判据
// （isMemoryText，必须带 frontmatter）——索引残留行再脏也进不了注入面与列表。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { createMemoryTools, MemoryManager } from '../src/agent/memory';

const ROOT = 'D:/proj';
const MEM_DIR = `${ROOT}/.lantai/memory`;
const INDEX = `${MEM_DIR}/MEMORY.md`;

function disk() {
  return H.kernelFs!.fs;
}

/** 建一个装了 n 条记忆的 MemoryManager（索引 + 文件都落内存盘）。 */
async function seed(names: string[]): Promise<MemoryManager> {
  const mm = new MemoryManager(ROOT);
  for (const n of names) {
    await mm.save(n, `摘要 ${n}`, 'project', `正文 ${n}`);
  }
  return mm;
}

/** 索引里还剩哪些条目名（直读盘，不看 MemoryManager 的内存态）。 */
function indexNames(): string[] {
  const text = disk().files.get(INDEX) ?? '';
  return [...text.matchAll(/\((?:[^)]*\/)?([^)/]+)\.md\)/g)].map((m) => m[1]);
}

const SIX = [
  'img-capability-stamp',
  'img-reader-not-carried',
  'img-read-verify',
  'img-capability-hint-proposal',
  'img-chain-structural-flaw',
  'assembly-input-single-source',
];

describe('记忆删除完整性 — 墓碑不是删除', () => {
  beforeEach(() => {
    const k = disk();
    k.files.clear();
    k.dirs.clear();
    k.writes.length = 0;
    k.fail = {};
  });

  it('① 删除一条记忆：文件必须从盘上消失（墓碑残留 = 没删）', async () => {
    const mm = await seed(['keep-me', 'kill-me']);
    expect(disk().files.has(`${MEM_DIR}/kill-me.md`)).toBe(true);

    expect(await mm.delete('kill-me')).toBe(true);

    const left = disk().files.get(`${MEM_DIR}/kill-me.md`);
    expect(left, `盘上残留（用户看到的「不死」）: ${JSON.stringify(left)}`).toBeUndefined();
  });

  it('② 单条删除（串行）：索引行消失，注入段不再提这条', async () => {
    const mm = await seed(['keep-me', 'kill-me']);

    expect(await mm.delete('kill-me')).toBe(true);

    expect(indexNames()).toEqual(['keep-me']);
    const section = await mm.loadPromptSection();
    expect(section).not.toContain('kill-me');
  });

  it('③ 同批并行删 6 条（真机形状）：索引不得复活任何一条', async () => {
    const mm = await seed(SIX);

    const oks = await Promise.all(SIX.map((n) => mm.delete(n)));
    expect(oks).toEqual([true, true, true, true, true, true]);

    expect(indexNames(), '索引里复活的已删条目（丢失更新）').toEqual([]);
    expect(await mm.list('project')).toEqual([]);
  });

  it('④ 并行删除后：记忆注入段不得含墓碑残渣', async () => {
    const mm = await seed(SIX);
    await Promise.all(SIX.map((n) => mm.delete(n)));

    const section = await mm.loadPromptSection();
    expect(section, '每次会话都被注入的墓碑残渣').not.toContain('{"deleted":true}');
    for (const n of SIX) {
      expect(section).not.toContain(n);
    }
    expect(section).toContain('暂无已保存的记忆');
  });

  it('⑤ 老盘免疫：索引残留行 + 墓碑文件 → 既不注入也不列（读侧当不存在）', async () => {
    // 复刻真机被污染的形状：MEMORY.md 里还挂着行，文件是 16 字节墓碑。
    disk().setFile(`${MEM_DIR}/zombie.md`, '{"deleted":true}');
    disk().setFile(INDEX, '- [早该死了](zombie.md) — 已删但索引行还在\n');
    const mm = new MemoryManager(ROOT);

    const section = await mm.loadPromptSection();
    expect(section, '墓碑残渣仍被注入').not.toContain('{"deleted":true}');
    expect(section).not.toContain('早该死了');

    const listTool = createMemoryTools(mm).find((t) => t.name() === 'hologram_memory_list');
    expect(listTool).toBeDefined();
    const listed = await listTool?.execute({});
    expect(listed, '列表把已删的记忆报成活的').not.toContain('早该死了');
    expect(listed).toContain('暂无已保存的记忆');
  });

  it('⑥ 孤儿墓碑（索引里没有行）也能被真删清掉', async () => {
    disk().setFile(`${MEM_DIR}/orphan.md`, '{"deleted":true}');
    disk().setFile(INDEX, '- [活着的](alive.md) — 正常条目\n');
    const mm = new MemoryManager(ROOT);

    expect(await mm.delete('orphan')).toBe(true);
    expect(disk().files.has(`${MEM_DIR}/orphan.md`)).toBe(false);
    expect(indexNames(), '索引里别的条目不该被牵连').toEqual(['alive']);
    expect(await mm.delete('never-existed')).toBe(false);
  });
});
