// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸的拿起次序（画布海拔 P3b，2026-11-22）：最后拿起的那张纸在最上面。
//
// 真源：z = ELEVATION.sheet.z + 带内次序（paper/elevation.ts 的 zOf）。
// 语义：
//   · 初始序 = 摊开序（sessions 序）；新卷追加到队尾；
//   · raise(id) = 把这张纸移到队尾（点/拖 = 拿起）；已在队尾则不动（不触发重渲染）；
//   · 只活在会话内，不落盘——重开画布按摊开序恢复（拿起次序不是布局，别偷偷持久化）。
//
// 为什么不做成 z-index 散写：纸带要能容 900 张卷（100 卷场景不溢出），
// 带内次序必须由一个数组算，不能靠 DOM 顺序（DOM 顺序会被虚拟化/条件渲染打乱）。

import { useCallback, useEffect, useState } from 'react';
import { bumpOrder, syncOrder, zOf } from '../../../paper/elevation';

export function useRegionStack(
  sessions: readonly { id: number }[],
  activeId?: string | number | null,
): {
  raise: (id: string | number) => void;
  zFor: (id: string | number) => number;
} {
  const ids = sessions.map((s) => String(s.id));
  const key = ids.join(',');
  const [order, setOrder] = useState<string[]>(ids);

  // sessions 增删时同步（引用稳定：无变化不 setState）
  useEffect(() => {
    setOrder((prev) => syncOrder(prev, key === '' ? [] : key.split(',')) as string[]);
  }, [key]);

  const raise = useCallback((id: string | number) => {
    setOrder((prev) => bumpOrder(prev, String(id)) as string[]);
  }, []);

  // 任何入口的显式激活（点纸 / 书脊 / 侧栏 / 新建）都升到纸带顶
  useEffect(() => {
    if (activeId != null) raise(activeId);
  }, [activeId, raise]);

  const zFor = useCallback(
    (id: string | number) => {
      const sid = String(id);
      const i = order.indexOf(sid);
      // 还没进序（首帧 / 新卷）时落带底，不抢别人的位
      return zOf('sheet', Math.max(i, 0));
    },
    [order],
  );

  return { raise, zFor };
}
