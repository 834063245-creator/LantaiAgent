// Vitest + jsdom + React act() environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不实现 CSS.escape（react-aria ListKeyboardDelegate 依赖它拼 [data-key] 选择器）。
// 最小 polyfill 只覆盖本项目 key 字符（vendor/id 斜杠 + 通用标识符转义），够用即可。
const CssGlobal = globalThis.CSS as { escape?: (s: string) => string } | undefined;
if (!CssGlobal || typeof CssGlobal.escape !== 'function') {
  const cssObj = CssGlobal ?? {};
  cssObj.escape = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  if (!CssGlobal) globalThis.CSS = cssObj;
}
