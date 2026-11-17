// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-header — 创作坞的书眉行（2026-11-17 上帝文件治理 P6 拆出；语义零新增）。
//
// 书眉行（2026-11-09 用户裁定：**模型与权限另起一行**）——左端卷名，右端只有读数 + 移。
// 用户原话：「模型选择和权限选择还是得另起一行，现在的 UX 好奇怪」。
// 判据修正（翻 2026-11-08 丙案「模型是书眉级身份」那条）：书眉是**这一卷的账**
// （哪一卷 + 还有什么在跑），换模型与拨权限是**动作**——动作与账挤在同一行，
// 读起来就是「卷名右边跟着一串控件」。模型+权限回到自成一行（它俩同属「这一趟怎么跑」）。
//
// 本件只吃 props：读数（役册/墨量册）、拖动锁能力位、后台卷清单全由坞算好传进来。

import { volumeDisplayName } from '../../../state/volume-name';
import type { WorkEntry } from './host';
import { agentSessionState, killShellWork } from './host';
import { InkLedger } from './InkLedger';
import { WorkLedger } from './WorkLedger';

export interface ComposerHeaderProps {
  /** 活跃卷（`null` = 无主待命态：卷位报「新卷」，役/墨两册不渲染）。 */
  activeSession: { id: number; label: string } | null;
  /** 活跃卷号（null = 无主待命态：役/墨两册与图版读数都不渲染）。 */
  activeSidNum: number | null;
  panelId: string;
  tokenStats: Parameters<typeof InkLedger>[0]['stats'];
  tokenCount: number;
  sessionNameOf: (sid: number | null) => string;
  /** 跳到别卷（「他卷」行整行可点；宿主不给 ⇒ 只读读数）。 */
  onGoToSession?: (sessionId: number) => void;
  composerLock?: { unlocked: boolean; toggle: () => void };
  workOpen: boolean;
  inkOpen: boolean;
  onToggleWork: () => void;
  onToggleInk: () => void;
  bgRunning: ReadonlyArray<{ id: number; label: string }>;
}

export function ComposerHeader({
  activeSession,
  activeSidNum,
  panelId,
  tokenStats,
  tokenCount,
  sessionNameOf,
  composerLock,
  onGoToSession,
  workOpen,
  inkOpen,
  onToggleWork,
  onToggleInk,
  bgRunning,
}: ComposerHeaderProps) {
  return (
    <div className="pp-composer-header">
      <span
        className="pp-composer-target"
        // hover 文案 = **显示名**（2026-09-21 卷号收显示）：旧实现硬报 `案卷 ${id}`——
        // 对有名卷也报号（同元素下一行就有名字），且裸用 id 绕过了单一真源
        // `volumeDisplayName`（state/volume-name 纪律①：禁在调用点散写）。
        data-tip={activeSession ? volumeDisplayName(activeSession.label, activeSession.id) : '落笔即另起一卷'}
      >
        {activeSession ? volumeDisplayName(activeSession.label, activeSession.id) : '新卷'}
      </span>
      <div className="pp-composer-settings-spacer" />
      {/* 书眉工具带（2026-11-09 密度批后只剩**移/锁**）：拖动锁是槽主人（纸壳）
        的能力位——宿主不给 composerLock ⇒ 整枚不出现，坞不知道锁态。常显可点、
        不做悬停浮现：前者是用户报的「不知道能拖」，后者是用户报的「还没挪过去
        就消失了」。翰/律 于同日撤出本行（「案」抽屉里已各有一份，书眉那两枚是重复）。 */}
      {activeSidNum != null && (
        <WorkLedger
          panelId={panelId}
          sessionId={activeSidNum}
          sessionLabel={volumeDisplayName(activeSession?.label, activeSidNum)}
          sessionNameOf={sessionNameOf}
          onGoToSession={onGoToSession}
          onStop={(e: WorkEntry) => {
            const jobId = Number.parseInt(e.id.replace(/^job-/, ''), 10);
            if (Number.isFinite(jobId)) void killShellWork(panelId, jobId);
          }}
          open={workOpen}
          onToggle={onToggleWork}
        />
      )}
      {activeSidNum != null && (
        <InkLedger
          stats={tokenStats}
          sessionLabel={volumeDisplayName(activeSession?.label, activeSidNum)}
          fallbackTotal={tokenCount}
          open={inkOpen}
          onToggle={onToggleInk}
        />
      )}
      <div className="pp-dock-tools">
        {composerLock && (
          <button
            type="button"
            className={`pp-tool-btn${composerLock.unlocked ? ' open' : ''}`}
            aria-pressed={composerLock.unlocked}
            aria-label={composerLock.unlocked ? '锁定创作坞' : '解锁创作坞（可拖动）'}
            data-tip={composerLock.unlocked ? '锁定创作坞' : '解锁创作坞'}
            data-tip-hint={
              composerLock.unlocked ? '已解锁：按住坞体空白处拖动，双击复位' : '解锁后按住坞体空白处拖动，双击复位'
            }
            onClick={composerLock.toggle}
          >
            {composerLock.unlocked ? '锁' : '移'}
          </button>
        )}
        {/* 2026-11-09 密度批：**翰/律 撤出书眉**。它们上一批随「案」落地时已经进了抽屉
          （同一对入口在抽屉「另起」段里各有一行），书眉这两枚是**重复**——同一件事在
          同一个坞里有两个入口，用户看到的是"挤"。保留抽屉那份：抽屉是"低频动作的家"，
          而 Ctrl+K 本身就是翰的快捷键，不需要常驻一枚单字钮提醒。 */}
      </div>
      {/* B7（2026-08-27）：后台卷运行指示 + 停止——此前任一后台会话在跑就
        全局阻断发送（chat-core），但创作坞无任何指示、无从停止。 */}
      {bgRunning.length > 0 && (
        <span className="pp-bg-running" data-tip={`后台卷：${bgRunning.map((s) => s.label).join('、')}`}>
          ⟳ 后台 {bgRunning.length} 卷运行中
          <button
            type="button"
            className="pp-bg-stop"
            data-tip="停止全部后台卷"
            data-tip-hint={bgRunning.map((s) => s.label).join('、')}
            onClick={() => {
              // 停账 + 级联（同 chat-core.abort 语义）：`stopRuns` = 用户停止
              //（abort 全部在跑运行 + 注销记录 + 清权限卡队列）——**不注销账本条目**
              //（句柄仍在册；条目由句柄消亡 removeAgent 接管清理）。v43 起这条纪律
              // 是结构性的：stop 不再有「把条目注销掉」的形态，也没有「谁记得带令牌」。
              for (const s of bgRunning) {
                agentSessionState.stopRuns(panelId, s.id);
                agentSessionState.getAgent(panelId, s.id)?.cascadeAbort();
              }
            }}
          >
            停止
          </button>
        </span>
      )}
    </div>
  );
}
