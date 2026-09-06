// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 实测回写桥域（paper-panel-split C1）——静态镜像管不了的动态高由
// ResizeObserver 实测兜底；measureTick 是全画布测量缓存（paper/measure）
// 的显式失效信号（regions memo 消费）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { clearPaperMeasureCache, reportObservedBlockHeight, subscribeObservedBlockHeights } from './host';

/** 块实测回写（paper-panel-split C1，自 PaperPanel 903-966 域内原样搬入）。
 *  - measureTick：字体加载（webfont 到位前 canvas 量的是回退字体宽度）→ 清全
 *    局测量缓存 + bump；RO 实测变化 → bump。渲染面以 measureTick 为依赖
 *    重读缓存（paper/measure 的模块级缓存不订阅 React）。
 *  - blockRootRef：块根 callback ref——资产/开放/拟策块挂载即观察。
 *    挂载首报（registered）= 校准登记：只写入不重排——滚动虚拟化中逐卡挂载
 *    逐卡立即全局重排会脉冲成整条流抽搐（2026-08-31 修复），改为 120ms 去抖
 *    一次收敛；首报后值再变（changed：媒体图加载等动态高）才即时 bump。
 *    RO 读布局盒（transform 缩放不影响）——世界单位与 CSS px 同源。 */
export function useBlockMeasure() {
  /* 字体加载后重测：webfont 到位前 canvas 量的是回退字体宽度 */
  const [measureTick, setMeasureTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(() => {
      if (!alive) return;
      clearPaperMeasureCache();
      setMeasureTick((t) => t + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  const blockRoRef = useRef<ResizeObserver | null>(null);
  const blockRoElIds = useRef(new WeakMap<Element, string>());
  /* 首报收敛去抖：滚动中不断有新卡挂载，逐次重排 = 布局脉冲；停下 120ms 后
   * 一次收敛全部登记（媒体图/反馈框等挂载后动态高仍走 changed 即时重排）。 */
  const convergeTimerRef = useRef<number | null>(null);
  const scheduleConverge = useCallback(() => {
    if (convergeTimerRef.current) window.clearTimeout(convergeTimerRef.current);
    convergeTimerRef.current = window.setTimeout(() => {
      convergeTimerRef.current = null;
      setMeasureTick((t) => t + 1);
    }, 120);
  }, []);
  useEffect(
    () => () => {
      if (convergeTimerRef.current) window.clearTimeout(convergeTimerRef.current);
    },
    [],
  );
  const blockRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return; // 卸载清理由 RO 弱目标语义 + WeakMap GC 兜底（记录保留防振荡）
      if (typeof ResizeObserver === 'undefined') return; // jsdom 测试环境无 RO
      const id = el.dataset.blockObserved;
      if (!id) return;
      if (!blockRoRef.current) {
        blockRoRef.current = new ResizeObserver((entries) => {
          for (const e of entries) {
            const eid = blockRoElIds.current.get(e.target);
            if (!eid) continue;
            const box = e.borderBoxSize?.[0];
            const target = e.target as HTMLElement;
            const verdict = reportObservedBlockHeight(
              eid,
              box ? box.inlineSize : target.offsetWidth,
              box ? box.blockSize : target.offsetHeight,
            );
            // 首报校准登记：去抖一次收敛（changed 已由订阅即时重排）
            if (verdict === 'registered') scheduleConverge();
          }
        });
      }
      blockRoElIds.current.set(el, id);
      blockRoRef.current.observe(el);
    },
    [scheduleConverge],
  );
  useEffect(() => subscribeObservedBlockHeights(() => setMeasureTick((t) => t + 1)), []);
  useEffect(
    () => () => {
      blockRoRef.current?.disconnect();
      blockRoRef.current = null;
    },
    [],
  );

  return { measureTick, blockRootRef };
}
