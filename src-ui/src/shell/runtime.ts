// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳运行时句柄（S2-0 类型层 / S2-3 实例化）—— main.ts 模块级单例的归宿。
//
// 定位（S2 设计件 §2.6）：ShellRefs 是应用级单例句柄集合（starGraph /
// chatPanel / workspace / 状态机），不是面板业务状态——非响应式 imperative
// 句柄，不进 zustand、不触 INVARIANTS #1（对齐 app/shell-store 的 app 级
// 单例先例，但本件连 store 都不是：纯 TypeScript 对象，壳行 boot 的唯一
// 入参）。实例容器（refs 单例 + FileViewer 惰性句柄）随 S2-3 壳行化落地。
//
// 可空性契约：starGraph 在 WebGL2 不可用时为 null（main.ts 现状的兜底
// 分支保留）；workspace 在无活动工作区时为 null；chatPanel 构造于壳行
// boot 期、其后恒非空（boot 前为 null）。壳行代码沿用 main.ts 现状判空
// 纪律——不假设前行必然成功（失败隔离：单行 boot 抛错不炸整个引导）。

import type { ChatCore } from '../app/chat/chat-core';
import type { WorkspaceStateMachine } from '../lifecycle/state-machine';
import type { StarGraph } from '../scene/graph';
import type { Workspace } from '../workspace';

/** 壳引导期共享句柄集合 — 壳行 boot(refs) 的唯一入参。 */
export interface ShellRefs {
  starGraph: StarGraph | null;
  chatPanel: ChatCore | null;
  workspace: Workspace | null;
  wsMachine: WorkspaceStateMachine;
}
