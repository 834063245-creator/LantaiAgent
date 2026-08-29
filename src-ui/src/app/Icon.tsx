// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ui/icons.ts 的 React 封装 — 统一走 iconSvg，避免复制图标定义。

import { iconSvg } from '../ui/icons';

export function Icon({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', flex: 'none' }}
      // 装饰性图标（2026-08-29 走查）：语义由宿主按钮的 title/aria-label 承载，
      // 内联 SVG 不再进无障碍树干扰读屏播报。
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: iconSvg 是本仓库静态 SVG 定义（ui/icons.ts），非用户输入
      dangerouslySetInnerHTML={{ __html: iconSvg(name, size) }}
    />
  );
}
