// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 实测回写桥域（paper-panel-split C1）——静态镜像管不了的动态高由
// ResizeObserver 实测兜底；measureTick 是全画布测量缓存（paper/measure）
// 的显式失效信号（regions memo 消费）。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearPaperMeasureCache,
  MARGINALIA_TOP,
  reportObservedBlockHeight,
  reportObservedSidecarExtent,
  subscribeObservedBlockHeights,
} from './measure';

/** 块实测回写（paper-panel-split C1，自 PaperPanel 903-966 域内原样搬入）。
 *  - measureTick：字体加载（webfont 到位前 canvas 量的是回退字体宽度）→ 清全
 *    局测量缓存 + bump；RO 实测变化 → bump。渲染面以 measureTick 为依赖
 *    重读缓存（paper/measure 的模块级缓存不订阅 React）。
 *  - blockRootRef：块根 callback ref——需实测的块（资产/开放/拟策/公式表格
 *    markdown/**夹注**）挂载即观察。data-block-observed = 观测键（块 id + 渲染态，
 *    paper/measure.observedKeyOf 单一真源）。
 *    挂载首报（registered）= 校准登记：只写入不重排——滚动虚拟化中逐卡挂载
 *    逐卡立即全局重排会脉冲成整条流抽搐（2026-08-31 修复），改为 120ms 去抖
 *    一次收敛；首报后值再变（changed：媒体图加载等动态高）才即时 bump；
 *    渲染态翻转（restated：折叠/眉批/钉住换盒子）同走即时——用户手势刚落，
 *    等 120ms 会看见块错位一瞬（2026-09-19 夹注叠字批）。
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
  /** 眉批栏（`.pp-marginalia`）目标表：出流子件，块级 RO 报不出它的高（绝对定位），
   *  单独观察、单独上报（paper/measure.reportObservedSidecarExtent）。 */
  const sidecarRoElIds = useRef(new WeakMap<Element, string>());
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
      /* 观测键 = 块 id + 渲染态（paper/measure.observedKeyOf 单一真源）——RO 报的
       * 是「当前那个盒子」的尺寸，键不带态就会把折叠态的读数喂给展开态。
       * 键格式由 measure 侧拆解（splitObservedKey），壳层只当中转。 */
      const key = el.dataset.blockObserved;
      if (!key) return;
      if (!blockRoRef.current) {
        blockRoRef.current = new ResizeObserver((entries) => {
          for (const e of entries) {
            const box = e.borderBoxSize?.[0];
            const target = e.target as HTMLElement;
            const sidecarKey = sidecarRoElIds.current.get(e.target);
            if (sidecarKey) {
              // 眉批栏 extent = 顶距 + 栏高（块高按设计要容下它，见 paper/measure 头注）
              reportObservedSidecarExtent(sidecarKey, (box ? box.blockSize : target.offsetHeight) + MARGINALIA_TOP);
              continue;
            }
            const ekey = blockRoElIds.current.get(e.target);
            if (!ekey) continue;
            const verdict = reportObservedBlockHeight(
              ekey,
              box ? box.inlineSize : target.offsetWidth,
              box ? box.blockSize : target.offsetHeight,
            );
            // 首报/换宽校准登记：去抖一次收敛（changed/restated 已由订阅即时重排）
            if (verdict === 'registered') scheduleConverge();
          }
        });
      }
      blockRoElIds.current.set(el, key);
      blockRoRef.current.observe(el);
      /* 眉批栏是块内的绝对定位子件：块级 RO 只报块的边框盒（不含它），而块高
       * 按设计 = max(正文, 眉批 extent)——故同样观察它、单独上报。
       * 挂载时刻取（眉批随块一起渲染；流式路径下块是带 sidecar 新建的）。 */
      const aside = el.querySelector('.pp-marginalia');
      if (aside) {
        sidecarRoElIds.current.set(aside, key);
        blockRoRef.current.observe(aside);
      }
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
