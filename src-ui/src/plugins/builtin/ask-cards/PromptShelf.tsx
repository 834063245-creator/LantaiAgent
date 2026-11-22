// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PromptShelf — 消息和输入框之间的统一提示区
// 同时处理 ask_user 卡片和权限审批。
// 不在消息数组内 — 独立的 React root。
//
// 批 9e-3（2026-09-26）：实现随产物包 `ask-cards`（旧 `app/chat/PromptShelf.tsx`）；
// **形状留内核契约** `app/chat/ask-card-contract.ts`（prompt 类型 + `PromptShelfHandle`
// 动词）——内核 `chat-core` 是消费侧，铁律禁内核 import 产物源码。
//
// ── 2026-11-22 用户报修后的第三次迭代（本次）──────────────────────────────
// 症状（用户原话）：「自主输入的文本在一些情况下根本不会被发给 agent」「选项一旦
// 勾选无法取消勾选」。复现后根因不在样式，在**答案模型**：
//   ① 答案形状是 `string[]`——label 与自由文本抢同一个位置。于是每条收集路径各自
//      决定丢不丢：单问卡勾了选项再点「确认选择」只发 label（文本静默消失）；批量卡
//      的输入框非受控、只有 Enter 才把文本写进答案，点「提交」时答案里根本没有它，
//      而没选选项时提交钮是 disabled ⇒ 用户被卡死（文本永远发不出去）。
//   ② 批量卡单选点击恒「覆盖为选中」，再点不取消；非末页还会立刻翻页 ⇒ 没有反悔路径。
//   ③ 单问/批量是两份平行组件（AskCard / AskBatchCard），同一语义各写一遍，修一边漏一边。
// 改法（对照 DSH user-questions 的答案模型）：
//   · 答案 = `AskUserAnswer { selected, custom }` 两栏（内核契约，单问/批量共用）：
//     单选/开放式的 custom 取代 selected；多选的 custom 与 selected 并存；跳过 = 两者皆空。
//   · 自由文本是**受控草稿**，随「提交」必然带走；有文本即可提交（不再只有 Enter 一条路）。
//   · 取消勾选：两种模式都是「再点已选项 = 取消」；单选下动笔写文本 = 取消选项（可见）。
//   · 批量每题一份草稿（翻页不串字、回看不丢），取消自动翻页——「下一题」是显式动作。
//   · 单问/批量合成同一张卡（一题一页），语义只有一处实现。
//   · Enter 不再被 IME 组合键截走（keyCode 229 同判），Shift+Enter 换行（textarea）。
//   · 二轮（同日）：草稿按 prompt id 寄存——被顶队头换下的卡再回来，页码与每题草稿
//     原位恢复（旧行为：卡组件卸载 = 已填未交的话当场消失）。
//
// 版式沿 2026-11-07 A 方案（书眉降级 / 选项去框 / 主动作实色 / 键位常驻），本次新增
// 「自定义回答行」（与选项同构的一行）与状态行（已答 n/N）。

import type React from 'react';
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  type AskAnswerDisposition,
  type AskBatchPrompt,
  type AskPrompt,
  type AskUserAnswer,
  iconSvg,
  type PermissionPrompt,
  type PromptData,
  type PromptOwner,
  type PromptShelfHandle,
} from './host';
import './prompt-shelf.css';

// ── 图标 ──

/** 内联 SVG 图标 — 单点色 dangerousHTML（iconSvg 返回自有静态图标库字符串，
 *  非用户输入，无 XSS 面）；全部使用点经此组件，豁免只留这一处。 */
function Icon({ name, size = 12 }: { name: string; size?: number }): React.ReactElement {
  // 装饰性图标（2026-08-29 走查）：语义由宿主按钮 title 承载，不进无障碍树
  // biome-ignore lint/security/noDangerouslySetInnerHtml: 自有静态图标库字符串（ui/icons.ts），非用户输入
  return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg(name, size) }} />;
}

// ── 共用件 ──

/** 主输入作答回调面（shelf → 激活卡注册；text = 主输入框文本）。
 *  返回 false = 该卡不吃文本作答（权限卡等）。 */
export type ExternalAnswerFn = (text: string) => AskAnswerDisposition | false;

/** 书眉（卷名 · 类型）——机读位小字，承担旧「双 tag + 12 字截断」的全部信息。
 *  typeClass 只决定类型段色相：问卡石青（机在问人）/ 待批卡朱砂（人的动作）。 */
function Kicker({
  badge,
  typeClass,
  danger,
  trailing,
  children,
}: {
  badge?: string | null;
  typeClass?: string;
  danger?: string | null;
  trailing?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="prompt-shelf__kicker">
      {badge ? <span className="prompt-shelf__kicker-owner">{badge}</span> : null}
      {badge ? <span className="prompt-shelf__kicker-sep" /> : null}
      {danger ? <span className="prompt-shelf__danger">危 · {danger}</span> : null}
      <span className={`prompt-shelf__kicker-kind ${typeClass ?? ''}`}>{children}</span>
      {trailing ? <span className="prompt-shelf__kicker-paging">{trailing}</span> : null}
    </span>
  );
}

/** 选项方印：单选 = 空框 → 实心朱印；多选 = 空框 → 勾。
 *  「多项可选」这个信息不在方印里塞 8px 小字（那是读不动的糊点），改由书眉的
 *  「多选」一词承载——形状只回答「选了没有」，词回答「能选几个」。 */
function Mark({ on, multi }: { on: boolean; multi?: boolean }) {
  return (
    <span className={`prompt-shelf__mark${on ? ' prompt-shelf__mark--on' : ''}`} aria-hidden="true">
      {on && multi ? <Icon name="check" size={11} /> : null}
    </span>
  );
}

/** 键位提示行（常驻）——此前只写在关闭钮的 data-tip 里，不悬停就不知道能敲键盘。 */
function Keyhint({ items, align = 'right' }: { items: string[]; align?: 'left' | 'right' }) {
  return (
    <div className={`prompt-shelf__keyhint${align === 'left' ? ' prompt-shelf__keyhint--left' : ''}`}>
      {items.map((text) => (
        <span key={text}>{text}</span>
      ))}
    </div>
  );
}

/** IME 组合中的 Enter 是在选词/上屏，不是提交（keyCode 229 是引擎不肯给
 *  isComposing 时的旧信号——2026-11-22 用户报「中文打到一半卡片就交了」）。 */
function isComposing(event: React.KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || (event.nativeEvent as { keyCode?: number }).keyCode === 229;
}

// ── 询问卡片（单问 / 批量多问同一张卡：一题一页）──
//
// 2026-09-10：单选退役 240ms 自动确认——点选只选中，显式提交；自动确认是
// 「没下判断就被回答」的历史病灶。
// 2026-11-07 A 方案：详情并进选项自身、确认钮常驻 + disabled、键位常驻。
// 2026-11-22：答案两栏化 + 文本受控 + 单选/多选都能取消勾选（见文件头）。

/** 单页草稿：选项按**下标**存（重复 label 可分别勾选），文本单独一栏。 */
interface Draft {
  selected: number[];
  custom: string;
}

const EMPTY_DRAFT: Draft = { selected: [], custom: '' };

/** 卡面题目（把单问表单与批量 questions 两形状折成一条）。 */
interface CardQuestion {
  question: string;
  header?: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

function questionsOf(prompt: (AskPrompt | AskBatchPrompt) & PromptOwner): CardQuestion[] {
  if (prompt.type === 'ask') {
    return [
      {
        question: prompt.question,
        header: prompt.header,
        options: prompt.options,
        multiSelect: prompt.multiSelect,
      },
    ];
  }
  return prompt.questions.map((item) => ({
    question: item.question,
    header: item.header,
    options: item.options ?? [],
    multiSelect: !!item.multiSelect,
  }));
}

/** 草稿 → 契约答案。单选：有文本时文本**取代**选择（此时台上选中项已清空，
 *  两者不会同时在场）；多选：文本与选中项并存。 */
function answerOf(q: CardQuestion, d: Draft): AskUserAnswer {
  const selected = d.selected.map((i) => q.options[i]?.label ?? '').filter(Boolean);
  const custom = d.custom.trim();
  if (custom !== '') return q.multiSelect ? { selected, custom } : { selected: [], custom };
  return { selected };
}

/** 进度点：已答 = 实心墨点，当前 = 朱砂描边放大。 */
function ProgressDots({ states, page }: { states: Array<'empty' | 'answered'>; page: number }) {
  return (
    <span className="prompt-shelf__dots" aria-hidden="true">
      {states.map((state, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 进度点无稳定 id（questions 仅题目文本），index 与页码同构
          key={i}
          className={`prompt-shelf__dot${state === 'answered' ? ' prompt-shelf__dot--done' : ''}${
            i === page ? ' prompt-shelf__dot--cur' : ''
          }`}
        />
      ))}
    </span>
  );
}

/** 一张卡的草稿快照（2026-11-22 二轮）：卡被顶下/换位再回来时原样恢复。
 *  旧行为：卡组件卸载 = 用户已填未交的话当场消失（promoteByOwner 头注承认的代价）。 */
interface CardDraftState {
  page: number;
  drafts: Draft[];
}

/** 草稿寄存处（ownership 在 PromptShelf——队列状态的唯一持有者；卡片只读写）。
 *  键 = prompt id（队列项身份），解析即 drop（不留死条目）。 */
interface CardDraftStore {
  read(id: string): CardDraftState | undefined;
  write(id: string, state: CardDraftState): void;
  drop(id: string): void;
}

const AskCard: React.FC<{
  prompt: (AskPrompt | AskBatchPrompt) & PromptOwner;
  onResolve: (answers: AskUserAnswer[] | null) => void;
  registerAnswer?: (fn: ExternalAnswerFn | null) => void;
  draftStore: CardDraftStore;
}> = ({ prompt, onResolve, registerAnswer, draftStore }) => {
  const questions = useMemo(() => questionsOf(prompt), [prompt]);
  const total = questions.length;
  // 初始值读寄存处：被顶下过的那张卡回到队头时，页码与每题草稿都还在
  const [page, setPage] = useState(() => {
    const saved = draftStore.read(prompt.id);
    return saved && saved.page >= 0 && saved.page < total ? saved.page : 0;
  });
  const [drafts, setDrafts] = useState<Draft[]>(() => {
    const saved = draftStore.read(prompt.id);
    if (saved && saved.drafts.length === total) {
      return saved.drafts.map((d) => ({ selected: [...d.selected], custom: d.custom }));
    }
    return questions.map(() => ({ ...EMPTY_DRAFT }));
  });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();
  const hintId = useId();

  const q = questions[page] ?? questions[0];
  const draft = drafts[page] ?? EMPTY_DRAFT;
  const hasOptions = q.options.length > 0;
  const multi = hasOptions && q.multiSelect;
  const customActive = draft.custom.trim() !== '';
  const currentAnswered = draft.selected.length > 0 || customActive;
  const answeredCount = drafts.filter((d) => d.selected.length > 0 || d.custom.trim() !== '').length;
  const isLast = page === total - 1;
  const canSubmit = answeredCount > 0;

  // 每笔草稿变化即寄存（effect 在提交后、卸载前都已跑过——顶队头换卡不丢字）
  useEffect(() => {
    draftStore.write(prompt.id, { page, drafts });
  }, [draftStore, prompt.id, page, drafts]);

  const patchDraft = useCallback(
    (update: (d: Draft) => Draft) => {
      setDrafts((prev) => {
        const next = [...prev];
        next[page] = update(prev[page] ?? EMPTY_DRAFT);
        return next;
      });
    },
    [page],
  );

  /** 选项点击：两种模式都是**再点已项 = 取消**。
   *  单选：点新项 = 换选并清掉自写文本（文本与选项在单选中互斥，清空是可见的）；
   *  多选：勾/取消；自写文本与它不冲突（文本自己就是一项）。 */
  const choose = useCallback(
    (idx: number) => {
      patchDraft((d) => {
        if (q.multiSelect) {
          const has = d.selected.includes(idx);
          return { selected: has ? d.selected.filter((i) => i !== idx) : [...d.selected, idx], custom: d.custom };
        }
        const has = d.selected.includes(idx);
        return { selected: has ? [] : [idx], custom: '' };
      });
    },
    [patchDraft, q.multiSelect],
  );

  /** 自由文本输入：单选下一动笔就取消所选（文本取代选择，避免「两个答案同时在场」）。 */
  const typeCustom = useCallback(
    (text: string) => {
      patchDraft((d) => ({ selected: q.multiSelect ? d.selected : [], custom: text }));
    },
    [patchDraft, q.multiSelect],
  );

  /** 交卷/取消的唯一出口：先清寄存，再交给架头（解析过的卡不留草稿）。 */
  const finish = useCallback(
    (answers: AskUserAnswer[] | null) => {
      draftStore.drop(prompt.id);
      onResolve(answers);
    },
    [draftStore, onResolve, prompt.id],
  );

  const cancel = useCallback(() => finish(null), [finish]);

  /** 提交整批：每题按自己的草稿折算（跳过/未答 = 两者皆空 → 工具侧 null）。 */
  const submit = useCallback(() => {
    if (answeredCount === 0) return;
    finish(questions.map((item, i) => answerOf(item, drafts[i] ?? EMPTY_DRAFT)));
  }, [answeredCount, drafts, finish, questions]);

  /** 跳过当前题（清空 + 前进；末页 = 直接交整批）。 */
  const skip = useCallback(() => {
    const next = drafts.map((d, i) => (i === page ? { ...EMPTY_DRAFT } : d));
    if (!isLast) {
      setDrafts(next);
      setPage(page + 1);
      return;
    }
    finish(questions.map((item, i) => answerOf(item, next[i] ?? EMPTY_DRAFT)));
  }, [drafts, finish, isLast, page, questions]);

  /** Enter / 主按钮的「继续」：非末页 = 翻下一页（已答才动），末页 = 提交。 */
  const continueFlow = useCallback(() => {
    if (!isLast) {
      if (currentAnswered) setPage(page + 1);
      return;
    }
    submit();
  }, [currentAnswered, isLast, page, submit]);

  /** 主输入作答：架头是这张卡时，把主输入框里的话当作答案。
   *  单问 / 批量末页 = 填进当前题并**整批提交**；批量中间页 = 填当前题并翻页。 */
  const answerFromComposer = useCallback(
    (raw: string): AskAnswerDisposition | false => {
      const text = raw.trim();
      if (text === '') return false;
      const next = drafts.map((d, i) => (i === page ? { selected: q.multiSelect ? d.selected : [], custom: text } : d));
      if (total === 1 || isLast) {
        finish(questions.map((item, i) => answerOf(item, next[i] ?? EMPTY_DRAFT)));
        return 'submitted';
      }
      setDrafts(next);
      setPage(page + 1);
      return 'filled';
    },
    [drafts, finish, isLast, page, q.multiSelect, questions, total],
  );

  // 卡注册一个稳定回调 → 每次都读最新渲染的闭包（避免 effect 随每题草稿重注册）
  const liveAnswer = useRef<ExternalAnswerFn>(answerFromComposer);
  liveAnswer.current = answerFromComposer;
  useEffect(() => {
    if (!registerAnswer) return;
    registerAnswer((text) => liveAnswer.current(text));
    return () => registerAnswer(null);
  }, [registerAnswer]);

  // 文档级键位：Esc 取消 / Enter 继续 / 数字快选（焦点在输入面或按钮上时让原生行为走）
  const keyHandlers = useRef({ cancel, continueFlow, choose, optionsLength: q.options.length });
  keyHandlers.current = { cancel, continueFlow, choose, optionsLength: q.options.length };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const el = e.target instanceof Element ? e.target : null;
      const inInput = !!el?.closest('input, textarea, [contenteditable="true"]');
      if (e.key === 'Escape') {
        e.preventDefault();
        keyHandlers.current.cancel();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (inInput) return;
      if (e.key === 'Enter') {
        // 焦点在按钮上让原生 click 走（避免 Enter 双发）
        if (el?.closest('button')) return;
        e.preventDefault();
        keyHandlers.current.continueFlow();
        return;
      }
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < keyHandlers.current.optionsLength) {
        e.preventDefault();
        keyHandlers.current.choose(idx);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (isComposing(e)) return;
    e.preventDefault();
    continueFlow();
  };

  /** 书眉：单问 = header；批量 = 「问 n/N · 本题 header」（本题没 header 就不补尾巴）。 */
  const headerLine = (q.header ?? '提问').slice(0, 12);

  return (
    <div
      className="prompt-shelf__card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={hintId}
    >
      {/* 书眉：卷名 · 类型（批量多一页码） */}
      <div className="prompt-shelf__head">
        <Kicker badge={prompt.badge} typeClass="prompt-shelf__kicker-kind--ask">
          {total > 1 ? `问 ${page + 1}/${total}${q.header ? ` · ${headerLine}` : ''}` : headerLine}
          {multi ? ' · 多选' : ''}
        </Kicker>
        <button className="prompt-shelf__dismiss" onClick={cancel} data-tip="取消 (Esc)" type="button">
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* 问题句：主角 */}
      <p id={titleId} className="prompt-shelf__question">
        {q.question}
      </p>

      {/* 选项（开放式问题无 options 时整块不渲染） */}
      {hasOptions && (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role 由 multi 在 group/radiogroup 间切换（ARIA 两者都支持 aria-labelledby），Biome 按原生 <div> 校验
        <div className="prompt-shelf__options" role={multi ? 'group' : 'radiogroup'} aria-labelledby={titleId}>
          {q.options.map((opt, i) => {
            const on = draft.selected.includes(i);
            return (
              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role 在 checkbox/radio 间切换（ARIA 两者都支持 aria-checked），Biome 按原生 <button> 校验
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 选项允许重复 label（自定义回答场景），index 是唯一稳定键
                key={i}
                className={`prompt-shelf__option${on ? ' prompt-shelf__option--on' : ''}`}
                onClick={() => choose(i)}
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                type="button"
              >
                <Mark on={on} multi={multi} />
                <span className="prompt-shelf__opt-body">
                  <span className="prompt-shelf__opt-label">{opt.label}</span>
                  {opt.description && <span className="prompt-shelf__opt-desc">{opt.description}</span>}
                </span>
                <span className="prompt-shelf__num">{i + 1 <= 9 ? i + 1 : ''}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 自定义回答行：与选项同构的一行——文本在这里有明确的位置，
       *  不再是「框里打完字再猜 Enter」的暗门。 */}
      <div className={`prompt-shelf__custom-row${customActive ? ' prompt-shelf__custom-row--active' : ''}`}>
        {multi ? (
          <Mark on={customActive} multi />
        ) : (
          <span className="prompt-shelf__custom-mark" aria-hidden="true">
            <Icon name="edit" size={11} />
          </span>
        )}
        <textarea
          ref={inputRef}
          className="prompt-shelf__custom-input"
          rows={1}
          value={draft.custom}
          placeholder={hasOptions ? '或直接写下你的回答…' : '输入你的回答…（Shift+Enter 换行）'}
          aria-label="自定义回答"
          onChange={(e) => typeCustom(e.target.value)}
          onKeyDown={onInputKey}
        />
      </div>

      {/* 状态行 + 动作：提交钮只看「有没有答」，不再由「有没有点选项」决定生死 */}
      <div className="prompt-shelf__foot">
        <span className="prompt-shelf__status" role="status">
          {total > 1
            ? `已答 ${answeredCount}/${total}`
            : hasOptions
              ? draft.selected.length > 0
                ? `已选 ${draft.selected.length} 项`
                : customActive
                  ? '已填写自定义回答'
                  : '尚未选择'
              : customActive
                ? '已填写'
                : '尚未填写'}
        </span>
        <span className="prompt-shelf__actions">
          {total > 1 && (
            <button className="prompt-shelf__skip" onClick={skip} type="button">
              跳过此题
            </button>
          )}
          <button className="prompt-shelf__confirm" onClick={submit} disabled={!canSubmit} type="button">
            {total > 1 ? `提交（已答 ${answeredCount}/${total}）` : '提交回答'}
          </button>
        </span>
      </div>

      {/* 翻页行（只有批量多问出现） */}
      {total > 1 && (
        <div className="prompt-shelf__pager">
          <button className="prompt-shelf__nav" disabled={page === 0} onClick={() => setPage(page - 1)} type="button">
            ← 上一题
          </button>
          <ProgressDots
            states={drafts.map((d) => (d.selected.length > 0 || d.custom.trim() !== '' ? 'answered' : 'empty'))}
            page={page}
          />
          <button className="prompt-shelf__nav" disabled={isLast} onClick={() => setPage(page + 1)} type="button">
            下一题 →
          </button>
        </div>
      )}

      <div id={hintId}>
        <Keyhint
          items={[
            hasOptions ? `1–${q.options.length} 选择（再点取消）` : '',
            total > 1 ? 'Enter 下一题/提交' : 'Enter 提交',
            'Shift+Enter 换行',
            'Esc 取消',
          ].filter(Boolean)}
        />
      </div>
    </div>
  );
};

// ── 权限卡片 ──

/** 权限牒卡：事由在前、命令块居中、决策在尾。
 *  三键次序（2026-11-07 定）：**驳回退到最左，准此居最右最重**——最重的动作长在
 *  主路径末端，危险的否定远离回车站位。 */
const PermCard: React.FC<{
  prompt: PermissionPrompt & PromptOwner;
  onResolve: (result: { allow: boolean; remember: boolean }) => void;
}> = ({ prompt, onResolve }) => {
  const titleId = useId();
  const hintId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在输入框（聊天输入等）时不触发快捷键，防打字误批准/误拒绝
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onResolve({ allow: false, remember: false });
        return;
      }
      if (e.key === 'Enter') {
        // 焦点已在弹层按钮上时让原生 click 走（避免 Enter 双发：监听 + 按钮激活各一次）
        if (el?.closest('button')) return;
        e.preventDefault();
        onResolve({ allow: true, remember: false });
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onResolve]);

  return (
    <div
      className={`prompt-shelf__card prompt-shelf__card--permit${prompt.danger ? ' prompt-shelf__card--danger' : ''}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
    >
      <div className="prompt-shelf__head">
        <Kicker badge={prompt.badge} danger={prompt.danger} typeClass="prompt-shelf__kicker-kind--permit">
          请示 · 待批
        </Kicker>
        <button
          className="prompt-shelf__dismiss"
          onClick={() => onResolve({ allow: false, remember: false })}
          data-tip="驳回 (Esc)"
          type="button"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <p id={titleId} className="prompt-shelf__question">
        {prompt.toolName}
      </p>
      {prompt.subject && <div className="prompt-shelf__perm-subject">{prompt.subject}</div>}
      <div className="prompt-shelf__perm-reason">{prompt.reason}</div>

      <div className="prompt-shelf__perm-btns">
        <button
          className="prompt-shelf__perm-btn prompt-shelf__perm-btn--deny"
          onClick={() => onResolve({ allow: false, remember: false })}
          type="button"
        >
          驳回
        </button>
        <button
          className="prompt-shelf__perm-btn prompt-shelf__perm-btn--session"
          onClick={() => onResolve({ allow: true, remember: true })}
          type="button"
        >
          本卷均准
        </button>
        <button
          className="prompt-shelf__perm-btn prompt-shelf__perm-btn--once"
          onClick={() => onResolve({ allow: true, remember: false })}
          type="button"
        >
          落印准此
        </button>
      </div>

      <div id={hintId}>
        <Keyhint items={['Enter 落印准此', 'Esc 驳回']} />
      </div>
    </div>
  );
};

// ── 命令式 API（core 注册接口签名——形状真源 = 内核 app/chat/ask-card-contract.ts）──

// ── Shelf 组件（P2′-2b：直接挂 ChatBeacon 树，Controller 包装已删）──
// FIFO 队列：同轮多个 ask_user / 权限请求排队展示，不再互相顶掉
// （旧实现第二个提示会以 null 静默取消第一个 → 模型收到"用户取消"并重复追问，
//   观感即"点击后卡死"）。
//
// ⚠ 自动超时已退役（2026-09-16 用户拍板）：「卡片激活 5 分钟无操作按取消解析」
// 曾用于防工具 promise 永久挂起，但它**会杀掉正在填写的卡**——用户还在组织语言
// （或排队等前一张卡答完）时超时到点，卡被按 null 静默取消，用户看到的是
// "我填了/我要填，模型却说用户取消了"。这是「工具 promise 挂起」与
// 「用户正在作答」之间的取舍，用户裁定：**不自动取消**——宁可等，不许替用户
// 表达「取消」。真正的兜底在别处（用户停轮次 dismiss / 切工作区全清 /
// MCP 侧 abort），不再有 5 分钟定时器。

interface QueuedPrompt {
  prompt: PromptData;
  resolve: (v: unknown) => void;
}

/** 超时默认值 — ask 取消（null），权限按拒绝。 */
function timeoutValue(prompt: PromptData): unknown {
  return prompt.type === 'permission' ? { allow: false, remember: false } : null;
}

export const PromptShelf = forwardRef<PromptShelfHandle>(function PromptShelf(_props, ref) {
  const [active, setActive] = useState<PromptData | null>(null);
  const queueRef = useRef<QueuedPrompt[]>([]);
  /** 卡草稿寄存处（按 prompt id）：顶队头换卡、回来时原位恢复（2026-11-22 二轮）。
   *  ownership 在架头（队列状态的唯一持有者），卡片只读写；解析/取消即清条目。 */
  /* Map 是可变容器：放 ref（useMemo 的语义保证只到"性能优化"，不适合承载真状态） */
  const draftStoreRef = useRef<CardDraftStore | null>(null);
  if (draftStoreRef.current === null) {
    const store = new Map<string, CardDraftState>();
    draftStoreRef.current = {
      read: (id) => store.get(id),
      write: (id, state) => {
        store.set(id, state);
      },
      drop: (id) => {
        store.delete(id);
      },
    };
  }
  const draftStore = draftStoreRef.current;
  /** 激活卡注册的主输入作答回调（草稿与分页状态住卡内——只能由卡注册） */
  const answerFnRef = useRef<ExternalAnswerFn | null>(null);

  const registerAnswer = useCallback((fn: ExternalAnswerFn | null) => {
    answerFnRef.current = fn;
  }, []);

  /** 解析队头并激活下一张（自动超时已退役——只由用户动作/取消调用）。 */
  const resolveHead = useCallback((v: unknown) => {
    const head = queueRef.current.shift();
    if (head) head.resolve(v);
    setActive(queueRef.current[0]?.prompt ?? null);
  }, []);

  /** 入队；队列原本为空时立即激活队头。 */
  const enqueue = useCallback(
    (prompt: PromptData): Promise<unknown> =>
      new Promise((resolve) => {
        queueRef.current.push({ prompt, resolve });
        if (queueRef.current.length === 1) setActive(prompt);
      }),
    [],
  );

  const showAsk = useCallback(
    (prompt: AskPrompt & PromptOwner) => enqueue({ ...prompt, type: 'ask' }) as Promise<AskUserAnswer[] | null>,
    [enqueue],
  );

  const showAskBatch = useCallback(
    (prompt: AskBatchPrompt & PromptOwner) =>
      enqueue({ ...prompt, type: 'ask-batch' }) as Promise<AskUserAnswer[] | null>,
    [enqueue],
  );

  const showPermission = useCallback(
    (prompt: PermissionPrompt & PromptOwner) =>
      enqueue({ ...prompt, type: 'permission' }) as Promise<{ allow: boolean; remember: boolean }>,
    [enqueue],
  );

  /** 清空队列，全部按取消解析（ask → null，权限 → 拒绝）。运行停止或卸载时调用。 */
  const dismissAll = useCallback(() => {
    const q = queueRef.current;
    queueRef.current = [];
    setActive(null);
    for (const item of q) {
      draftStore.drop(item.prompt.id);
      item.resolve(timeoutValue(item.prompt));
    }
  }, [draftStore]);

  /** 按归属卷关闭：匹配项按取消解析（含激活卡），其余照常。 */
  const dismissByOwner = useCallback(
    (ownerSid: number | null) => {
      const remains: QueuedPrompt[] = [];
      const q = queueRef.current;
      queueRef.current = remains;
      let activeKilled = false;
      for (const item of q) {
        if ((item.prompt.ownerSid ?? null) === ownerSid) {
          draftStore.drop(item.prompt.id);
          item.resolve(timeoutValue(item.prompt));
          if (q[0] === item) activeKilled = true;
        } else {
          remains.push(item);
        }
      }
      if (activeKilled) setActive(remains[0]?.prompt ?? null);
    },
    [draftStore],
  );

  /** 把某卷的第一张在等卡顶到队头（2026-11-11 画布多卷审批 UX · A 面）。
   *  返回 true = 发生了移动。边界：该卷没有在等卡 / 本来就在队头 = false（no-op）；
   *  只重排**顺序**，不动卡的归属与内容。原队头卡会被换下（组件卸载），但**已填草稿
   *  按 prompt id 寄存**（2026-11-22 二轮）——它再回到队头时页码与文字原样恢复。 */
  const promoteByOwner = useCallback((ownerSid: number | null): boolean => {
    const q = queueRef.current;
    const key = ownerSid ?? null;
    const idx = q.findIndex((it) => (it.prompt.ownerSid ?? null) === key);
    if (idx <= 0) return false;
    const [item] = q.splice(idx, 1);
    q.unshift(item);
    setActive(q[0].prompt);
    return true;
  }, []);

  /** 主输入作答：架头是提问卡时以 text 作答——单问/批量末页整卡提交，
   *  批量中间页填进当前题并翻页（returns 'filled'，调用方的回音据此不撒谎）。 */
  const answerActiveText = useCallback((text: string): AskAnswerDisposition | false => {
    const head = queueRef.current[0];
    if (!head) return false;
    // 权限卡不吃文本作答
    if (head.prompt.type !== 'ask' && head.prompt.type !== 'ask-batch') return false;
    return answerFnRef.current?.(text) ?? false;
  }, []);

  // 卸载时取消所有挂起的 Promise，防泄漏（旧 Controller.destroy 语义）
  useEffect(() => dismissAll, [dismissAll]);

  useImperativeHandle(
    ref,
    () => ({
      get active() {
        return queueRef.current[0]?.prompt ?? null;
      },
      showAsk,
      showAskBatch,
      showPermission,
      dismiss: dismissAll,
      dismissByOwner,
      promoteByOwner,
      answerActiveText,
    }),
    [showAsk, showAskBatch, showPermission, dismissAll, dismissByOwner, promoteByOwner, answerActiveText],
  );

  return (
    <div className="prompt-shelf">
      {active && (active.type === 'ask' || active.type === 'ask-batch') ? (
        <AskCard
          key={active.id}
          prompt={active}
          onResolve={resolveHead}
          registerAnswer={registerAnswer}
          draftStore={draftStore}
        />
      ) : active?.type === 'permission' ? (
        <PermCard key={active.id} prompt={active} onResolve={resolveHead} />
      ) : null}
    </div>
  );
});
