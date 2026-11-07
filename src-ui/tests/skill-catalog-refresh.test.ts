// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 技能目录热装载（2026-11-07）——用户报「热装载之后斜杠命令里能不能正常刷出新 skills」。
//
// 旧实现两处断点，任何一处都足以让新装的技能看不见：
//   ① 键控检查 `_scannedPath === path` 直接 return——热装载是**同一工作区**里多出
//      `.lantai/skills/<名>/SKILL.md`，路径键根本不变，永远不重扫；
//   ② 扫描完成不通知任何人（旧注释原话）——下一次渲染要等别的状态变。
// 本文件把两条闭环钉死：force 重扫 + 清单变更返回 true（面板据此自增 tick），
// 外加「同键在途去重」与「清单没变不谎报 true」（避免每次开面板都白重渲染）。
//
// fs 面站到 kernel-fs 共享 mock（与 skills.test.ts 同一套）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

// 技能域实现（内核登记表门面背后的真身）——与本模块的 scanSkills 走同一条路
import { clearSkillImplementation, registerSkillImplementation } from '../src/agent/skill-impl';
import { ensureSkillCatalog, skillCommands } from '../src/app/commands/skill-catalog';
import { skillImplementation } from '../src/plugins/builtin/skill-domain';

const PROJ = '/proj';
const USER_ROOT = '~/.lantai/skills';

/** 写一个目录包技能（项目级）。 */
function writeSkill(root: string, name: string, description: string): void {
  const k = H.kernelFs!;
  const dir = `${root}/${name}`;
  k.fs.dirs.add(root);
  k.fs.dirs.add(dir);
  k.fs.files.set(`${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
}

/** 斜杠清单里的技能名（不含出厂技能——那些恒在场，会把断言稀释成恒真）。 */
function projectSkillNames(): string[] {
  return skillCommands()
    .map((c) => c.slash ?? '')
    .filter((s) => s === '/hot-added' || s === '/second-wave');
}

describe('技能目录：热装载后斜杠清单能刷出新技能', () => {
  /* 本文件必须自己压一层实现登记（用例内 import 的 skill-domain 走的是**本文件
   * 的模块图**，rpc-contract 已被下面的 vi.mock 换成内存盘）——全局 setup 注册的
   * 那一层是在 setup 阶段建的模块图，捕捉的是真 rpc-contract，在 jsdom 里读不到盘。
   * 登记表是栈：压上去即生效，用例后弹出，不影响别的文件。 */
  beforeEach(() => {
    registerSkillImplementation(skillImplementation);
    const k = H.kernelFs!;
    k.fs.files.clear();
    k.fs.dirs.clear();
    k.fs.writes.length = 0;
    k.fs.fail = {};
    // 清掉上一用例留下的工作区键（模块级缓存，跨用例存活）
    void ensureSkillCatalog(null);
  });

  afterEach(() => {
    clearSkillImplementation();
  });

  it('热装载：面板打开前多出一个 SKILL.md，force 重扫后清单里就有它', async () => {
    await ensureSkillCatalog(PROJ);
    expect(projectSkillNames()).toEqual([]);

    // 用户在工作区里新建技能（设置页新建 / 手放目录 / Agent 自己写——都一样）
    writeSkill(`${PROJ}/.lantai/skills`, 'hot-added', '热装载进来的技能');

    // 面板打开 = 强制重扫（not 键控检查）
    const changed = await ensureSkillCatalog(PROJ, { force: true });
    expect(changed, '新技能进来必须报「清单变了」——否则面板不会重取').toBe(true);
    expect(projectSkillNames()).toEqual(['/hot-added']);
    const added = skillCommands().find((c) => c.slash === '/hot-added');
    expect(added?.description).toBe('热装载进来的技能');
    expect(added?.group).toBe('技能');
  });

  it('键没变也不跳过：force 是「打开即重扫」的唯一依据', async () => {
    writeSkill(`${PROJ}/.lantai/skills`, 'second-wave', '第二批');
    await ensureSkillCatalog(PROJ);

    // 同一个工作区再装一个：路径键逐字未变，但清单必须跟上
    writeSkill(`${PROJ}/.lantai/skills`, 'hot-added', '后装的');
    const changed = await ensureSkillCatalog(PROJ, { force: true });
    expect(changed).toBe(true);
    expect(projectSkillNames().sort()).toEqual(['/hot-added', '/second-wave']);
  });

  it('清单没变不谎报（false）：每次开面板都白重渲染是一种噪音', async () => {
    writeSkill(`${PROJ}/.lantai/skills`, 'hot-added', '稳定内容');
    expect(await ensureSkillCatalog(PROJ)).toBe(true); // 第一次：从无到有
    expect(await ensureSkillCatalog(PROJ, { force: true })).toBe(false); // 再扫：内容没动
    expect(await ensureSkillCatalog(PROJ, { force: true })).toBe(false);
  });

  it('只改描述也算变了（面板显示 description——digest 判据看不见这一层）', async () => {
    writeSkill(`${PROJ}/.lantai/skills`, 'hot-added', '旧描述');
    await ensureSkillCatalog(PROJ);

    writeSkill(`${PROJ}/.lantai/skills`, 'hot-added', '新描述');
    expect(await ensureSkillCatalog(PROJ, { force: true })).toBe(true);
    expect(skillCommands().find((c) => c.slash === '/hot-added')?.description).toBe('新描述');
  });

  it('删掉技能同样报「变了」，斜杠清单里随之消失', async () => {
    writeSkill(`${PROJ}/.lantai/skills`, 'hot-added', '待删');
    await ensureSkillCatalog(PROJ);
    expect(projectSkillNames()).toEqual(['/hot-added']);

    const k = H.kernelFs!;
    k.fs.files.delete(`${PROJ}/.lantai/skills/hot-added/SKILL.md`);
    k.fs.dirs.delete(`${PROJ}/.lantai/skills/hot-added`);

    expect(await ensureSkillCatalog(PROJ, { force: true })).toBe(true);
    expect(projectSkillNames()).toEqual([]);
  });

  it('同键并发去重：连开两次面板只扫一遍（不重复 I/O、不互相顶掉结果）', async () => {
    writeSkill(`${PROJ}/.lantai/skills`, 'hot-added', '并发');
    const [a, b] = await Promise.all([
      ensureSkillCatalog(PROJ, { force: true }),
      ensureSkillCatalog(PROJ, { force: true }),
    ]);
    // 两路拿到同一份结果（在途去重：第二次直接接住第一次那个 promise）
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(projectSkillNames()).toEqual(['/hot-added']);
  });

  it('无工作区 = 清空候选，并报「变了」（面板该把技能一节收掉）', async () => {
    writeSkill(`${PROJ}/.lantai/skills`, 'hot-added', '有工作区时');
    await ensureSkillCatalog(PROJ);
    expect(await ensureSkillCatalog(null)).toBe(true);
    expect(projectSkillNames()).toEqual([]);
  });

  it('用户级技能同样进清单（热装载的第二发现根不该被漏掉）', async () => {
    const k = H.kernelFs!;
    const dir = `${USER_ROOT}/user-level`;
    k.fs.dirs.add(USER_ROOT);
    k.fs.dirs.add(dir);
    k.fs.files.set(`${dir}/SKILL.md`, '---\nname: user-level\ndescription: 用户级\n---\n\nbody\n');

    expect(await ensureSkillCatalog(PROJ)).toBe(true);
    expect(skillCommands().some((c) => c.slash === '/user-level')).toBe(true);
  });
});
