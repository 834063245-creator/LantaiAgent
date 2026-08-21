// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PromptShelfHost — 权限/ask 提示卡的独立挂载点（V5 拆除，2026-08-22）。
//
// 旧观测台时代 PromptShelf 挂在 ChatBeacon 面板树内（输入框上方）；
// ChatBeacon 随旧聊天 UI 退役后，ask_user / permission-ask 的承接面不能断——
// 它是会话编排域的刚需（无承接 = showPermissionCard 兜底拒绝 = Agent 写操作
// 全被静默否决）。本组件把 PromptShelf 以固定浮层形式挂进 App 根：
// 纸壳（PaperPanel）为唯一主界面，卡片浮于纸面 composer 上方。
//
// 视觉仍是旧观测台暗卡（prompt-shelf.css）——纸面化（朱砂批红卡）归
// R5 打磨环 C 段，此处只保功能不断。

import { useEffect, useRef } from 'react';
import type { ChatCore } from './chat-core';
import { PromptShelf, type PromptShelfHandle } from './PromptShelf';

export function PromptShelfHost({ core }: { core: ChatCore }) {
  const shelfRef = useRef<PromptShelfHandle>(null);
  useEffect(() => {
    // 与旧 ChatBeacon 同款注册时序：ref 句柄在首次提交后即有效
    if (shelfRef.current) core.registerPromptShelf(shelfRef.current);
  }, [core]);
  return (
    <div className="psh-host">
      <PromptShelf ref={shelfRef} />
    </div>
  );
}
