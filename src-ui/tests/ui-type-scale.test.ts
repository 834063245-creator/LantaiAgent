// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 界面字阶守护（2026-11-06 字号批）——把「界面字号」从散写习惯变成一条可执行契约。
//
// 背景：此前每个 CSS 文件各自写 calc(Npx * var(--font-scale))，全仓 23 个基准值、
// 8～11.5px 那段 229 条声明（默认缩放下 9.6～13.8px，中文读不动）。治法见
// src/app/type-scale.css 头注：九档语义字阶 + 禁 raw calc。本测试钉四件事：
//   ① 档位表 = 契约（改名/加档/调基准都必须显式改这里，顺带改头注那张表）；
//   ② 全仓 CSS 不得再出现 font-size: calc(...var(--font-scale)/var(--fs))；
//   ③ 引用到的 --fs-* 必须在册（拼错就红，不静默回落继承）；
//   ④ 产物自包含：用到字阶的产物 CSS 必须 @import 它（旧 exe + 新产物不塌成继承）。

// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const SCALE_CSS = readFileSync(join(SRC, 'app', 'type-scale.css'), 'utf8');

/** 档位契约（基准 px @ --font-scale: 1）。**改这里 = 改全应用字号**。 */
const SCALE: Record<string, number> = {
  '--fs-micro': 10,
  '--fs-caption': 11,
  '--fs-body': 13,
  '--fs-lead': 15,
  '--fs-title': 17,
  '--fs-head': 22,
  '--fs-readout': 26,
  '--fs-hero': 36,
  '--fs-mega': 48,
};

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(p));
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

const ALL_CSS = cssFiles(SRC);

describe('界面字阶 · 档位表是契约', () => {
  it('九档逐条在册，基准值与契约表一致', () => {
    for (const [name, base] of Object.entries(SCALE)) {
      const re = new RegExp(`${name}:\\s*calc\\(${base}px \\* var\\(--fs-scale\\)\\)`);
      expect(re.test(SCALE_CSS), `${name} 应为 calc(${base}px * var(--fs-scale))`).toBe(true);
    }
  });

  it('缩放因子带缺省值（产物/单测没注入 --font-scale 时按 1 算，不算成非法值）', () => {
    expect(SCALE_CSS).toContain('--fs-scale: var(--font-scale, 1)');
  });

  it('最小档 ≥ 10px（中文在 96 DPI 的可读下限——8/8.5/9/9.5 四档已退役）', () => {
    const min = Math.min(...Object.values(SCALE));
    expect(min).toBeGreaterThanOrEqual(10);
  });

  it('壳层入口先于一切样式导入字阶', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    const scaleAt = main.indexOf("import './app/type-scale.css'");
    const tokensAt = main.indexOf("import './app/tokens.css'");
    expect(scaleAt, 'main.ts 未导入字阶').toBeGreaterThan(-1);
    expect(scaleAt, '字阶必须先于 tokens.css 导入').toBeLessThan(tokensAt);
  });
});

describe('界面字阶 · 字号只准取档', () => {
  it('全仓 CSS 不再出现 font-size: calc(… * var(--font-scale)) 的散写基准值', () => {
    const bad: string[] = [];
    for (const file of ALL_CSS) {
      const lines = readFileSync(file, 'utf8').split(/\\r?\\n/);
      lines.forEach((line, i) => {
        if (/font-size:\s*calc\(.*var\(--font-scale\)/.test(line)) {
          bad.push(`${relative(SRC, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(bad, `界面字号必须取 --fs-* 档（散写基准值 = 又一次长歪的开始）：\n${bad.join('\n')}`).toEqual([]);
  });

  it('spine-rack 的局部 --fs 缩放变量不再用于字号（栏宽几何仍可用）', () => {
    const bad: string[] = [];
    for (const file of ALL_CSS) {
      const lines = readFileSync(file, 'utf8').split(/\\r?\\n/);
      lines.forEach((line, i) => {
        if (/font-size:\s*calc\(.*var\(--fs\)/.test(line)) bad.push(`${relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it('引用到的 --fs-* 全在册（拼错不静默回落成继承）', () => {
    const known = new Set(Object.keys(SCALE));
    const bad: string[] = [];
    for (const file of ALL_CSS) {
      for (const m of readFileSync(file, 'utf8').matchAll(/var\((--fs-[a-z0-9-]+)/g)) {
        const name = m[1]!;
        if (name === '--fs-scale') continue;
        if (!known.has(name)) bad.push(`${relative(SRC, file)} → ${name}`);
      }
    }
    expect(bad, `未在册的字阶档位（拼错 / 未加档）：\n${bad.join('\n')}`).toEqual([]);
  });
});

describe('界面字阶 · 产物自包含', () => {
  it('用到字阶的产物 CSS 必须 @import type-scale.css（旧 exe + 新产物不塌成继承）', () => {
    const missing: string[] = [];
    for (const file of ALL_CSS) {
      if (!file.includes(join('plugins', 'builtin'))) continue;
      const css = readFileSync(file, 'utf8');
      if (!css.includes('var(--fs-')) continue;
      if (!css.includes('type-scale.css')) missing.push(relative(SRC, file));
    }
    expect(missing, `产物 CSS 用字阶却没自带它（landmine H2）：\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('界面字阶 · 缩放下限', () => {
  it('fontScale 可接受域下限 ≥ 1（界面不再提供读不动的组合）', () => {
    const settings = readFileSync(join(SRC, 'settings.ts'), 'utf8');
    const m = /export const FONT_SCALE_RANGE = \{ min: ([\d.]+), max: ([\d.]+) \}/.exec(settings);
    expect(m, 'settings.ts 缺 FONT_SCALE_RANGE').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);
    expect(Number(m![2])).toBeLessThanOrEqual(2);
  });
});

describe('界面字阶 · 纸面正文吃同一枚因子', () => {
  it('index.html 内联脚本在任何模块之前落定 --font-scale（键名与 settings.ts 同源）', () => {
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
    const settings = readFileSync(join(SRC, 'settings.ts'), 'utf8');
    const key = /const STORAGE_KEY = '([^']+)'/.exec(settings)?.[1];
    expect(key, 'settings.ts 缺 STORAGE_KEY').toBeTruthy();
    // 首帧脚本必须读**同一份存档**（手抄键名 = 双真源，改一处静默失效）
    expect(html, 'index.html 首帧脚本未读 settings 存档').toContain(`localStorage.getItem('${key}')`);
    expect(html, 'index.html 首帧脚本未落 --font-scale').toContain("'--font-scale'");
    // 夹取与 FONT_SCALE_RANGE 同域（1.0～2.0）
    expect(html).toMatch(/Math\.min\(2, Math\.max\(1,/);
  });

  it('纸面字号族按 --font-scale 放大：PAPER_TYPE 七族 + markdown 标题 + 表格', () => {
    const tokens = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'type-tokens.ts'), 'utf8');
    expect(tokens, '纸面缩放真源必须读文档根上的 --font-scale').toContain("getPropertyValue('--font-scale')");
    expect(tokens, '纸面缩放夹取必须与 FONT_SCALE_RANGE 同域').toContain('Math.min(2, Math.max(1, n))');
    // 七族正文 + 四级标题 + 表格 = 12 处过 sz()；漏一处 = 那一族不跟字号
    const scaled = (tokens.match(/\bsz\(\d+(\.\d+)?\)/g) ?? []).length;
    expect(scaled, `纸面字号过 sz() 的数量（实测 ${scaled}）`).toBeGreaterThanOrEqual(12);
    // 兜底：PAPER_TYPE 七族里不得再出现裸字号（CHROME/ASSET 的标签档不缩放，故只扫这一段）
    const paperType = /export const PAPER_TYPE = \{[\s\S]*?\} as const;/.exec(tokens)?.[0] ?? '';
    expect(paperType, 'PAPER_TYPE 块没抓到（结构变了就更新本断言）').not.toBe('');
    expect(paperType, 'PAPER_TYPE 里还有裸字号').not.toMatch(/size: \d+(\.\d+)?,/);
  });

  it('node 单测无 document ⇒ PAPER_SCALE = 1（测量基线零漂移）', async () => {
    const mod = await import('../src/plugins/builtin/paper-shell/type-tokens');
    expect(mod.PAPER_SCALE).toBe(1);
    expect(mod.PAPER_TYPE.body.size).toBe(17);
    expect(mod.PAPER_TYPE.tool.size).toBe(11.5);
  });
});
