// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AskCardsHost — ask / 权限提示卡的挂载点
// （批 9e-3，2026-09-26 自 `app/chat/PromptShelfHost.tsx` 随包；组件名随包正名）。
//
// 历史（随迁不丢）：V5 拆除后 ChatBeacon 随旧聊天 UI 退役，ask_user / permission-ask 的
// 承接面不能断——它是会话编排域的刚需（无承接 = showPermissionCard 兜底拒绝 = Agent
// 写操作全被静默否决）。
//
// 装载面变更（9e-3）：本组件不再由 App 根硬编码渲染，而是作为 `ctx.rootViews` 的
// `'overlay'` 槽贡献行挂载（App 外壳按槽渲染，槽空 = 该层零渲染）；`core` 改从
// `useCoreStore` 自取（此前由 App 传 prop），注册时序与旧版逐字相同。
//
// 视觉仍是旧观测台暗卡（prompt-shelf.css）——纸面化（朱砂批红卡）归 R5 打磨环 C 段，
// 此处只保功能不断。

import { useEffect, useRef } from 'react';
import { type PromptShelfHandle, useCoreStore } from './host';
import { PromptShelf } from './PromptShelf';

export function AskCardsHost() {
  const core = useCoreStore((s) => s.core);
  const shelfRef = useRef<PromptShelfHandle>(null);
  useEffect(() => {
    // 与旧 ChatBeacon 同款注册时序：ref 句柄在首次提交后即有效
    if (core && shelfRef.current) core.registerPromptShelf(shelfRef.current);
  }, [core]);
  if (!core) return null;
  return (
    <div className="psh-host">
      <PromptShelf ref={shelfRef} />
    </div>
  );
}
