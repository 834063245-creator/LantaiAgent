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
    { registerMarkdownBody },
    { MarkdownBody },
    { initCordisKernel },
    { lspServicePlugin },
    { agentLoopServicePlugin },
    { tokenMeterServicePlugin },
    { registerSkillImplementation },
    { skillImplementation },
    { registerMemoryImplementation },
    { memoryImplementation },
  ] = await Promise.all([
    import('../src/agent/multiagent-impl'),
    import('../src/plugins/builtin/multiagent-comm/implementation'),
    import('../src/agent/subagent-runtime-impl'),
    import('../src/plugins/builtin/subagent-in-process/implementation'),
    import('../src/paper/markdown-body-seam'),
    import('../src/plugins/builtin/paper-renderers/renderers'),
    import('../src/cordis/boot'),
    import('../src/ui/lsp-client'),
    import('../src/plugins/builtin/agent-loop-service'),
    import('../src/agent/token-meter/service'),
    import('../src/agent/skill-impl'),
    import('../src/plugins/builtin/skill-domain'),
    import('../src/agent/memory-impl'),
    import('../src/plugins/builtin/memory-domain'),
  ]);
  registerMultiagentComm(multiagentCommImplementation);
  // 批 7c-2：子代理运行时（池 / 生命周期 / 派生 + 两工具族）整体登记——与产物包 index.ts 同源。
  registerSubagentRuntime(subagentRuntimeImplementation);
  // 批 8b：markdown 体渲染（纸面块渲染器产物 paper-renderers 的 apply 期登记项）——
  // 重查看器（ipynb / markdown-doc）复用面，测试域复现「产物已装载」的常驻态。
  registerMarkdownBody(MarkdownBody);
  // 批 9b §4-13：`ctx.lsp` 入内核清单后，**兜底实例由内核 service 提供**（此前是自建第二个
  // 根 Context）——测试域复现「loader 已跑过」：在内核根 Context 上挂 lspServicePlugin。
  const kernel = initCordisKernel();
  kernel.plugin(lspServicePlugin);
  // 批 9h-2：出厂默认 agent loop 随包后，内核 `resolveAgentLoop()` 不再兜底（无服务 = 具名
  // fail-loud）⇒ 测试域复现装载态：在同一个内核根 Context 上挂 agent-loop-service 产物
  // （构造期登记 `builtin/default` 并写活动面）。
  kernel.plugin(agentLoopServicePlugin);
  // §4-6 A（2026-09-26）：token 计量升为内核第 16 个 service 后，Agent 构造期经
  // `requireTokenMeter().createLedger()` 造每卷账本（缺服务 = 具名 fail-loud）⇒
  // 测试域同一根 Context 上挂 tokenMeterServicePlugin，复现「loader 已跑过」。
  kernel.plugin(tokenMeterServicePlugin);
  // 批 9h-3：技能域实现随 skill-domain 包后，内核 `createSkillRegistry` / `scanSkills`
  // 门面缺实现即 fail-loud ⇒ 测试域登记同一份实现对象（与包 index.ts 同源）。
  registerSkillImplementation(skillImplementation);
  // 批 9h-4：记忆域实现随 memory-domain 包后，内核 `createMemoryManager` / `memoryBundleIngest`
  // 门面缺实现即 fail-loud ⇒ 测试域登记同一份实现对象（与包 index.ts 同源）。
  registerMemoryImplementation(memoryImplementation);
});

// jsdom 不实现 CSS.escape（react-aria ListKeyboardDelegate 依赖它拼 [data-key] 选择器）。
// 最小 polyfill 只覆盖本项目 key 字符（vendor/id 斜杠 + 通用标识符转义），够用即可。
const CssGlobal = globalThis.CSS as { escape?: (s: string) => string } | undefined;
if (!CssGlobal || typeof CssGlobal.escape !== 'function') {
  const cssObj = CssGlobal ?? {};
  cssObj.escape = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  if (!CssGlobal) globalThis.CSS = cssObj;
}
