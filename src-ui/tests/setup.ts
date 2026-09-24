// Vitest + jsdom + React act() environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ── 产物实现常驻登记（服务型接缝的测试域复现，批 7b 立规）──
// 生产里这些实现由各自产物包在**装载期**登记进内核登记表，fiber 随根 Context 常驻
// （main.ts → loadBuiltinPlugins）。测试域在这里复现「装载器已跑过」的常驻态。
//
// ⚠ 必须放 **beforeAll + 动态 import**，不能写成模块顶层静态 import：
// 顶层的静态 import 先于测试文件的 `vi.mock` 提升执行，会把 `rpc-contract` 等内核模块
// 预载进模块图、架空 mock（批 6d-2 实测：`plan-outcome` 等全线红）。beforeAll 在测试
// 文件的 import 与 mock 注册之后运行，动态 import 因此落在同一套 mock 图上。
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const [
    { registerMultiagentComm },
    { multiagentCommImplementation },
    { registerSubagentRuntime },
    { subagentRuntimeImplementation },
  ] = await Promise.all([
    import('../src/agent/multiagent-impl'),
    import('../src/plugins/builtin/multiagent-comm/implementation'),
    import('../src/agent/subagent-runtime-impl'),
    import('../src/plugins/builtin/subagent-in-process/implementation'),
  ]);
  registerMultiagentComm(multiagentCommImplementation);
  // 批 7c-2：子代理运行时（池 / 生命周期 / 派生 + 两工具族）整体登记——与产物包 index.ts 同源。
  registerSubagentRuntime(subagentRuntimeImplementation);
});

// jsdom 不实现 CSS.escape（react-aria ListKeyboardDelegate 依赖它拼 [data-key] 选择器）。
// 最小 polyfill 只覆盖本项目 key 字符（vendor/id 斜杠 + 通用标识符转义），够用即可。
const CssGlobal = globalThis.CSS as { escape?: (s: string) => string } | undefined;
if (!CssGlobal || typeof CssGlobal.escape !== 'function') {
  const cssObj = CssGlobal ?? {};
  cssObj.escape = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  if (!CssGlobal) globalThis.CSS = cssObj;
}
