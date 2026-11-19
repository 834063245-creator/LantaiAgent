// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// draft-folio — **待题纸的题签行**（2026-11-19 题签重画批）。
//
// 病灶（用户：「题签有点丑爆了……还不如创作坞直接放屏幕中间」）：2026-11-28 那版把
// 「这一卷打算怎么跑」做成**贴在纸上的一枚纸签**——832×89 的 --paper-deep 色块，左端
// 32px 朱印、转 −0.22° 的假歪、双硬投影，里面塞三样**根本不是一类**的控件（组合 =
// 人的制度 / 权限 = 人的闸门 / 模型 = 机器的脑子，还自带厂章 + 600 字重 + 档位后缀的
// 整套触发器语汇），底下再复述一遍人话。更根本的是隐喻不成立：流区块是「印在纸上的
// 墨」（§11 纸内件无投影），在印了墨的纸上再贴一张纸只能靠硬投影硬凹层次。
//
// 现行 = **题签升为卷首档行**：三笔落进天头第三行（原来那句「题签随首句落账 · 卷号于
// 发送时发出」所在的位置），与玉徽/眉行/题字**同轴**（版心铁律 2026-09-16），零新增
// 材质（无底色、无投影、无假歪、无朱印——「一屏至多一处红」还给眉行）。静止时读作
// **一行读数**，hover 才亮 caret（§11 锚点型选中：不是三枚常驻控件）。
//
// 为什么独立成件、独立成槽：纸有两处宿主——输入面在天头之下（'draft-sheet' 槽，
// ComposerDock 的另一次挂载），题签在**天头之内**（'draft-folio' 槽，本件）。两者
// **同生同灭**（纸拿焦点才挂）但**结构相邻却不互含**：DraftSheet 渲染天头，本件经槽
// 注册被它取用（热注册即时重取）。
//
// ⚠ 跨插件直引的红线（同 ComposerSheet 头注）：组合/模型/权限三枚控件的实现不住这里
// ——本件只做「一行字」，三枚件的挂法由 compose-dock 贡献（它已经算好了读数与写入口）。
// 本件因此只吃 overlays 槽，一字不知 store。

import { useEffect, useState } from 'react';
import { activeOverlayContributions, subscribeOverlayContributions } from './host';

/** 题签行（天头第三行）：槽内贡献在这里挂载——空槽 = 不渲染（零新增噪声）。 */
export function DraftFolioLine() {
  /* 贡献热注册即时重取（同 DraftSheet 的输入面槽）：插件重载时本行不塌。 */
  const [, setOverlayTick] = useState(0);
  useEffect(() => subscribeOverlayContributions(() => setOverlayTick((t) => t + 1)), []);
  const contributions = activeOverlayContributions('draft-folio');
  if (contributions.length === 0) return null;
  return (
    <div className="pp-folio-picks" data-draft-folio>
      {contributions.map((def) => (
        <def.component key={def.id} />
      ))}
    </div>
  );
}
