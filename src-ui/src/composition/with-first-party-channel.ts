// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 第一方通道装配腰（M4 收口，2026-09-14）——三条通道腰的唯一实现。
//
// 缘起：first-party-{tools,prompts,capabilities}.ts 各自带一份**逐字相同**的装配腰
// （根 Context + 先装本通道 service 插件 + 逐个装清单插件 + 逆序 dispose），三份
// 只在「装哪个 service、装哪些贡献者」上不同——是复制粘贴而非三种语义。M4 把它
// 上收到这里，三个导出名与签名保持原样（消费面是约 20 个测试文件的
// withFirstPartyXChannel 调用，本次零改动）。
//
// 三条纪律（原三份各自写在注释里，现收在一处）：
//   ① **先装 service 再装贡献者**：清单插件的 inject 声明了对应通道名
//      （如 inject: ['tools']），cordis 的 inject 解析要求被依赖的 service 已在根
//      store；反过来先装贡献者会撞 "cannot get property X without inject"。
//   ② **拆卸必须逆序**：service 的 dispose 守卫式清空模块级「活动读取面」
//      （activeToolContributions / activePromptContributions / activeCapabilities…），
//      而贡献者的 disposer 要在服务还活着时注销自己的行。正序拆会留下注销不到的
//      行 → 贡献残留污染后续装配（vitest 同 worker 模块态跨测试共享 = 静默串味）。
//   ③ **本腰只服务无 UI 引导环境**（convergence 夹具 / 契约文档生成 / 单测）：
//      生产路径是 main.ts → loadBuiltinPlugins，装载器是唯一引导入口，本腰不是
//      第二条生产路。

import { Context } from '../cordis';
import type { LantaiPlugin } from '../plugins/types';

/** 一次腰内装载产出的 fiber 句柄（`ctx.plugin()` 的可等待结果）。 */
type FiberHandle = Awaited<ReturnType<Context['plugin']>>;

/**
 * 在「若干 service 插件 + 若干贡献者插件」的装配面激活期间执行 run（通道随调用拆卸）。
 *
 * @param servicePlugins 本通道的 service 注册表插件（先装——inject 解析前提）
 * @param contributors   本通道的第一方贡献者插件（清单单一真源来自调用方）
 * @param run            腰内执行体
 */
export async function withFirstPartyChannel<T>(
  servicePlugins: readonly LantaiPlugin[],
  contributors: readonly LantaiPlugin[],
  run: () => Promise<T>,
): Promise<T> {
  const root = new Context();
  const fibers: FiberHandle[] = [];
  for (const plugin of servicePlugins) fibers.push(await root.plugin(plugin));
  for (const plugin of contributors) fibers.push(await root.plugin(plugin));
  try {
    return await run();
  } finally {
    for (let i = fibers.length - 1; i >= 0; i--) await fibers[i].dispose();
  }
}
