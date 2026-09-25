// paper token 审计（2026-09-03 收口专项）：CSS 的 var(--pp-*) 引用 ↔ type-tokens
// 注入键集全量对账。injectPaperTokens 把 type-tokens.ts 全部版式数字 setProperty
// 到 .pp-root 的 inline style——CSS 引用任何不存在的键 = 该属性静默失效（悬空），
// 且永远不报错。本测试钉死「CSS 引用的每个 token 都有注入源」。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSET_TOKENS, CHROME_TOKENS, injectPaperTokens } from '../src/plugins/builtin/paper-shell/type-tokens';

/** 走 injectPaperTokens 的真实注入路径，捕获全部键值（木桩 root.style.setProperty）。 */
function captureInjectedTokens(): Map<string, string> {
  const captured = new Map<string, string>();
  const fakeRoot = {
    style: {
      setProperty: (key: string, value: string): void => {
        captured.set(key, value);
      },
    },
  } as unknown as HTMLElement;
  injectPaperTokens(fakeRoot);
  return captured;
}

/** 组件私有变量白名单：不由 type-tokens 注入，由宿主组件 inline style 提供
 * （ToastHost 的 --pp-toast-hold = 存活时长，组件级动态值）。 */
// 另有 CSS 自身在同文件内定义的**颜色**合成位（D11 饼图扇区色板 --pp-chart-c0..c5：
// 扇区填色与图例色块共用一份，色值取自 tokens.css 的语义色——type-tokens 的注入口径是
// 「只注入版式数字，不碰颜色」，故色板天然不走注入面）。
const COMPONENT_PRIVATE = new Set([
  '--pp-toast-hold',
  '--pp-chart-c0',
  '--pp-chart-c1',
  '--pp-chart-c2',
  '--pp-chart-c3',
  '--pp-chart-c4',
  '--pp-chart-c5',
]);

/** 读取纸面全部 CSS（PaperPanel + ToastHost + 查看器各自的 CSS）的 var(--pp-*) 引用键。
 *  P1 起查看器样式落 `plugins/builtin/renderers/viewers/*.css`（一件一文件——查看器自带
 *  内部样式），故扫描面跟到那里：token 悬空与裸色值两条守卫都要覆盖到。 */
const VIEWERS_CSS_DIR = resolve(__dirname, '../src/plugins/builtin/renderers/viewers');

function viewerCssFiles(): string[] {
  if (!existsSync(VIEWERS_CSS_DIR)) return [];
  return readdirSync(VIEWERS_CSS_DIR)
    .filter((f) => f.endsWith('.css'))
    .map((f) => resolve(VIEWERS_CSS_DIR, f));
}

function usedTokenKeys(): Set<string> {
  const keys = new Set<string>();
  const files = [
    resolve(__dirname, '../src/plugins/builtin/paper-shell/PaperPanel.css'),
    resolve(__dirname, '../src/plugins/builtin/paper-shell/ToastHost.css'),
    ...viewerCssFiles(),
  ];
  for (const f of files) {
    const css = readFileSync(f, 'utf8');
    for (const m of css.matchAll(/var\((--pp-[a-z0-9-]+)\)/g)) keys.add(m[1]);
  }
  return keys;
}

describe('paper token 注入键集审计', () => {
  const injected = captureInjectedTokens();

  it('注入面非空（体系在跑）', () => {
    expect(injected.size).toBeGreaterThan(100);
  });

  it('CSS 引用的每个 --pp-* 键都有注入源（无悬空 var）', () => {
    const used = usedTokenKeys();
    expect(used.size).toBeGreaterThan(30);
    const dangling = [...used].filter((k) => !COMPONENT_PRIVATE.has(k) && !injected.has(k));
    expect(dangling).toEqual([]);
  });

  it('注入值不为空串（防占位式假定义）', () => {
    for (const [k, v] of injected) {
      expect(v.length, k).toBeGreaterThan(0);
    }
  });

  it('CHROME/ASSET 双组无同名键（双组去重后防漂移复发：optionBorder 曾在两组各存一份 1 vs 2）', () => {
    const chromeGroups = new Set(Object.keys(CHROME_TOKENS));
    const overlap = Object.keys(ASSET_TOKENS).filter((g) => chromeGroups.has(g));
    const dup: string[] = [];
    for (const g of overlap) {
      const a = CHROME_TOKENS[g as keyof typeof CHROME_TOKENS];
      const b = ASSET_TOKENS[g as keyof typeof ASSET_TOKENS];
      for (const k of Object.keys(a)) {
        if (k in b) dup.push(`${g}.${k}`);
      }
    }
    expect(dup).toEqual([]);
  });

  it('行高系数键（*lh 后缀，不分大小写）注入无单位——md-tableLh 1.5px 事故回归钉（2026-09 表格叠字根因：每行行盒 1.5px，多行单元格文字叠印）', () => {
    const lhKeys = [...injected.keys()].filter((k) => /lh$/i.test(k));
    expect(lhKeys.length).toBeGreaterThan(10); // type-*/md-h*/ch-*/md-tableLh/asset-*/folio
    for (const k of lhKeys) {
      expect(injected.get(k), k).toMatch(/^\d+(\.\d+)?$/); // 纯数字，无单位
    }
    // 定点钉：事故键 + asset 组同族受害者（此前全组 px 化）
    expect(injected.get('--pp-md-tableLh')).toBe('1.5');
    expect(injected.get('--pp-asset-json-preLh')).toBe('1.6');
    expect(injected.get('--pp-asset-metric-cardValueLh')).toBe('1.2');
    expect(injected.get('--pp-asset-form-bodyLh')).toBe('1.7');
    // px 键仍带单位（防把整个注入裸化的反向事故）；math 系数豁免不变
    expect(injected.get('--pp-md-tableSize')).toBe('11.5px');
    expect(injected.get('--pp-md-mathSizeRatio')).toBe('1.06');
  });

  it('查看器自带 CSS（P1：viewers/*.css）不出现裸色值——墨/纸/线全走 token', () => {
    const files = viewerCssFiles();
    expect(files.length, '一个查看器 CSS 都没有 = 扫描面失灵').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      const stripped = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const chunk of stripped.split('}')) {
        const at = chunk.lastIndexOf('{');
        if (at < 0) continue;
        const selector = chunk.slice(0, at).trim();
        for (const raw of chunk.slice(at + 1).split(';')) {
          const d = raw.trim();
          if (!/^(color|background|border|box-shadow|fill|stroke|outline)/.test(d)) continue;
          if (/#[0-9a-fA-F]{3,8}\b/.test(d) || /\b(rgba?|hsla?|oklch)\(/.test(d.replace(/color-mix\(in oklch,/g, ''))) {
            offenders.push(`${f.split(/[\\/]/).pop()} → ${selector} { ${d} }`);
          }
        }
      }
    }
    expect(offenders, `查看器 CSS 出现裸色值（应走 token）：\n${offenders.join('\n')}`).toEqual([]);
  });
});
