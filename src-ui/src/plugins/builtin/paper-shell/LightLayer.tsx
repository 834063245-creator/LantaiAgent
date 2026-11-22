// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LightLayer — 画布的光影层（2026-11-22）：把 light.ts 渲染出的两通道摆到屏幕上。
//
//   multiply 通道（.pp-light）：光在纸上照出的**影子**。fixed 铺满视口，纸在它下面滑。
//   screen 通道（.pp-glow）  ：光本身**发亮**。只有声明了 glow 的场景才挂（白天场景没有层，
//                              所以不会把纸洗白）。
//
// 参照系纪律（用户 2026-11-22 定）：一层 fixed 铺满窗口，按视口坐标算；**不是**每张纸
// 一盏灯（第一版错在这里：每卷一盏、亮斑随纸平移，一屋子三个太阳）。
//
// 场景来自 light-scenes.ts（数据表）。改光影不动本文件；本文件只在换场景 / 窗口尺寸
// 变化时重画一次——静态层，不进 rAF。

import { useEffect, useRef } from 'react';
import { renderScene, type Scene } from '../../../paper/light';
import { DEFAULT_SCENE, SCENES } from '../../../paper/light-scenes';

interface LightLayerProps {
  /** 场景 id（缺省用出厂场景） */
  sceneId?: string;
  /** 直接给场景对象（预览/测试用，优先于 sceneId） */
  scene?: Scene;
}

export function LightLayer({ sceneId, scene }: LightLayerProps) {
  const multiplyRef = useRef<HTMLCanvasElement | null>(null);
  const glowRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const multiplyCanvas = multiplyRef.current;
    if (!multiplyCanvas) return;
    const resolved = scene ?? SCENES[sceneId ?? ''] ?? SCENES[DEFAULT_SCENE];
    const context = multiplyCanvas.getContext('2d');
    if (!context || typeof context.createImageData !== 'function') {
      // 宿主没给 2D canvas 实现（happy-dom 测试环境 / 极端降级）：装饰层不画，
      // 纸与字照常可读。告警而不抛——一扇窗画不出光，不该炸掉整个画布。
      console.warn('LightLayer: 2D canvas 不可用，本窗口不画光影');
      return;
    }

    const paint = (): void => {
      const frame = renderScene(resolved, { width: window.innerWidth, height: window.innerHeight });
      const put = (canvas: HTMLCanvasElement | null, data: Uint8ClampedArray | null): void => {
        if (!canvas) return;
        if (!data) {
          canvas.style.display = 'none';
          return;
        }
        canvas.style.display = 'block';
        canvas.width = frame.cols;
        canvas.height = frame.rows;
        const ctx = canvas.getContext('2d');
        if (!ctx || typeof ctx.createImageData !== 'function') return;
        const image = ctx.createImageData(frame.cols, frame.rows);
        image.data.set(data);
        ctx.putImageData(image, 0, 0);
      };
      put(multiplyCanvas, frame.multiply);
      put(glowRef.current, frame.glow);
    };

    paint();
    window.addEventListener('resize', paint);
    return () => window.removeEventListener('resize', paint);
  }, [scene, sceneId]);

  return (
    <>
      <canvas ref={multiplyRef} className="pp-light" />
      <canvas ref={glowRef} className="pp-glow" />
    </>
  );
}
