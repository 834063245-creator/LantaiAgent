// paper token 审计（2026-09-03 收口专项）：CSS 的 var(--pp-*) 引用 ↔ type-tokens
// 注入键集全量对账。injectPaperTokens 把 type-tokens.ts 全部版式数字 setProperty
// 到 .pp-root 的 inline style——CSS 引用任何不存在的键 = 该属性静默失效（悬空），
// 且永远不报错。本测试钉死「CSS 引用的每个 token 都有注入源」。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSET_TOKENS, CHROME_TOKENS, injectPaperTokens } from '../src/paper/type-tokens';

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
const COMPONENT_PRIVATE = new Set(['--pp-toast-hold']);

/** 读取纸面全部 CSS（PaperPanel + ToastHost）的 var(--pp-*) 引用键。 */
function usedTokenKeys(): Set<string> {
  const keys = new Set<string>();
  const files = [
    '../src/plugins/builtin/paper-shell/PaperPanel.css',
    '../src/plugins/builtin/paper-shell/ToastHost.css',
  ];
  for (const f of files) {
    const css = readFileSync(resolve(__dirname, f), 'utf8');
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
});
