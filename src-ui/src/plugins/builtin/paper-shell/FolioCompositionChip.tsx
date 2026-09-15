// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷首组合芯片（S6 P5a）——把「本卷拿什么跑」写到**卷首**（folio-head）右上角。
//
// 与创作坞芯片（S6 P1e，compose-dock）**同读面、同写面、同尺子，不同宿主**：
//   读面 = `core.sessionComposition(sid)`（`app/chat/session-composition.ts` 的
//          `sessionCompositionInfo`：卷级记录 / 全局默认 / 不可用原因）；
//   写面 = `core.selectSessionPreset(sid, id)`（严一档校验 → 空白闸 → 登记 →
//          空白卷即时重建句柄；写路径自带二道闸，与这里的控件锁**同一把尺子**）；
//   判据 = `core.isSessionBlank(sid)`（本卷消息数为 0，与侧栏卷计数同源）。
//
// 两态（卷首天然 per-卷，没有创作坞那种「无活跃卷」态）：
//   空白卷 → **可拨**（拨的是本卷的卷级选择）；
//   跑过一轮 → **只读标签**（组合决定模型看到的工具与提示面 = 字节契约：中途换面
//     会让前缀缓存与已声明能力面不一致——DSH「控制在此不承诺」同款）。
//
// **作用对象 = 本 region 的卷**（宿主传入的 `sessionId`），不是「当前活跃卷」：
// 卷首天然 per-卷，而写路径本就支持「句柄缺席的空白卷先登记、下次装配生效」。
//
// 落位纪律（WO-S6P5 §7 裁定 3）：**绝对定位覆盖在卷首右上角、不进高度流水**
// ⇒ 不动 `FOLIO_TOKENS` / `measureFolioHeadHeight` / 卷级几何（既有画布零位移）。
// 卷首本体 `pointer-events: none`（点击穿透流区背景），本控件子树单独放开。
//
// 来源词表（裁定 5）：卷级记录（界面拨动 / 程序按组合起卷写入）与全局默认——
// 记录本身不区分「谁写的」，故文案如实说「本卷记录」，不假装能分辨程序与界面。

import { useCallback, useEffect, useState } from 'react';
import { msgStoreFor, usePresetStore } from './host';

/** 本卷组合身份读面（`sessionCompositionInfo` 的结构形状）。 */
export interface FolioCompositionInfo {
  presetId: string;
  source: 'session' | 'global';
  error: string | null;
}

/** 本控件用到的最小能力位面（与 ChatCore 兼容；桩 core 只实现这三项也能测——
 *  能力位缺席 = 无读数，不炸纸面，同 token 三能力位/坞内芯片的既有语义）。 */
export interface FolioChipCore {
  panelId: string;
  isSessionBlank?(sessionId: number): boolean;
  sessionComposition?(sessionId: number): Promise<FolioCompositionInfo>;
  selectSessionPreset?(
    sessionId: number,
    presetId: string,
  ): Promise<{ ok: true; sessionId: number } | { ok: false; reason: string } | { ok: true }>;
}

export interface FolioCompositionChipProps {
  core: FolioChipCore | null;
  /** 本卷号（`RegionView.sessionId`，string 形——与坞上下文同款，入口集中转换）。 */
  sessionId: string;
}

export function FolioCompositionChip({ core, sessionId }: FolioCompositionChipProps) {
  const presetRoster = usePresetStore((s) => s.roster);
  const presetSelected = usePresetStore((s) => s.selected);
  const presetError = usePresetStore((s) => s.error);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<FolioCompositionInfo>({ presetId: presetSelected, source: 'global', error: null });
  const [blank, setBlank] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const sidNum = sessionId === '' ? Number.NaN : Number(sessionId);
  const sid = Number.isFinite(sidNum) ? sidNum : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: presetRoster 是刻意的重读触发器（「重新扫描」/新建 preset 后本卷身份与可用性要重解析）——与创作坞芯片同款手法
  useEffect(() => {
    if (sid === null) return;
    let alive = true;
    const refresh = () => {
      if (!alive) return;
      setBlank(core?.isSessionBlank?.(sid) ?? true);
      void core
        ?.sessionComposition?.(sid)
        .then((i) => {
          if (alive) setInfo(i);
        })
        .catch(() => {});
    };
    refresh();
    // 本卷内容变化 = 可能刚跑过一轮（只读锁随之翻转）——订阅消息面
    const unsub = core ? msgStoreFor(core.panelId, sid).subscribe(refresh) : undefined;
    return () => {
      alive = false;
      unsub?.();
    };
  }, [core, sid, presetRoster, presetSelected]);

  const locked = !blank;
  const label = info.presetId;
  const sourceText =
    info.source === 'session' ? '本卷记录（界面拨动，或程序按组合起卷时写入）' : '全局默认（新卷出生默认）';

  const onPick = useCallback(
    async (id: string) => {
      setOpen(false);
      setNotice(null);
      if (sid === null || !core?.selectSessionPreset) return;
      const r = await core.selectSessionPreset(sid, id);
      if (!r.ok) setNotice(`组合未切换：${r.reason}`);
    },
    [core, sid],
  );

  return (
    <div className="pp-folio-comp" data-folio-comp-chip data-session-id={sessionId}>
      {locked ? (
        // 跑过一轮：只读标签（不再是按钮；hover 说明来源与锁定原因）
        <span
          className="pp-folio-comp-pill"
          data-locked
          title={
            info.error
              ? `本卷组合：${label}（${info.error}——装配时已回退用户层组合）`
              : `本卷组合：${label}（来源：${sourceText}）；已跑过一轮——组合与已发送的对话绑定，不能中途换（另起一卷再选）`
          }
        >
          组合 · {label}
        </span>
      ) : (
        <>
          <button
            type="button"
            className={`pp-folio-comp-pill${open ? ' open' : ''}`}
            title={
              info.error
                ? `本卷组合：${label}（${info.error}）`
                : `本卷组合：${label}（来源：${sourceText}；空白卷可拨，跑过一轮即锁定）`
            }
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            组合 · {label}
            <span className="pp-folio-comp-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          {open && (
            <div className="pp-folio-comp-menu" role="listbox" aria-label="组合（preset）">
              {presetRoster.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={p.id === label}
                  className={`pp-folio-comp-opt${p.id === label ? ' selected' : ''}`}
                  disabled={p.patch === null}
                  title={
                    p.patch === null ? `装载失败：${p.error ?? 'roster.patch.yml 不可用'}` : p.metadata?.description
                  }
                  onClick={() => void onPick(p.id)}
                >
                  {p.metadata?.name ?? p.id}
                  {p.patch === null ? '（损坏）' : ''}
                </button>
              ))}
              {presetError && <div className="pp-folio-comp-note">⚠ {presetError}</div>}
              <div className="pp-folio-comp-note">空白卷可拨；跑过一轮的卷锁定，另起一卷再选</div>
            </div>
          )}
        </>
      )}
      {notice && <div className="pp-folio-comp-toast">{notice}</div>}
    </div>
  );
}
