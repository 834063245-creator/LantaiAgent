// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 交互原语守卫（2026-11-17 交互原语收口批 E）——**本线唯一不能省的一批**。
//
// 病灶（plan §1）：抽象是可选的，不是强制的。`useLostFocusCancel` 抽出来了却只接了
// 3/9；`overlay.tsx` 收 Escape 时外点不在那次故障的现象里，于是留在原地隔了三个批次。
// **抽出来 ≠ 用上去，中间缺一道门禁**——没有它，批 C 会在半年后长出第 10 份。
//
// 三条断言（形态对齐 motion-contract.test.ts：源码断言 + 登记表）：
//   E1 指针/鼠标监听的**注册点**只许出现在登记表内（按文件）——「这是不是外点关闭」
//      静态判不出来（同一个 `document.addEventListener('mousedown')` 既可能是外点关闭，
//      也可能是起手面登记），**能机械判定的只有「注册点在哪」**：登记表把「新增一处监听」
//      变成一次显式决定（加行 = 在 diff 里被看见），而不是一道猜谜题。
//   E2 语义闸：「点空白 → 关闭」只许出自 `overlay.tsx`（在 E1 的小集合上做组合判断，
//      误报面被压到最小）。
//   E3 `setTimeout` 的毫秒字面量只许出现在登记文件（动画窗一律听事件——plan §2.4）。

// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..');
const SRC = join(REPO, 'src-ui', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'dist-plugins', 'target'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 源码里**注册指针/鼠标监听**的地方（只看 addEventListener 调用，不看注释）。 */
const LISTENER_RE =
  /addEventListener\(\s*['"](?:mousedown|mousemove|mouseup|pointerdown|pointermove|pointerup|pointercancel)['"]/g;

/** 去注释（块注释 + 行注释）——病灶史注释里点名 API 是留痕，不是使用。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const FILES = walk(SRC).map((p) => ({ path: p, rel: relative(REPO, p).split('\\').join('/') }));
const WITHOUT_COMMENTS = new Map(FILES.map((f) => [f.rel, stripComments(readFileSync(f.path, 'utf8'))]));

/**
 * E1 登记表：允许注册指针/鼠标监听的文件 → 一句话理由。
 * **新增一行 = 一次显式决策**（plan §3 批 E）。理由必须说得出「为什么它不能是手势核心」。
 */
const LISTENER_REGISTRY: Record<string, string> = {
  'src-ui/src/app/interaction/use-drag-gesture.ts':
    '手势核心本体：setPointerCapture / 回退窗口监听都住在这里，其余全部经它',
  'src-ui/src/app/overlay.tsx': '外点关闭（useOutsideClose）与 Escape 的唯一实现',
  'src-ui/src/app/tip/tip-host.tsx':
    '窗口切回的可信判据：只读 mousemove/pointerdown 判断用户是否真的动了（不接管手势、不 preventDefault）',
  'src-ui/src/app/window-drag.ts': 'OS 标题栏拖动热区（另一范畴：原生窗口移动）',
  'src-ui/src/ui/resize-zones.ts': 'Linux 无边框窗口缩放热区（调 Tauri 原生缩放，另一范畴）',
  'src-ui/src/plugins/builtin/paper-shell/edge-scroll.ts':
    '边缘自动滚屏的**中止信号**（按下即收）与悬停检测——不是手势，是手势的刹车',
  'src-ui/src/plugins/builtin/paper-shell/use-paper-viewport.ts':
    '画布平移（底座手势本体）+ 拖选自动滚屏（扩选区不是拖东西，C5 判定例外）',
  'src-ui/src/plugins/builtin/paper-shell/use-paper-strips.ts':
    '起手面登记（pressInProse，capture 面唯一的写点）——不是手势',
  'src-ui/src/plugins/builtin/compose-dock/TocStrip.tsx':
    '目次带划扫（自带 setPointerCapture；语义是滚动跟随不是拖放，C5 判定例外）',
};

/** 已收编的九份手势：这些文件**不得**再出现监听注册。 */
const CONVERTED_GESTURES = [
  'src-ui/src/plugins/builtin/paper-shell/use-branch-drag.ts',
  'src-ui/src/plugins/builtin/paper-shell/use-pin-strip-resize.ts',
  'src-ui/src/plugins/builtin/paper-shell/use-region-move.ts',
  'src-ui/src/app/plugin-windows/PluginWindowFrame.tsx',
  'src-ui/src/plugins/builtin/paper-shell/use-composer-float.ts',
  'src-ui/src/plugins/builtin/canvas-nav/SpineRack.tsx',
  'src-ui/src/plugins/builtin/canvas-nav/SessionSidebar.tsx',
  'src-ui/src/plugins/builtin/paper-shell/use-paper-drag.ts',
  'src-ui/src/plugins/builtin/paper-minimap/MinimapView.tsx',
];

/**
 * E3 登记表：允许在 setTimeout 里写毫秒字面量的文件。
 * plan §2.4：「毫秒数只允许出现在**元素即将消失、没有事件可听**的位置」。
 */
const TIMEOUT_REGISTRY: Record<string, string> = {
  'src-ui/src/plugins/builtin/paper-shell/motion-end.ts': '兜底窗本体（MOTION_END_FALLBACK_MS 的唯一归宿）',
  'src-ui/src/app/panels/DockPanel.tsx': 'PANEL_LEAVE_MS：卸载前等待，元素已无（无事件可听）',
  'src-ui/src/app/boot-cover.ts': 'BOOT_COVER_FADE_MS：index.html 早于 tokens.css，读不到 token',
  'src-ui/src/plugins/builtin/paper-shell/use-paper-strips.ts': '3000 = 两击销毁确认的业务计时器（不是动画）',
  'src-ui/src/plugins/builtin/paper-shell/use-paper-focus.ts': 'rAF 逐帧驱动（不是猜结束时刻）',
  // 下面是**业务计时器**（不是动画窗）：它们等的是「用户还要读多久」，不是「动画什么时候结束」。
  // plan §2.4 约束的是后者；前者的毫秒数没有事件可听，也不该有。
  'src-ui/src/plugins/builtin/compose-dock/surface/use-composer-layers.ts': '历史提示 6s 自散（读物停留时长）',
  'src-ui/src/plugins/builtin/paper-shell/use-paper-drag.ts': '钉住可发现性眉批 6s 自散（一次性提示）',
  'src-ui/src/plugins/builtin/paper-shell/use-paper-panel.ts': '溯源点名 1.6s 自散（读数件停留）',
};

/** 只在**交互面**扫 setTimeout（网络重试 / OAuth / 看门狗是另一范畴，扫进来会把门禁变噪声）。 */
const TIMEOUT_SCOPE = [
  'src-ui/src/plugins/builtin/paper-shell/',
  'src-ui/src/plugins/builtin/canvas-nav/',
  'src-ui/src/plugins/builtin/compose-dock/',
  'src-ui/src/plugins/builtin/paper-minimap/',
  'src-ui/src/app/panels/',
];

/** 一句话里的 setTimeout 带毫秒字面量（`setTimeout(() => f(), 260)`）。
 *  **按语句切**而不是按文件全文：多行箭头函数里的实现体不能算进「延迟字面量」
 *  （2026-11-17 实测：全文正则会跨行吃到函数体里的逗号，把三处干净的代码误判成违规）。 */
function hasInlineTimeoutLiteral(src: string): boolean {
  for (const stmt of src.split(/[;\n]/)) {
    if (!stmt.includes('setTimeout(')) continue;
    if (/setTimeout\([^,]*,\s*\d+\s*\)/.test(stmt)) return true;
  }
  return false;
}

describe('交互原语守卫（plan 批 E）', () => {
  it('E1：指针/鼠标监听只许出现在登记表内', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = WITHOUT_COMMENTS.get(f.rel) ?? '';
      if (!LISTENER_RE.test(src)) {
        LISTENER_RE.lastIndex = 0;
        continue;
      }
      LISTENER_RE.lastIndex = 0;
      if (f.rel in LISTENER_REGISTRY) continue;
      offenders.push(f.rel);
    }
    expect(
      offenders,
      '出现了未登记的指针/鼠标监听——要么收进 useDragGesture / useOutsideClose，要么在 LISTENER_REGISTRY 加一行写清理由：',
    ).toEqual([]);
  });

  it('E1b：九份已收编的手势**不得**再自己挂监听（回归即红）', () => {
    const offenders: string[] = [];
    for (const rel of CONVERTED_GESTURES) {
      const src = WITHOUT_COMMENTS.get(rel);
      if (src === undefined) continue; // 文件改名的情形由 E1 兜住
      if (LISTENER_RE.test(src)) offenders.push(rel);
      LISTENER_RE.lastIndex = 0;
    }
    expect(offenders, '这些手势已收进 useDragGesture，不得回退成自己挂监听：').toEqual([]);
  });

  it('E2：「点空白 → 关闭」只许出自 overlay.tsx', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = WITHOUT_COMMENTS.get(f.rel) ?? '';
      if (f.rel === 'src-ui/src/app/overlay.tsx') continue;
      /* 判据：同一文件里既有 document 级 mousedown/pointerdown 注册，又有 contains( ——
       * 那几乎必然是「点外面就关」的手写实现（四条原本就是这么写的）。 */
      const hasDocDown = /document\.addEventListener\(\s*['"](?:mousedown|pointerdown)['"]/.test(src);
      const hasContains = /\.contains\(\s*(?:e|ev|event)\.target/.test(src);
      if (hasDocDown && hasContains) offenders.push(f.rel);
    }
    expect(offenders, '外点关闭必须走 overlay.tsx 的 useOutsideClose（同一份实现、同一个 Escape 门）：').toEqual([]);
  });

  it('E3：setTimeout 的毫秒字面量只许出现在登记文件（交互面）', () => {
    /* **宁窄勿宽**（plan §4 的文档纪律同款）：这条只扫**交互面**目录——纸壳/画布导航/
     * 创作坞/小地图/停靠面板。网络重试、OAuth 轮询、产物看门狗那些 setTimeout 是
     * 业务超时不是动画窗，扫进来只会把门禁变噪声。 */
    const offenders: string[] = [];
    for (const f of FILES) {
      if (!TIMEOUT_SCOPE.some((p) => f.rel.startsWith(p))) continue;
      const src = WITHOUT_COMMENTS.get(f.rel) ?? '';
      if (!hasInlineTimeoutLiteral(src)) continue;
      if (f.rel in TIMEOUT_REGISTRY) continue;
      offenders.push(f.rel);
    }
    expect(
      offenders,
      '动画窗改听事件（transitionend / animationend，见 motion-end.ts）；业务计时器登记进 TIMEOUT_REGISTRY：',
    ).toEqual([]);
  });

  it('登记表本身非空（守卫先证明自己看到了代码）', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(Object.keys(LISTENER_REGISTRY).length).toBeGreaterThan(5);
    expect(CONVERTED_GESTURES.length).toBe(9);
  });

  it('E2 反证：故意写一处违规，判据必须抓到', () => {
    const fake = "document.addEventListener('mousedown', (e) => { if (!el.contains(e.target)) close(); });";
    const hasDocDown = /document\.addEventListener\(\s*['"](?:mousedown|pointerdown)['"]/.test(fake);
    const hasContains = /\.contains\(\s*(?:e|ev|event)\.target/.test(fake);
    expect(hasDocDown && hasContains).toBe(true);
  });
});
