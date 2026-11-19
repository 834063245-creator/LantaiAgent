// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 按下态守卫（2026-11-17 反馈密度批 · 第一批）。
//
// 病灶（体检 `docs/plans/feedback-density-audit-2026-11-17.md`）：全产品 22 条 `:active`
// / 412 个交互点——hover 都在（198 条），按下几乎全空。用户读作「死板」、次级操作
// 读作「不可靠」。本批把已经验证过的范式（主按钮 `.sh-btn-primary` / `.ss-new`：
// 背景转朱砂 + 1px 下压；权限卡 `.pp-pc-btn`：次级加深 + 1px）推到 12 个面。
//
// 三条守卫：
//   ① **每个交互面必须有 `:active`**——一个面归零 = 回退到"按下去没反应"；
//   ② 按下位移走**独立 `translate`**，不写 `transform`——元素自带 transform 的地方
//      （卡片上浮 / 拖拽跟手 / 图标位移）写 transform 会整表覆盖（pp-enter 事故同族）；
//   ③ 主按钮范式（朱砂底）**不得**被本批改坏。

// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** 本批覆盖的 12 个交互面（与体检文档 §7 附录的"active 为 0"清单对齐）。 */
const FACES: Array<[string, string]> = [
  ['设置页', 'plugins/builtin/settings-domain/settings-panel.css'],
  ['架阁浮层', 'plugins/builtin/paper-shell/shelf.css'],
  ['模型选择器', 'plugins/builtin/compose-dock/model-selector.css'],
  ['创作坞', 'plugins/builtin/paper-shell/paper-composer.css'],
  ['工作台', 'plugins/builtin/paper-shell/paper-dock-jobs.css'],
  ['书脊', 'plugins/builtin/canvas-nav/spine-rack.css'],
  ['目次带', 'plugins/builtin/paper-shell/paper-toc.css'],
  ['壳层', 'app/shell.css'],
  ['PDF 查看器', 'app/paper/viewers/pdf.css'],
  ['3D 查看器', 'app/paper/viewers/model3d.css'],
  ['首页次级件', 'plugins/builtin/sessions-home/home.css'],
  ['侧栏次级件', 'plugins/builtin/canvas-nav/session-sidebar.css'],
];

describe('按下态（2026-11-17 反馈密度批）', () => {
  it.each(FACES)('%s 有 :active 档', (_name, rel) => {
    const css = stripComments(read(rel));
    expect(css, `${rel} 缺 :active——按下去没有回弹`).toContain(':active');
  });

  it('本批新增的按下块：位移一律走独立 translate，不写 transform', () => {
    for (const [name, rel] of FACES) {
      const text = read(rel);
      const at = text.lastIndexOf('2026-11-17 反馈密度批');
      if (at < 0) continue; // 面已在此前有 active 档，本期未追加
      const block = stripComments(text.slice(at));
      expect(block, `${name}：按下块不得写 transform（会覆盖元素既有变换）`).not.toContain('transform:');
      expect(block, `${name}：按下位移必须带 translate`).toContain('translate: 0 1px');
    }
  });

  it('主按钮范式（朱砂底 + 1px 下压）不得被改坏', () => {
    const home = stripComments(read('plugins/builtin/sessions-home/home.css'));
    expect(home, '首页主按钮按下档丢了').toMatch(/\.sh-btn-primary:active\s*\{[^}]*var\(--seal\)/);

    const sidebar = stripComments(read('plugins/builtin/canvas-nav/session-sidebar.css'));
    expect(sidebar, '侧栏新建钮按下档丢了').toMatch(/\.ss-new:active\s*\{[^}]*var\(--seal\)/);

    const inline = stripComments(read('plugins/builtin/paper-shell/paper-inline.css'));
    expect(inline, '权限卡主按钮按下档丢了').toMatch(/\.pp-pc-btn--primary:active\s*\{[^}]*var\(--seal\)/);
  });

  it('体检文档在册（本批的判据来源）', () => {
    const doc = readFileSync(
      join(__dirname, '..', '..', 'docs', 'plans', 'feedback-density-audit-2026-11-17.md'),
      'utf8',
    );
    expect(doc).toContain('反馈密度体检');
    expect(doc).toContain('按下');
  });
});
