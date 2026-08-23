// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// hello — 兰台插件三通道最小示例（S4 hello 闭环）。
//
// 一个文件、零依赖、零裸 import（bare import 如 'react' / 'zod' 在
// webview 动态 import 语境不可解析——插件运行时没有包管理器也没有
// import map。平台契约：**插件模块必须自包含**。UI 用函数组件经宿主桥
// createElement 构造（无 JSX、无 hook）；工具 schema 手写最小 JSON shape
// 并做入参校验）。
//
// 三通道（装载后即时生效 × 2 + 下次装配生效 × 1——生效时差是平台契约，
// 如实声明不掩盖）：
//   1. ctx.panels  —— 右侧轨道面板「Hello」：三通道状态卡片；
//   2. ctx.commands —— 命令面板（Ctrl+K）「Hello：打个招呼」；
//   3. ctx.tools   —— 模型工具 hello_greet（下次 Agent 装配进工具面）。
// + 第四通道（C11-1 工具声明可序列化）：manifest.tools 声明 hello_status
//   ——声明是 manifest.json 数据（name/description/parameters JSON
//   Schema/readOnly），执行函数是本文件的 toolHandlers 命名导出。装载器
//   挂接（插件不触碰 ctx.tools——信任面更小，装载期即知工具面）。
//
// disposer 纪律：三注册的 disposer 全部经 ctx.effect 登记进本插件的
// fiber（装载期红线：注册动作之外零 UI 副作用；fiber dispose 即干净退出）。
// 声明通道的生命周期归装载器包装层（同样挂本插件 fiber）——本文件零清理代码。

// ── 通道 4：声明式工具（C11-1 manifest.tools + toolHandlers 映射）──
// hello_status 的声明在 manifest.json（纯数据）；此处只出执行函数。
// 行 id = plugin/hello/hello_status（patch/preset 可寻址禁用）；
// 下次 Agent 装配进工具面（与代码通道同时效）。
export const toolHandlers = {
  hello_status: async () =>
    'hello 插件四通道已装载（面板 / 命令 / 代码通道工具 / 声明通道工具）——' +
    '来自 manifest.tools 声明通道（C11-1 工具声明可序列化）',
};

export default {
  name: 'hello',
  inject: ['panels', 'commands', 'tools'],
  apply(ctx) {
    // ── 宿主桥（plugins/loader 装载期注入；无桥时降级）──
    // createElement：React.createElement 形状（面板组件用）；
    // notify：状态栏通知（命令动作用）。
    const host = globalThis.__lantai_plugin_host__;
    const ce = host?.createElement ?? ((type, props, ...children) => ({ type, props: { ...props, children } }));

    // ── 通道 1：面板（即时生效——panelDefs 合流点 + bump 信号）──
    const Panel = function HelloPanel() {
      return ce(
        'div',
        {
          style: {
            padding: '16px',
            margin: '10px 12px',
            border: '1px solid rgba(120, 160, 255, 0.25)',
            borderRadius: '8px',
            background: 'rgba(16, 22, 40, 0.6)',
            color: '#d8e2ff',
            fontSize: '12px',
            lineHeight: '1.9',
          },
        },
        ce('div', { style: { letterSpacing: '0.1em', marginBottom: 8 } }, '◈ HELLO PLUGIN'),
        '四通道示例已装载：',
        ce('div', { style: { opacity: 0.75 } }, '· 面板（本卡片）——即时生效'),
        ce('div', { style: { opacity: 0.75 } }, '· 命令面板（Ctrl+K）搜「Hello」——即时生效'),
        ce('div', { style: { opacity: 0.75 } }, '· 工具 hello_greet（ctx.tools 代码通道）——下次 Agent 装配生效'),
        ce('div', { style: { opacity: 0.75 } }, '· 工具 hello_status（manifest.tools 声明通道）——下次 Agent 装配生效'),
      );
    };
    ctx.effect(
      () =>
        ctx.panels.register({
          id: 'hello-panel',
          side: 'right',
          title: 'Hello',
          icon: 'agent',
          component: Panel,
        }),
      'hello-panel',
    );

    // ── 通道 2：命令（即时生效——CommandPalette 合流点）──
    ctx.effect(
      () =>
        ctx.commands.register({
          id: 'hello/say-hi',
          label: 'Hello：打个招呼',
          group: '插件',
          shortcut: '/hello',
          action: {
            type: 'local',
            handler: () => {
              if (host?.notify) host.notify('Hello 插件向你打个招呼 👋');
              else console.info('[hello] Hello 插件向你打个招呼 👋');
            },
          },
        }),
      'hello-command',
    );

    // ── 通道 3：工具（下次装配生效——pluginToolRows 折算进 buildToolRegistry）──
    ctx.effect(
      () =>
        ctx.tools.register({
          id: 'hello/greet',
          factory: () => ({
            name: () => 'hello_greet',
            description: () => 'hello 插件示例工具：返回一句问候（S4 三通道示例的工具通道）',
            parameters: () => ({
              type: 'object',
              properties: {
                name: { type: 'string', description: '要问候的名字（缺省 World）' },
              },
            }),
            readOnly: () => true,
            execute: async (args) => {
              const name =
                args && typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : 'World';
              return `Hello, ${name}! —— 来自 hello 插件的问候（工具通道，经装配面注册）`;
            },
          }),
        }),
      'hello-tool',
    );
  },
};
