// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// office 域（C 路）守护——OfficeCLI 一等域工具：
//   ① 纯函数：shell 引号 / 命令行拼装 / 动作 → argv（含缺参报错）；
//   ② 工具形状：name/domain/actions/readOnlyActions + JSON Schema 动作枚举；
//   ③ plan 分档：只读动作放行、写动作拦截（readOnlyActions 白名单生效）；
//   ④ 执行面：经 ctx.shell seam 派发（fake provider 收参数）——相对路径按工作区根解析、
//      粘性 cwd 沿用、写动作带落盘提示；
//   ⑤ 真二进制端到端（二进制在场时）：真 bash 跑真 officecli，创建→读→改→截图→validate。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planGateCheck } from '../src/agent/plan/plan-registry';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import { clearOwnerContextsForTest, registerOwnerContext } from '../src/agent/session-context';
import type { Tool, ToolExecutor } from '../src/agent/tool';
import {
  buildOfficeArgv,
  buildOfficeCommand,
  cleanShellOutput,
  createOfficeTools,
  OFFICE_ACTIONS,
  OFFICE_BATCH_MAX_ITEMS,
  OFFICE_READONLY_ACTIONS,
  parseShellExit,
  shQuote,
  splitOfficeBatchItems,
} from '../src/agent/tools/office';
import { activeShellProviders, shellServicePlugin } from '../src/composition/shell-service';
import { Context } from '../src/cordis';
import { builtinShellProvider } from '../src/plugins/builtin/shell-builtin';

const identity = (p: string) => p.replace(/\\/g, '/');

describe('office 域：纯函数（引号 / 命令行 / argv）', () => {
  it('shQuote：单引号包裹 + 内嵌单引号按 POSIX 规则收尾拼接', () => {
    expect(shQuote('plain')).toBe("'plain'");
    // 空格 / 方括号（会被 bash 当 glob）/ 单引号 / 反斜杠 都要安全
    expect(shQuote('/body/p[1]')).toBe("'/body/p[1]'");
    expect(shQuote('my doc.docx')).toBe("'my doc.docx'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote("a'b'c")).toBe(`'a'\\''b'\\''c'`);
  });

  it('buildOfficeCommand：二进制定位 + 环境钉扎（立即落盘 / 跳更新检查）+ 逐项引号', () => {
    const cmd = buildOfficeCommand(['view', 'D:/ws/报告 一.docx', 'outline']);
    // 二进制定位（$OFFICECLI_PATH → 标准安装位 → PATH 兜底）
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 断言的是 shell 参数展开原文（${VAR:-默认}），不是 JS 模板串
    expect(cmd).toContain('${OFFICECLI_PATH:-$HOME/.lantai/tools/officecli/officecli.exe}');
    expect(cmd).toContain('|| BIN=officecli');
    // 环境钉扎（写动作立即落盘 + 跳过自动更新——文件头两个产品决定）
    expect(cmd).toContain('OFFICECLI_SKIP_UPDATE=1');
    expect(cmd).toContain('OFFICECLI_RESIDENT_FLUSH=each');
    // 逐项单引号（含空格路径安全）
    expect(cmd).toContain("'view' 'D:/ws/报告 一.docx' 'outline'");
  });

  it('buildOfficeArgv：11 个动作的 argv 形状', () => {
    const r = identity;
    expect(buildOfficeArgv({ action: 'view', file: 'a.docx' }, r)).toEqual(['view', 'a.docx', 'text']);
    expect(buildOfficeArgv({ action: 'view', file: 'a.docx', mode: 'issues', json: true }, r)).toEqual([
      'view',
      'a.docx',
      'issues',
      '--json',
    ]);
    expect(buildOfficeArgv({ action: 'get', file: 'a.docx', path: '/body/p[2]', depth: 2, json: true }, r)).toEqual([
      'get',
      'a.docx',
      '/body/p[2]',
      '--depth',
      '2',
      '--json',
    ]);
    expect(buildOfficeArgv({ action: 'query', file: 'a.docx', selector: 'paragraph[style=Heading1]' }, r)).toEqual([
      'query',
      'a.docx',
      'paragraph[style=Heading1]',
    ]);
    expect(buildOfficeArgv({ action: 'validate', file: 'a.xlsx' }, r)).toEqual(['validate', 'a.xlsx']);
    expect(buildOfficeArgv({ action: 'create', file: 'new.pptx' }, r)).toEqual(['create', 'new.pptx']);
    expect(
      buildOfficeArgv({ action: 'set', file: 'a.docx', path: '/body/p[2]', props: { firstLineChars: '200' } }, r),
    ).toEqual(['set', 'a.docx', '/body/p[2]', '--prop', 'firstLineChars=200']);
    expect(
      buildOfficeArgv(
        { action: 'add', file: 'a.docx', parent: '/body', type: 'paragraph', props: { text: '标题' } },
        r,
      ),
    ).toEqual(['add', 'a.docx', '/body', '--type', 'paragraph', '--prop', 'text=标题']);
    expect(buildOfficeArgv({ action: 'remove', file: 'a.docx', path: '/body/p[9]' }, r)).toEqual([
      'remove',
      'a.docx',
      '/body/p[9]',
    ]);
    const items = [{ command: 'set', path: '/Sheet1/A1', props: { value: 'x' } }];
    expect(buildOfficeArgv({ action: 'batch', file: 'a.xlsx', items, json: true }, r)).toEqual([
      'batch',
      'a.xlsx',
      '--commands',
      JSON.stringify(items),
      '--json',
    ]);
    expect(
      buildOfficeArgv({ action: 'merge', file: 'tpl.docx', out: 'out.docx', data: { client: 'Acme' } }, r),
    ).toEqual(['merge', 'tpl.docx', 'out.docx', '--data', JSON.stringify({ client: 'Acme' })]);
    expect(buildOfficeArgv({ action: 'screenshot', file: 'a.pptx', out: 'p1.png', page: 2 }, r)).toEqual([
      'view',
      'a.pptx',
      'screenshot',
      '-o',
      'p1.png',
      '--page',
      '2',
    ]);
    expect(buildOfficeArgv({ action: 'screenshot', file: 'a.pptx', out: 'all.png', grid: true }, r)).toEqual([
      'view',
      'a.pptx',
      'screenshot',
      '-o',
      'all.png',
      '--grid',
      'auto',
    ]);
    // playbook（专项技能）：不需要 file
    expect(buildOfficeArgv({ action: 'playbook', playbook: 'academic-paper' }, r)).toEqual([
      'load_skill',
      'academic-paper',
    ]);
  });

  it('buildOfficeArgv：缺必要参数 → 返回可直给模型的说明（不抛）', () => {
    const r = identity;
    expect(buildOfficeArgv({ action: 'get', file: 'a.docx' }, r)).toContain('get 需要 path');
    expect(buildOfficeArgv({ action: 'query', file: 'a.docx' }, r)).toContain('query 需要 selector');
    expect(buildOfficeArgv({ action: 'set', file: 'a.docx', path: '/body/p[1]' }, r)).toContain(
      'set 需要至少一个 props',
    );
    expect(buildOfficeArgv({ action: 'add', file: 'a.docx' }, r)).toContain('add 需要 type');
    expect(buildOfficeArgv({ action: 'batch', file: 'a.xlsx' }, r)).toContain('batch 需要 items');
    expect(buildOfficeArgv({ action: 'merge', file: 't.docx' }, r)).toContain('merge 需要 out');
    expect(buildOfficeArgv({ action: 'screenshot', file: 'a.pptx' }, r)).toContain('screenshot 需要 out');
    expect(buildOfficeArgv({ action: 'playbook' }, r)).toContain('playbook 需要 playbook 参数');
    expect(buildOfficeArgv({ action: 'view' }, r)).toContain('view 需要 file');
  });

  it('cleanShellOutput：剥 cwd 回显；找不到二进制时补安装指引（错误不静默）', () => {
    expect(cleanShellOutput('[exit 0] ok\n[cwd: /d/ws]\n')).toBe('[exit 0] ok');
    const missing = cleanShellOutput('[exit 127] bash: line 1: officecli: command not found');
    expect(missing).toContain('command not found');
    expect(missing).toContain('install-officecli.ps1');
  });

  it('cleanShellOutput：只有"二进制缺席"才补安装指引（2026-09-15 收窄——别把文件找不到误报成没装）', () => {
    // 目标文件不存在 / 路径写错：一个字都不许提"装 officecli"
    const noFile = cleanShellOutput('[exit 1] Error: Cannot open /d/ws/报告.docx: No such file or directory');
    expect(noFile).not.toContain('install-officecli.ps1');
    const badDom = cleanShellOutput('[exit 1] ERROR: Sheet not found: "参数表"');
    expect(badDom).not.toContain('install-officecli.ps1');
    // 真缺席两种拼写都要认（PATH 形态 / 绝对路径形态）
    expect(cleanShellOutput('[exit 127] bash: line 1: officecli: command not found')).toContain(
      'install-officecli.ps1',
    );
    expect(
      cleanShellOutput(
        '[exit 127] bash: line 1: /c/u/.lantai/tools/officecli/officecli.exe: No such file or directory',
      ),
    ).toContain('install-officecli.ps1');
  });

  it('parseShellExit：只认行首 `[exit N]`；读不到 = null（未知不许当成功）', () => {
    expect(parseShellExit('[exit 0] ok')).toBe(0);
    expect(parseShellExit('[exit 127] bash: officecli: command not found')).toBe(127);
    expect(parseShellExit('\n[exit 1] boom')).toBe(1);
    expect(parseShellExit('ok without marker')).toBeNull();
    expect(parseShellExit('')).toBeNull();
  });

  it('splitOfficeBatchItems：条数上限与字节上限双约束，超大单项独占一块', () => {
    expect(splitOfficeBatchItems([])).toEqual([]);
    const small = (n: number) => Array.from({ length: n }, (_, i) => ({ command: 'set', path: `/Sheet1/A${i + 1}` }));
    const chunks = splitOfficeBatchItems(small(250));
    expect(chunks.map((c) => c.length)).toEqual([OFFICE_BATCH_MAX_ITEMS, OFFICE_BATCH_MAX_ITEMS, 50]);
    // 字节上限先到：3 个 ~6KB 项 → 各自一块（2×6KB+2 > 12KB）
    const fat = Array.from({ length: 3 }, () => ({ command: 'set', props: { value: 'x'.repeat(6000) } }));
    expect(splitOfficeBatchItems(fat).map((c) => c.length)).toEqual([1, 1, 1]);
    // 单项就超上限 → 也得自成一块（切不开，只能交给上层报错）
    const huge = [{ command: 'set', props: { value: 'y'.repeat(20000) } }, { command: 'set' }];
    expect(splitOfficeBatchItems(huge).map((c) => c.length)).toEqual([1, 1]);
  });
});

describe('office 域：工具形状与 plan 分档', () => {
  const tools = createOfficeTools(async () => 'noop');
  const tool = tools[0]!;

  it('形状：单工具 office / 域 office / 12 动作 / 5 只读动作 / 整体非只读', () => {
    expect(tools).toHaveLength(1);
    expect(tool.name()).toBe('office');
    expect(tool.domain?.()).toBe('office');
    expect(tool.actions?.()).toEqual([...OFFICE_ACTIONS]);
    expect(tool.readOnlyActions?.()).toEqual([...OFFICE_READONLY_ACTIONS]);
    // 混合读写域：整体 readOnly=false（照 domains.ts buildDomainTool 同款判据）
    expect(tool.readOnly()).toBe(false);
    const schema = tool.parameters() as { properties?: { action?: { enum?: string[] } } };
    expect(schema.properties?.action?.enum).toEqual([...OFFICE_ACTIONS]);
  });

  it('plan 分档：只读动作放行、写动作拦截（白名单生效）', () => {
    const ps = new PlanStateManager();
    ps.enter('D:/ws');
    for (const action of OFFICE_READONLY_ACTIONS) {
      expect(planGateCheck(ps, 'office', { action }, tool)).toBeNull();
    }
    for (const action of ['create', 'set', 'add', 'remove', 'batch', 'merge', 'screenshot']) {
      expect(planGateCheck(ps, 'office', { action }, tool)).toContain('[已拦截]');
    }
  });

  it('形状：动作面覆盖 MCP 路原有能力（含 playbook＝load_skill 专项技能，不丢面）', () => {
    expect(OFFICE_ACTIONS).toHaveLength(12);
    expect(OFFICE_ACTIONS).toContain('playbook');
    expect(OFFICE_READONLY_ACTIONS).toContain('playbook');
  });
});

describe('office 域：执行面（经 ctx.shell seam 派发）', () => {
  const captured: Array<{ action: string; args: Record<string, unknown> }> = [];
  let tool: Tool;
  /** 下一次 shell 层回执（各用例按需改写——退出码语义要靠它驱动）。 */
  let nextResult = '[exit 0] recorded\n[cwd: /d/ws]';
  /** 按调用序号出队的回执脚本（空则用 nextResult）——多批场景靠它逐步改判。 */
  let scripted: string[] = [];

  beforeAll(async () => {
    const root = new Context();
    await root.plugin(shellServicePlugin);
    root.shell.register({
      id: 'test/recorder',
      execute: async (action, args) => {
        captured.push({ action, args });
        return scripted.shift() ?? nextResult;
      },
    });
    expect(activeShellProviders().length).toBeGreaterThan(0);
    clearOwnerContextsForTest();
    registerOwnerContext('owner-1', 'D:\\ws');
    tool = createOfficeTools(async () => 'unused')[0]!;
  });

  afterAll(() => clearOwnerContextsForTest());

  it('相对路径按工作区根解析 + 命令走 exec_command（模型不碰引号）', async () => {
    captured.length = 0;
    const out = await tool.execute({ action: 'view', file: '报告.docx', mode: 'issues', _owner_id: 'owner-1' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.action).toBe('run');
    const command = String(captured[0]?.args.command);
    expect(command).toContain("'view' 'D:/ws/报告.docx' 'issues'");
    expect(out).toContain('recorded');
    expect(out).not.toContain('[cwd:');
  });

  it('粘性 cwd 沿用当前值（不把 shell 域的 cwd 顶掉，也不给绝对工作区根污染）', async () => {
    captured.length = 0;
    await tool.execute({ action: 'validate', file: 'D:/ws/a.xlsx', _owner_id: 'owner-1' });
    expect(captured[0]?.args.cwd).toBe('D:\\ws');
  });

  it('落盘脚注只认退出码：成功才声明，失败/未知一律不声明（2026-09-15 假成功事故）', async () => {
    captured.length = 0;
    nextResult = '[exit 0] recorded\n[cwd: /d/ws]';
    const write = await tool.execute({
      action: 'set',
      file: 'D:/ws/a.docx',
      path: '/body/p[1]',
      props: { bold: 'true' },
    });
    expect(write).toContain('改动已提交');

    // 失败：officecli 报错 + 非零退出码 → 不得出现"已落盘/已提交"这类成功话术
    nextResult = '[exit 1]\n[1] ERROR: Sheet not found: "参数表"\nBatch complete: 0 succeeded, 3 failed';
    const failed = await tool.execute({
      action: 'set',
      file: 'D:/ws/a.docx',
      path: '/body/p[1]',
      props: { bold: 'true' },
    });
    expect(failed).toContain('未成功');
    expect(failed).not.toContain('改动已提交');

    // 退出码读不到（别的 shell provider / 回执形状变了）→ 未知，同样不许声明成功
    nextResult = 'recorded without exit marker';
    const unknown = await tool.execute({
      action: 'set',
      file: 'D:/ws/a.docx',
      path: '/body/p[1]',
      props: { bold: 'true' },
    });
    expect(unknown).toContain('没拿到退出码');
    expect(unknown).not.toContain('改动已提交');

    // 只读动作任何情况下都不带脚注
    nextResult = '[exit 0] recorded\n[cwd: /d/ws]';
    const read = await tool.execute({ action: 'validate', file: 'D:/ws/a.docx' });
    expect(read).not.toContain('改动已提交');
    expect(read).not.toContain('未成功');
  });

  it('batch 超限自动切块：顺序执行、逐批报账（2026-09-15 静默丢行事故）', async () => {
    captured.length = 0;
    nextResult = '[exit 0] Batch complete: ok';
    const items = Array.from({ length: 250 }, (_, i) => ({
      command: 'set',
      path: `/Sheet1/A${i + 1}`,
      props: { value: String(i) },
    }));
    const out = await tool.execute({ action: 'batch', file: 'D:/ws/a.xlsx', items });
    // 250 项 / 上限 100 → 3 批 ⇒ 3 次 CLI 调用，且每批自身 ≤100 项
    expect(captured).toHaveLength(3);
    const perCall = captured.map((c) => {
      const cmd = String(c.args.command);
      const m = cmd.match(/'--commands' '(\[.*\])'/s);
      expect(m).not.toBeNull();
      return JSON.parse((m?.[1] ?? '[]').replace(/'\\''/g, "'")) as unknown[];
    });
    expect(perCall.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(out).toContain('分 3 批执行');
    expect(out).toContain('共 250 项');
  });

  it('batch 中途失败：停在原地并说清哪几批已落盘（不回退、不重来）', async () => {
    captured.length = 0;
    scripted = ['[exit 0] Batch complete: 100 succeeded', '[exit 1] Batch complete: 100 failed, 100 total'];
    const out = await tool.execute({
      action: 'batch',
      file: 'D:/ws/a.xlsx',
      items: Array.from({ length: 250 }, (_, i) => ({ command: 'set', path: `/Sheet1/A${i + 1}` })),
    });
    scripted = [];
    expect(captured).toHaveLength(2); // 第 2 批失败即停，不再跑第 3 批
    expect(out).toContain('第 2/3 批失败并已停下');
    expect(out).toContain('前 1 批已落盘');
  });

  it('playbook 结果前置环境护栏（正文是命令行指南，本环境跑不了）', async () => {
    captured.length = 0;
    nextResult = '[exit 0] # OfficeCLI XLSX Skill\n\n## Help-First Rule\n\n```bash\nofficecli help xlsx\n```';
    const out = await tool.execute({ action: 'playbook', playbook: 'excel' });
    expect(out).toContain('在本环境不可执行');
    expect(out).toContain('不在 shell 的 PATH 里');
    expect(out).toContain('Help-First Rule'); // 正文照旧保留（护栏是前缀，不是替换）
    // 目标文件（.xlsx）确实经 shell 派发——guard 不放行"只在文档里写"
    expect(captured[0]?.action).toBe('run');
  });

  it('缺参不派发、直接回说明（省一次进程）', async () => {
    captured.length = 0;
    const out = await tool.execute({ action: 'set', file: 'D:/ws/a.docx', path: '/body/p[1]' });
    expect(out).toContain('set 需要至少一个 props');
    expect(captured).toHaveLength(0);
  });
});

// ── 真二进制端到端（经真 bash 跑真 officecli；二进制/捆绑 bash 缺席即跳过）──
const BIN = process.env.OFFICECLI_PATH ?? join(homedir(), '.lantai', 'tools', 'officecli', 'officecli.exe');
const BASH = join(process.cwd(), '..', 'src-tauri', 'vendor', 'usr', 'bin', 'bash.exe');
const available = existsSync(BIN) && existsSync(BASH);
const d = available ? describe : describe.skip;
const WORK = available ? mkdtempSync(join(tmpdir(), 'lantai-office-domain-')) : '';

/** 真 exec：把能力口该做的事（spawn 一个 shell 跑命令）用 node 侧等价实现顶上——
 *  被验证的是**工具生成的命令行本身**（引号/路径/BIN 定位/落盘开关），Rust 沙箱面
 *  归 process_cap 的测试与真机验收。 */
function realExec(): ToolExecutor {
  return async (_name, args) => {
    const command = String((args as { command?: unknown }).command ?? '');
    const cwd = String((args as { cwd?: unknown }).cwd ?? WORK);
    return await new Promise<string>((resolve) => {
      const child = spawn(BASH, ['-c', command], { cwd, windowsHide: true, env: { ...process.env, HOME: homedir() } });
      let out = '';
      child.stdout.on('data', (c) => {
        out += String(c);
      });
      child.stderr.on('data', (c) => {
        out += String(c);
      });
      child.on('close', (code) => resolve(`[exit ${code ?? '?'}] ${out}`));
    });
  };
}

d('office 域：真二进制端到端（真 bash × 真 officecli）', () => {
  let root: Context;
  let tool: Tool;

  beforeAll(async () => {
    root = new Context();
    await root.plugin(shellServicePlugin);
    root.shell.register(builtinShellProvider); // 真 provider（dispatch → 我们的 realExec）
    clearOwnerContextsForTest();
    registerOwnerContext('e2e-owner', WORK);
    tool = createOfficeTools(realExec())[0]!;
  }, 60_000);

  afterAll(() => {
    clearOwnerContextsForTest();
    if (WORK) {
      try {
        rmSync(WORK, { recursive: true, force: true });
      } catch {
        /* 临时目录残留不影响判定 */
      }
    }
  });

  it('create → view → set → screenshot → validate（写动作真的落盘）', async () => {
    const docx = `${WORK.replace(/\\/g, '/')}/域端到端.docx`;
    const png = `${WORK.replace(/\\/g, '/')}/域端到端.png`;

    const created = await tool.execute({ action: 'create', file: docx, _owner_id: 'e2e-owner' });
    expect(created).toContain('Created');
    expect(created).toContain('[exit 0]');
    expect(created).toContain('改动已提交');
    // 立即读盘（不经 officecli）：落盘开关生效的最硬判据
    expect(statSync(docx).size).toBeGreaterThan(0);

    const added = await tool.execute({
      action: 'add',
      file: docx,
      parent: '/body',
      type: 'paragraph',
      props: { text: '兰台 office 域端到端' },
      _owner_id: 'e2e-owner',
    });
    expect(added).toContain('Added paragraph');

    const text = await tool.execute({ action: 'view', file: docx, _owner_id: 'e2e-owner' });
    expect(text).toContain('兰台 office 域端到端');

    const shot = await tool.execute({ action: 'screenshot', file: docx, out: png, _owner_id: 'e2e-owner' });
    expect(shot).toContain('.png');
    const bytes = readFileSync(png);
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const valid = await tool.execute({ action: 'validate', file: docx, _owner_id: 'e2e-owner' });
    expect(valid).toContain('no errors');
  }, 180_000);
});
