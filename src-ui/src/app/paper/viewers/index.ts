/// <reference types="vite/client" />

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/paper/viewers — **重依赖查看器装载面**（P2，2026-09-23）。
//
// 为什么需要它：产物域禁动态裸 import（`scripts/build-builtin-plugins.mjs` 的自包含闸），
// pdfjs / mermaid / three 这类重依赖只能随**应用 bundle** 编译（vite 真分片）。查看器
// 注册面（认领 / 降级 / 热更）仍在产物里，只有**组件本体**走这条路——产物侧的
// `ViewerDef.heavy = '<id>'` 声明取件键，宿主渲染前经宿主桥 `loadViewer(id)` 取组件。
//
// **目录即白名单**：本目录下每个 `<id>.tsx` 就是一个可取件的重查看器（default 导出组件，
// 收 `ViewerProps`）。新增重查看器 = 放一个文件（分片自动生成）；id 不存在 ⇒ 抛错
// （宿主转成「文件壳 + 可读错误」，不静默）。
//
// 与轻查看器的分工：能在产物里跑的（零依赖/自绘/复用既有原语）一律留产物（热更）；
// 只有真重依赖才进这里（代价：该批要重建 exe）。

import type { ComponentType } from 'react';
import type { ViewerProps } from '../../../plugins/builtin/renderers/viewer-registry';

/** vite 静态分析出本目录全部 `<id>.tsx` → 各自一个分片（懒加载，不进入口 chunk）。 */
const modules = import.meta.glob<{ default: ComponentType<ViewerProps> }>('./*.tsx');

/** 可取件的重查看器 id（诊断面；也供测试断言「目录 = 白名单」）。 */
export function heavyViewerIds(): string[] {
  return Object.keys(modules)
    .map((k) => k.replace(/^\.\//, '').replace(/\.tsx$/, ''))
    .sort();
}

/** 按 id 取重查看器组件（未注册/无 default ⇒ 抛错，由宿主转成可读错误）。 */
export async function loadHeavyViewer(id: string): Promise<ComponentType<ViewerProps>> {
  const loader = modules[`./${id}.tsx`];
  if (!loader) {
    const known = heavyViewerIds();
    throw new Error(`未注册的重查看器「${id}」（可取件：${known.length > 0 ? known.join(' / ') : '（目录为空）'}）`);
  }
  const mod = await loader();
  const comp = mod.default;
  if (comp == null || (typeof comp !== 'function' && typeof comp !== 'object')) {
    throw new Error(`重查看器「${id}」没有 default 导出组件`);
  }
  return comp;
}
