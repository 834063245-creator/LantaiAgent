// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具卡语义投影层（2026-10-29）——断言**用户可见文本**，不是内部结构。
//
// 病灶（用户原话）：「聊天流里所有工具卡片返回的内容，除了 asset 类，几乎都不是给人看的，
// 更接近某种原始的格式化输入输出直接渲染到聊天流」。
// 本文件钉的就是「展开一张卡读到的是人话」：
//   ① 参数面不许出现协议键（`{"action":…}`）与全文载荷（edit 的 oldString/newString、
//      write 的 content）；
//   ② 结果面不许出现协议字段名（`is_dir` / `budget_truncated` / `match_line`）与
//      Windows 扩展路径前缀（`\\?\D:`）；
//   ③ 折叠行读数（summary）是「事」不是字数。
// fixture 全部是**真机载荷**（取自 .lantai/sessions/*.ndjson 的原样串，只做长度裁剪）。

import { describe, expect, it } from 'vitest';
import { presentTool, tidyPath } from '../src/paper/tool-present';

/** 真机 fs(list) 载荷（docs/ 的树，形状与 fs_cap list 一致：children 递归）。 */
const FS_LIST_OUT = JSON.stringify({
  entries: [
    {
      children: [
        {
          children: null,
          is_dir: false,
          name: '0001-provider-id-three-in-one.md',
          path: '\\\\?\\D:\\HoloGramHG\\docs\\adr\\0001-provider-id-three-in-one.md',
        },
        {
          children: null,
          is_dir: false,
          name: 'composition-boundaries.md',
          path: '\\\\?\\D:\\HoloGramHG\\docs\\adr\\composition-boundaries.md',
        },
      ],
      is_dir: true,
      name: 'adr',
      path: '\\\\?\\D:\\HoloGramHG\\docs\\adr',
    },
    { children: null, is_dir: false, name: 'landmine-map.md', path: '\\\\?\\D:\\HoloGramHG\\docs\\landmine-map.md' },
  ],
});

/** 真机 search(content) 载荷（两个命中在同一个文件）。 */
const SEARCH_OUT = JSON.stringify({
  pattern: '^#{1,3} ',
  count: 2,
  truncated: false,
  scanned_files: 1,
  budget_truncated: false,
  context_lines: 1,
  results: [
    {
      file: '\\\\?\\D:\\HoloGramHG\\docs\\plans\\paper-shell\\r5-polish-backlog.md',
      match_line: 13,
      match_content: '## C 段 · 注疏落地涌出项',
      context: 1,
      context_block: [
        { line: 12, content: '', is_match: false },
        { line: 13, content: '## C 段 · 注疏落地涌出项', is_match: true },
      ],
    },
    {
      file: '\\\\?\\D:\\HoloGramHG\\docs\\plans\\paper-shell\\r5-polish-backlog.md',
      match_line: 32,
      match_content: '## A 段 · 转录缺口（保真项）',
      context: 1,
      context_block: [{ line: 32, content: '## A 段 · 转录缺口（保真项）', is_match: true }],
    },
  ],
});

/** 真机 git(status) 载荷（含暂存位与 untracked）。 */
const GIT_STATUS_OUT = JSON.stringify({
  branch: 'main',
  ahead: 2,
  behind: 0,
  files: [
    { path: 'docs/landmine-map.md', status: 'modified', staged: false },
    {
      path: 'src-ui/tests/fs-cap-shape.test.ts',
      status: 'modified',
      staged: true,
      old_path: 'src-ui/tests/fs-cap-dual-shape.test.ts',
    },
    { path: 'notes.md', status: 'untracked', staged: false },
  ],
});

/** 真机 fs(edit) 回执（结论行 + 字面 ```diff 围栏 + 落点行）。 */
const FS_EDIT_OUT =
  '已替换 1 处匹配 — \\\\?\\D:\\HoloGramHG\\hologram-vector\\src\\index.rs (第 108 行附近)\n' +
  '```diff\n' +
  '@@ -105,7 +105,7 @@\n' +
  '              snippets.push(text);\n' +
  '-         if snippets.is_empty() { return Ok(0); }\n' +
  '+         if snippets.is_empty() { return Ok(BuildStats::default()); }\n' +
  '```\n' +
  '[file: D:/HoloGramHG/hologram-vector/src/index.rs]';

/** 真机 shell(run) 输出（正文 + cwd 回显行）。 */
const SHELL_RUN_OUT = 'AGENTS.md\nARCHITECTURE.md\n---\ncatalog-refresh.yml\nci.yml\n[cwd: \\\\?\\D:\\HoloGramHG]\n';

/** 真机 shell(wait) 输出（后台任务信封头）。 */
const SHELL_WAIT_OUT = '[任务已完成, exit code: 0, 耗时: 110s]\nengine_test_exit=0\n';

/** 真机 fs(write) 回执（{path} + 给模型的入参读数嘱咐）。 */
const FS_WRITE_OUT =
  '{"path":"\\\\\\\\?\\\\D:\\\\HoloGramHG\\\\.tmp-docfix.mjs"}\n' +
  '[fs] 本次入参 3 行 / 17 字符 → \\\\?\\D:\\HoloGramHG\\.tmp-docfix.mjs（入参读数，非盘上核对）。要确认盘上内容用 fs(read)。';

/** 展开卡后全部段的可见文本（用户读到的那一坨）。 */
function textOf(p: Parameters<typeof presentTool>[0]): string {
  return presentTool(p)
    .sections.map((s) => `${s.label}\n${s.display.text}`)
    .join('\n');
}

/** 取指定段（卡里参数的段在前、结果的在后；按 kind 取，不按位次）。 */
function sectionOf(p: Parameters<typeof presentTool>[0], kind: 'args' | 'out' | 'err') {
  const sec = presentTool(p).sections.find((s) => s.kind === kind);
  if (!sec) throw new Error(`缺 ${kind} 段：${JSON.stringify(presentTool(p).sections.map((s) => s.kind))}`);
  return sec;
}

/** 协议面残留（机器语汇）——任何一张卡里都不该再出现。 */
const PROTOCOL_NOISE = ['is_dir', 'budget_truncated', 'match_line', 'scanned_files', '\\?\\D:', '"action"'];

describe('参数面：协议键与全文载荷不再当内容', () => {
  it('shell(run)：命令以 `$ ` 原样直排，不再包一层 {"action":"run","command":…}', () => {
    const t = textOf({ name: 'shell', args: JSON.stringify({ action: 'run', command: 'ls -1 | head -60' }) });
    expect(t).toContain('$ ls -1 | head -60');
    expect(t).not.toContain('{"action"');
    expect(t).not.toContain('command');
  });

  it('fs(write)：只报「写哪儿 + 多少」，整份文件内容不再倾出', () => {
    const content = 'x'.repeat(5000);
    const pres = presentTool({
      name: 'fs',
      args: JSON.stringify({ action: 'write', path: 'src/a.ts', content }),
    });
    const args = pres.sections[0];
    expect(args.label).toBe('写入');
    expect(args.display.text).toBe('src/a.ts · 1 行 / 5000 字符'); // 5000 字无换行 = 一行
    expect(args.display.text).not.toContain('xxx');
  });

  it('fs(edit)：参数面只留「改哪儿 + 行数变化」，不再倾出 oldString/newString 全文', () => {
    const pres = presentTool({
      name: 'fs',
      args: JSON.stringify({ action: 'edit', filePath: 'src/index.rs', oldString: 'a'.repeat(2000), newString: 'b' }),
    });
    expect(pres.sections[0].label).toBe('改动');
    expect(pres.sections[0].display.text).toBe('src/index.rs · 1 行 → 1 行');
  });

  it('纯协议骨架的参数面不展示（git status 的 {"action":"status"} 不是内容）', () => {
    const pres = presentTool({ name: 'git', args: JSON.stringify({ action: 'status' }), output: GIT_STATUS_OUT });
    expect(pres.sections.map((s) => s.kind)).toEqual(['out']);
  });

  it('未归类的参数键不静默丢：收成「其余」一行', () => {
    const t = textOf({ name: 'fs', args: JSON.stringify({ action: 'read', path: 'a.md', weirdKey: 'v' }) });
    expect(t).toContain('其余：weirdKey=v');
  });
});

describe('结果面：JSON 不再直出，读成事', () => {
  it('git(status)：分支/领先/改动数一行 + porcelain 逐文件行', () => {
    const pres = presentTool({ name: 'git', args: JSON.stringify({ action: 'status' }), output: GIT_STATUS_OUT });
    const text = pres.sections[0].display.text;
    expect(pres.sections[0].label).toBe('工作区');
    expect(text.split('\n')).toEqual([
      'main · 领先 2 · 3 个改动（1 已暂存）',
      ' M docs/landmine-map.md',
      'M  src-ui/tests/fs-cap-shape.test.ts ← src-ui/tests/fs-cap-dual-shape.test.ts',
      '?? notes.md',
    ]);
    expect(pres.summary).toBe('3 个改动');
  });

  it('fs(list)：缩进树 + 项数，前缀 \\\\?\\D: 与 is_dir 不再上纸', () => {
    const p = { name: 'fs', args: JSON.stringify({ action: 'list', path: 'docs' }), output: FS_LIST_OUT };
    const text = sectionOf(p, 'out').display.text;
    expect(text).toBe(
      ['adr/ 2 项', '  0001-provider-id-three-in-one.md', '  composition-boundaries.md', 'landmine-map.md'].join('\n'),
    );
    expect(presentTool(p).summary).toBe('4 项');
  });

  it('search(content)：ripgrep 形态（处数/文件数 + 行号: 命中行 + 上下文行）', () => {
    const p = {
      name: 'search',
      args: JSON.stringify({ action: 'content', pattern: '^#{1,3} ', path: 'docs', useRegex: true }),
      output: SEARCH_OUT,
    };
    const text = sectionOf(p, 'out').display.text;
    const rows = text.split('\n');
    expect(rows[0]).toBe('2 处匹配 · 1 文件');
    expect(rows[1]).toBe('D:/HoloGramHG/docs/plans/paper-shell/r5-polish-backlog.md'); // 单文件不缩成 basename
    expect(rows[2]).toBe('  12· '); // 上下文行：`· ` 标 + 注记墨
    expect(rows[3]).toBe('  13: ## C 段 · 注疏落地涌出项'); // 命中行：`:` 标 + 实墨
    expect(rows[4]).toBe('  32: ## A 段 · 转录缺口（保真项）');
    expect(presentTool(p).summary).toBe('2 处 · 1 文件');
  });

  it('fs(edit)：一句结论 + 差分正文（围栏拆掉，增删行分档着色）', () => {
    const p = {
      name: 'fs',
      args: JSON.stringify({
        action: 'edit',
        filePath: 'hologram-vector/src/index.rs',
        oldString: 'x',
        newString: 'y',
      }),
      output: FS_EDIT_OUT,
    };
    const sec = sectionOf(p, 'out');
    expect(sec.label).toBe('改动');
    expect(sec.display.text.split('\n')).toEqual([
      '已替换 1 处 · index.rs:108',
      '@@ -105,7 +105,7 @@',
      '              snippets.push(text);',
      '-         if snippets.is_empty() { return Ok(0); }',
      '+         if snippets.is_empty() { return Ok(BuildStats::default()); }',
    ]);
    // 围栏行本身不进正文（此前三个反引号直接挂在纸上）
    expect(sec.display.text).not.toContain('```');
    expect(sec.display.text).not.toContain('[file:');
    // 增/删/块头三档 tone（渲染端 .pp-add/.pp-del/.pp-hunk）
    const tones = new Set(sec.display.lines?.flatMap((l) => l.parts.map((x) => x.tone)) ?? []);
    expect(tones.has('add')).toBe(true);
    expect(tones.has('del')).toBe(true);
    expect(tones.has('hunk')).toBe(true);
    expect(presentTool(p).summary).toBe('+1 −1');
  });

  it('fs(read)：正文直出，文末 [file:] 不再重复路径', () => {
    const pres = presentTool({
      name: 'fs',
      args: JSON.stringify({ action: 'read', path: 'src/a.ts', offset: 85, limit: 80 }),
      output: 'const a = 1;\nconst b = 2;\n[file: D:/ws/src/a.ts]',
    });
    expect(pres.sections[0].label).toBe('读取');
    expect(pres.sections[0].display.text).toBe('src/a.ts · 第 86–165 行');
    expect(pres.sections[1].display.text).toBe('const a = 1;\nconst b = 2;');
    expect(pres.summary).toBe('2 行');
  });

  it('fs(write)：回执只报落点（读数已在参数面那行，不重打）', () => {
    const pres = presentTool({
      name: 'fs',
      args: JSON.stringify({ action: 'write', path: '.tmp.mjs', content: 'a\nb\nc' }),
      output: FS_WRITE_OUT,
    });
    expect(pres.sections[1].display.text).toBe('已写入 D:/HoloGramHG/.tmp-docfix.mjs');
  });

  it('shell(run)：正文 + 文末读数行（cwd 回显不再混在输出里）', () => {
    const pres = presentTool({
      name: 'shell',
      args: JSON.stringify({ action: 'run', command: 'ls -1' }),
      output: SHELL_RUN_OUT,
    });
    expect(pres.sections[1].display.text).toBe(
      'AGENTS.md\nARCHITECTURE.md\n---\ncatalog-refresh.yml\nci.yml\n· cwd D:/HoloGramHG',
    );
    expect(pres.summary).toBe('5 行'); // cwd 回显不算内容行
  });

  it('shell(wait)：后台任务信封头升成读数行，exit code 一眼可见', () => {
    const pres = presentTool({
      name: 'shell',
      args: JSON.stringify({ action: 'wait', jobId: 131, timeoutMs: 600000 }),
      output: SHELL_WAIT_OUT,
    });
    expect(pres.sections[0].display.text).toBe('任务 #131\n最多等 600s');
    expect(pres.sections[1].display.text).toBe('engine_test_exit=0\n· exit 0 · 110s');
    expect(pres.summary).toBe('exit 0 · 110s');
  });

  it('git(commit)：git 的英文句式换成中文读数行', () => {
    const pres = presentTool({
      name: 'git',
      args: JSON.stringify({ action: 'commit', files: 'a,b,c', message: 'chore(release): 1.0.8 → 1.0.9' }),
      output: '[main a824d1ca] chore(release): 1.0.8 → 1.0.9\n 9 files changed, 14 insertions(+), 14 deletions(-)\n',
    });
    expect(pres.sections[1].display.text).toBe(
      'main · a824d1ca · chore(release): 1.0.8 → 1.0.9\n· 9 个文件 · +14 · −14',
    );
  });
});

describe('纪律：解析不了就交回兜底（永不空、永不炸）', () => {
  it('形状不认识的输出回落通用视图（原文照旧读得到）', () => {
    const pres = presentTool({
      name: 'git',
      args: JSON.stringify({ action: 'status' }),
      output: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    expect(pres.sections.map((s) => s.kind)).toEqual(['out']);
    expect(pres.sections[0].display.text).toContain('fatal: not a git repository');
    expect(pres.summary).toBeUndefined();
  });

  it('未登记的远端/插件工具（动态名面）行为与改造前一致：参数与输出照原样结构化', () => {
    const pres = presentTool({
      name: 'browser',
      args: JSON.stringify({ action: 'targets' }),
      output: JSON.stringify({ port: 9223, targets: [{ id: 'ABC', title: 'x', url: 'https://x' }] }),
    });
    expect(pres.sections[0].display.text).toContain('action: "targets"');
    expect(pres.sections[1].display.text).toContain('port: 9223');
  });

  it('错误段照旧单列（错误留面），段序 = 参数 → 结果 → 错误', () => {
    const pres = presentTool({
      name: 'fs',
      args: JSON.stringify({ action: 'read', path: 'a.md' }),
      output: 'body',
      err: 'EACCES: 拒绝访问',
    });
    expect(pres.sections.map((s) => `${s.kind}:${s.label}`)).toEqual(['args:读取', 'out:内容', 'err:错误']);
    expect(pres.sections[2].variant).toBe('err');
  });
});

describe('协议面残留归零（跨全部真机 fixture）', () => {
  const cases: Array<{ label: string; p: Parameters<typeof presentTool>[0] }> = [
    {
      label: 'fs list',
      p: { name: 'fs', args: JSON.stringify({ action: 'list', path: 'docs' }), output: FS_LIST_OUT },
    },
    {
      label: 'fs edit',
      p: { name: 'fs', args: JSON.stringify({ action: 'edit', filePath: 'a.rs' }), output: FS_EDIT_OUT },
    },
    {
      label: 'fs write',
      p: { name: 'fs', args: JSON.stringify({ action: 'write', path: 'a' }), output: FS_WRITE_OUT },
    },
    {
      label: 'search',
      p: { name: 'search', args: JSON.stringify({ action: 'content', pattern: 'x' }), output: SEARCH_OUT },
    },
    {
      label: 'git status',
      p: { name: 'git', args: JSON.stringify({ action: 'status' }), output: GIT_STATUS_OUT },
    },
    {
      label: 'shell run',
      p: { name: 'shell', args: JSON.stringify({ action: 'run', command: 'ls' }), output: SHELL_RUN_OUT },
    },
  ];

  it.each(cases)('$label：展开卡里读不到协议字段名与扩展路径前缀', ({ p }) => {
    const t = textOf(p);
    for (const noise of PROTOCOL_NOISE) expect(t, `残留 ${noise}`).not.toContain(noise);
  });
});

describe('tidyPath：只剥壳不改正文', () => {
  it('Windows 扩展路径 → 正斜杠真路径；普通文本原样', () => {
    expect(tidyPath('\\\\?\\D:\\ws\\a.md')).toBe('D:/ws/a.md');
    expect(tidyPath('D:\\ws\\b.md')).toBe('D:/ws/b.md');
    expect(tidyPath('relative/path.md')).toBe('relative/path.md');
  });
});
