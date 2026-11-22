// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 光影场景表（2026-11-22）：**这里就是"能做很多种光影"的那张表**。
//
// 加一种新光影 = 往本文件加一段数据（房间 + 光源 + 遮光物），渲染代码一行不动：
//   · 换遮光物 = 换形状（窗格 / 百叶 / 树影）
//   · 换 tint = 换时间（清晨偏冷、午后偏金、黄昏偏橙）
//   · 加 glow = 从"白天的影子"变成"夜里发光的灯"
//   · 换 room.level = 换"房间里有多亮"（1 = 完全没有环境差别）
// 每个场景都过同一套两向护栏（暗不破 4.5:1、亮也不破），所以**加场景不会把字做糊**。
//
// 数值口径：pass = 直射光透过率；shade = 环境光被遮掉多少（影子沉不沉的唯一来源）。

import type { Scene } from './light';

/** 出厂场景（可在设置里切；缺省 = 晨光） */
export const DEFAULT_SCENE = 'morning-window';

export const SCENES: Record<string, Scene> = {
  /* 晨光：窗格投在纸上，纸几乎保持本色（平均只暗 6%），安静、不夺字 */
  'morning-window': {
    id: 'morning-window',
    name: '晨光 · 窗格',
    room: { level: 0.94, tint: [0.985, 0.995, 1.0] },
    sources: [
      {
        kind: 'sun',
        strength: 1,
        tint: [1.0, 0.965, 0.918],
        occluders: [
          {
            kind: 'pane',
            area: { x: 0.5, y: 0.44, width: 0.66, height: 0.8 },
            columns: 3,
            rows: 2,
            skew: 0.3,
            softness: 22,
            pass: 0.2,
            shade: 0.17,
          },
        ],
      },
    ],
  },

  /* 午后百叶：横条影子，光偏金 —— 同一个太阳，只换了遮光物 */
  'afternoon-blinds': {
    id: 'afternoon-blinds',
    name: '午后 · 百叶',
    room: { level: 0.95, tint: [0.99, 0.995, 1.0] },
    sources: [
      {
        kind: 'sun',
        strength: 1,
        tint: [1.0, 0.94, 0.86],
        occluders: [
          {
            kind: 'slats',
            area: { x: 0.5, y: 0.46, width: 0.72, height: 0.84 },
            count: 14,
            skew: 0.22,
            softness: 10,
            pass: 0.3,
            shade: 0.18,
          },
        ],
      },
    ],
  },

  /* 庭院树影：噪声斑驳，边缘更软 —— 形状换成噪声，其余不变 */
  'dappled-tree': {
    id: 'dappled-tree',
    name: '庭院 · 树影',
    room: { level: 0.95, tint: [0.99, 0.998, 1.0] },
    sources: [
      {
        kind: 'sun',
        strength: 1,
        tint: [1.0, 0.97, 0.9],
        occluders: [
          {
            kind: 'dapple',
            area: { x: 0.5, y: 0.46, width: 0.8, height: 0.88 },
            scale: 0.085,
            softness: 14,
            pass: 0.46,
            shade: 0.15,
            seed: 7,
          },
        ],
      },
    ],
  },

  /* 阴天：没有直射光，只有一层均匀的环境光 —— "无光影"的基线（也是回滚开关） */
  overcast: {
    id: 'overcast',
    name: '阴天 · 匀光',
    room: { level: 0.97, tint: [0.995, 0.998, 1.0] },
    sources: [],
  },

  /* 台灯夜读：点光 + 加色辉光（screen 通道）—— 夜里要发亮，就得开 glow */
  'night-lamp': {
    id: 'night-lamp',
    name: '夜读 · 台灯',
    room: { level: 0.62, tint: [0.9, 0.93, 1.0] },
    sources: [
      {
        kind: 'spot',
        strength: 1,
        tint: [1.0, 0.855, 0.62],
        x: 0.3,
        y: 0.18,
        height: 1.0,
        spread: 76,
      },
    ],
    glow: { level: 0.5, tint: [1.0, 0.88, 0.7] },
  },
};

/** 场景 id 列表（设置面板 / 预览用） */
export const SCENE_IDS = Object.keys(SCENES);
