// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PromptShelf — 消息和输入框之间的统一提示区
// 同时处理 ask_user 卡片和权限审批。
// 不在消息数组内 — 独立的 React root。
//
// 批 9e-3（2026-09-26）：实现随产物包 `ask-cards`（旧 `app/chat/PromptShelf.tsx`）；
// **形状留内核契约** `app/chat/ask-card-contract.ts`（三个 prompt 类型 + `PromptData`
// + `PromptShelfHandle` 五动词）——内核 `chat-core` 是消费侧，铁律禁内核 import 产物源码。
//
// ── UI 迭代（2026-11-07 用户拍板 A「整合」方向）─────────────────────────────
// 病灶不是信息缺，是**信息之间的关系没排出来**：卷徽标/类型 tag/问题句/关闭钮挤在一行，
// 问题句与机读 tag 同号；每个选项一个 1px 框、选中再叠朱砂脊线 = 框里套线；为防抖动
// 恒高 40px 的详情条在没悬停时是一整条空白灰底；主动作是透明底描边（全卡最弱元素）；
// 键盘答案只活在关闭钮的 tooltip 里。改法：
//   ① 书眉（卷名 · 类型）降为一行机读小字，问题句升 `--fs-lead` / 600 当主角；
//   ② 选项去框成行 + 方印标记，洗色走 srgb 混色（oklch 混 alpha 墨会偏紫，见 css 头注）；
//   ③ 详情并进选项自身（悬停不再有独立详情条，高度天然不抖）；
//   ④ 主动作按规格书 §10「每屏唯一主动作」：墨印实色 + `--shadow-anchor`，hover 翻朱砂；
//   ⑤ 键位提示常驻一行；确认钮常驻 + disabled（不再跳进跳出）；
//   ⑥ 语义色按铁律分家：问卡顶线石青（机在问人），待批权限卡顶线朱砂。
// 多选与单选共用同一套方印标记（多选在空态标「多」），不再两套语言。

import type React from 'react';
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import {
  type AskBatchPrompt,
  type AskPrompt,
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
export type ExternalAnswerFn = (text: string) => boolean;

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

/** 选项方印：单选 = 空框 → 实心朱点；多选 = 空框 → 勾。
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

/** 自定义答案提交钮（2026-09-16 修断链）——非空输入才出现。
 *  本地 state 跟踪输入内容以控制显隐（无受控 value——保留原生 IME 行为）。 */
const SubmitCustomButton: React.FC<{
  inputRef: React.RefObject<HTMLInputElement | null>;
  onResolve: (answer: string[] | null) => void;
}> = ({ inputRef, onResolve }) => {
  const [hasText, setHasText] = useState(false);
  // 输入变化同步显隐（原生事件——不受 React 受控干扰）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const sync = () => setHasText(el.value.trim().length > 0);
    sync();
    el.addEventListener('input', sync);
    return () => el.removeEventListener('input', sync);
  }, [inputRef]);
  if (!hasText) return null;
  return (
    <button
      className="prompt-shelf__submit"
      onClick={() => {
        const v = inputRef.current?.value.trim();
        if (v) onResolve([v]);
      }}
      type="button"
    >
      提交回答
    </button>
  );
};

// ── 询问卡片 ──
// 2026-09-10 ask 用户侧完备化：单选退役 240ms 自动确认——点选只选中，
// 显式「确认选择」/Enter 提交。自动确认是「没下判断就被回答」的历史病灶
// （用户实测报「我这实际没有给你下任何判断」：点选以为还能改，卡片已无声
// 提交）；240ms 反悔窗人类不可感知，等于没有确认环节。
//
// 2026-11-07 A 方案：详情并进选项自身（旧实现为防抖动留了一条恒高 40px 的
// 详情条，没悬停时是一整条空白灰底）；确认钮常驻 + disabled（旧实现未选不渲染，
// 按钮跳进跳出）；键位提示常驻。

const AskCard: React.FC<{
  prompt: AskPrompt & PromptOwner;
  onResolve: (answer: string[] | null) => void;
  registerAnswer?: (fn: ExternalAnswerFn | null) => void;
}> = ({ prompt, onResolve, registerAnswer }) => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const hintId = useId();

  /** 无 options = 开放式问题（用户输入自由文本回答）。 */
  const hasOptions = prompt.options.length > 0;
  const selectedCount = selected.size;

  const toggle = useCallback(
    (idx: number) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (prompt.multiSelect) {
          next.has(idx) ? next.delete(idx) : next.add(idx);
        } else {
          // 单选：点已选项 = 取消，点新项 = 换选——只选中，不提交
          next.clear();
          if (!prev.has(idx)) next.add(idx);
        }
        return next;
      });
    },
    [prompt.multiSelect],
  );

  const confirm = useCallback(() => {
    if (selected.size === 0) return;
    const labels = prompt.options.filter((_, i) => selected.has(i)).map((o) => o.label);
    onResolve(labels);
  }, [prompt.options, selected, onResolve]);

  const cancel = useCallback(() => onResolve(null), [onResolve]);

  // 主输入作答：文本按自定义回答整卡提交（对齐卡片内输入框语义）
  useEffect(() => {
    if (!registerAnswer) return;
    const fn: ExternalAnswerFn = (text) => {
      onResolve([text]);
      return true;
    };
    registerAnswer(fn);
    return () => registerAnswer(null);
  }, [registerAnswer, onResolve]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      // 组合键（Ctrl+1 切标签页等）与 IME 组合中的数字不快选，防误答
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      // 焦点在输入框（自定义回答 / 聊天输入）时不触发数字快选，防误答
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, [contenteditable="true"]')) return;
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < prompt.options.length) {
        e.preventDefault();
        toggle(idx);
        return;
      }
      // Enter = 提交已选中项；焦点在按钮上时让原生 click 走（避免 Enter 双发：
      // 本监听 + 按钮激活各触发一次 onResolve）
      if (e.key === 'Enter' && selected.size > 0 && !el?.closest('button')) {
        e.preventDefault();
        confirm();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [prompt.options.length, toggle, cancel, selected, confirm]);

  return (
    <div
      className="prompt-shelf__card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={hintId}
    >
      {/* 书眉：卷名 · 类型 */}
      <div className="prompt-shelf__head">
        <Kicker badge={prompt.badge} typeClass="prompt-shelf__kicker-kind--ask">
          {prompt.header.slice(0, 12)}
          {prompt.multiSelect ? ' · 多选' : ''}
        </Kicker>
        <button className="prompt-shelf__dismiss" onClick={cancel} data-tip="取消 (Esc)" type="button">
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* 问题句：主角 */}
      <p id={titleId} className="prompt-shelf__question">
        {prompt.question}
      </p>

      {/* 选项（开放式问题无 options 时隐藏） */}
      {hasOptions && (
        <div className="prompt-shelf__options">
          {prompt.options.map((opt, i) => {
            const on = selected.has(i);
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 选项允许重复 label（自定义回答场景），index 是唯一稳定键
                key={i}
                className={`prompt-shelf__option${on ? ' prompt-shelf__option--on' : ''}`}
                onClick={() => toggle(i)}
                aria-pressed={on}
                type="button"
              >
                <Mark on={on} multi={prompt.multiSelect} />
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

      {/* 自定义回答行 + 主动作（确认钮常驻——未选时 disabled，不再跳进跳出） */}
      <div className="prompt-shelf__foot">
        <input
          ref={inputRef}
          className="prompt-shelf__custom-input"
          type="text"
          placeholder={hasOptions ? '或者直接输入自定义回答…' : '输入回答后回车提交…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) onResolve([v]);
              else if (selected.size > 0) confirm();
            }
          }}
        />
        {hasOptions && (
          <button className="prompt-shelf__confirm" onClick={confirm} disabled={selectedCount === 0} type="button">
            {prompt.multiSelect && selectedCount > 0 ? `确认选择 (${selectedCount})` : '确认选择'}
          </button>
        )}
        <SubmitCustomButton inputRef={inputRef} onResolve={onResolve} />
      </div>

      {/* 键位提示（常驻） */}
      <div id={hintId}>
        <Keyhint
          items={
            hasOptions
              ? [
                  `1–${prompt.options.length} ${prompt.multiSelect ? '多选' : '选择'}`,
                  prompt.multiSelect ? 'Enter 确认多选' : 'Enter 确认',
                  'Esc 取消',
                ]
              : ['Enter 提交', 'Esc 取消']
          }
        />
      </div>
    </div>
  );
};

// ── 批量多问分页卡 — 一次推全部 questions，分页收集，可回看改答，末页一次提交 ──

/** 单页答案内部形态（2026-09-10 完备化）：选项答案按 idx 存（重复 label 可
 *  分选——旧 label 存储在重复项上 findIndex 只命中第一枚），自定义回答存
 *  文本；提交时才折算回 label（对齐工具契约）。 */
type BatchPageAnswer = { kind: 'custom'; text: string } | { kind: 'idx'; idxs: number[] } | null;

/** 进度点：已答 = 实心墨点，当前 = 朱砂描边放大（旧实现用石青实心表示已答、
 *  朱砂淡底表示当前——两套色相互相压过，「当前是第几个」在最该看的地方读不出）。 */
function ProgressDots({ total, page, answers }: { total: number; page: number; answers: BatchPageAnswer[] }) {
  return (
    <span className="prompt-shelf__dots" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 进度点无稳定 id（questions 仅题目文本），index 与页码同构
          key={i}
          className={`prompt-shelf__dot${answers[i] !== null ? ' prompt-shelf__dot--done' : ''}${
            i === page ? ' prompt-shelf__dot--cur' : ''
          }`}
        />
      ))}
    </span>
  );
}

const AskBatchCard: React.FC<{
  prompt: AskBatchPrompt & PromptOwner;
  onResolve: (answers: (string[] | null)[] | null) => void;
  registerAnswer?: (fn: ExternalAnswerFn | null) => void;
}> = ({ prompt, onResolve, registerAnswer }) => {
  const total = prompt.questions.length;
  const [page, setPage] = useState(0); // 0-based 当前页
  /** answers[i] = 第 i 题答案（BatchPageAnswer）；null = 未答 */
  const [answers, setAnswers] = useState<BatchPageAnswer[]>(() => prompt.questions.map(() => null));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const hintId = useId();

  const q = prompt.questions[page];
  const options = q.options ?? [];
  const hasOptions = options.length > 0;
  const multi = hasOptions && !!q.multiSelect;
  const isLast = page === total - 1;
  /** 有任一题已答即可提前提交（后页未答题按 null 返回） */
  const anyAnswered = answers.some((a) => a !== null);
  const answeredCount = answers.filter((a) => a !== null).length;

  /** 当前页答案写入（覆盖式） */
  const setPageAnswer = useCallback(
    (v: Exclude<BatchPageAnswer, null>) => {
      setAnswers((prev) => {
        const next = [...prev];
        next[page] = v;
        return next;
      });
    },
    [page],
  );

  /** 单选点击：记录答案；非末页自动翻下一页（末页停留，等用户点提交） */
  const pickSingle = useCallback(
    (idx: number) => {
      setPageAnswer({ kind: 'idx', idxs: [idx] });
      if (!isLast) setPage(page + 1);
    },
    [setPageAnswer, isLast, page],
  );

  const toggleMulti = useCallback(
    (idx: number) => {
      setAnswers((prev) => {
        const next = [...prev];
        const cur = new Set<number>(prev[page]?.kind === 'idx' ? prev[page].idxs : []);
        cur.has(idx) ? cur.delete(idx) : cur.add(idx);
        next[page] = cur.size > 0 ? { kind: 'idx', idxs: [...cur] } : null;
        return next;
      });
    },
    [page],
  );

  /** 自定义文字回答：写当前页；非末页自动翻页（对齐卡片内输入框 Enter 语义） */
  const pickCustom = useCallback(
    (text: string) => {
      setPageAnswer({ kind: 'custom', text });
      if (!isLast) setPage(page + 1);
    },
    [setPageAnswer, isLast, page],
  );

  const cancel = useCallback(() => onResolve(null), [onResolve]);

  /** 整批提交：idx 折算回 label，未答题保持 null（模型侧对齐 questions 索引可见哪些没答） */
  const submitAll = useCallback(() => {
    onResolve(
      answers.map((a, i) => {
        if (a === null) return null;
        if (a.kind === 'custom') return [a.text];
        const opts = prompt.questions[i].options ?? [];
        return a.idxs.map((k) => opts[k]?.label ?? '').filter(Boolean);
      }),
    );
  }, [onResolve, answers, prompt.questions]);

  // 主输入作答：文本填当前页（自定义回答），非末页自动翻页
  useEffect(() => {
    if (!registerAnswer) return;
    const fn: ExternalAnswerFn = (text) => {
      pickCustom(text);
      return true;
    };
    registerAnswer(fn);
    return () => registerAnswer(null);
  }, [registerAnswer, pickCustom]);

  // Esc 取消整批；数字快选（焦点不在输入框时）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      // 组合键与 IME 组合中的数字不快选，防误答
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, [contenteditable="true"]')) return;
      if (hasOptions) {
        const idx = Number(e.key) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
          e.preventDefault();
          if (multi) toggleMulti(idx);
          else pickSingle(idx);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hasOptions, options, multi, toggleMulti, pickSingle, cancel]);

  // 翻页后开放式问题自动聚焦输入框
  useEffect(() => {
    if (!hasOptions) inputRef.current?.focus();
  }, [hasOptions]);

  const prev = page > 0;
  const next = !isLast;

  return (
    <div
      className="prompt-shelf__card prompt-shelf__card--batch"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={hintId}
    >
      {/* 书眉：卷名 · 类型 · 进度 */}
      <div className="prompt-shelf__head">
        {/* 文案与旧版逐字一致（`问 n/N · header`）——书眉只是换了版式与字号，
         *  不在这一批里改读法（测试对文案是行为级断言，改文案=改行为，要单独拍板）。 */}
        <Kicker badge={prompt.badge} typeClass="prompt-shelf__kicker-kind--ask">
          {`问 ${page + 1}/${total}`}
          {prompt.header ? ` · ${prompt.header.slice(0, 12)}` : ''}
          {multi ? ' · 多选' : ''}
        </Kicker>
        <button className="prompt-shelf__dismiss" onClick={cancel} data-tip="取消整批 (Esc)" type="button">
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* 问题句：主角 */}
      <p id={titleId} className="prompt-shelf__question">
        {q.question}
      </p>

      {/* 选项（开放式无 options 隐藏） */}
      {hasOptions && (
        <div className="prompt-shelf__options">
          {options.map((opt, i) => {
            const cur = answers[page];
            const on = cur?.kind === 'idx' && (multi ? cur.idxs.includes(i) : cur.idxs[0] === i);
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 选项允许重复 label，index 是唯一稳定键（idx 存储）
                key={i}
                className={`prompt-shelf__option${on ? ' prompt-shelf__option--on' : ''}`}
                onClick={() => (multi ? toggleMulti(i) : pickSingle(i))}
                aria-pressed={on}
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

      {/* 开放式 / 自定义输入 + 整批提交（动作行在上，翻页行在下——旧实现把
       *  翻页器与提交钮塞进同一条 .pagebar，提交钮被迫缩在右侧当次按钮） */}
      <div className="prompt-shelf__foot">
        <input
          ref={inputRef}
          className="prompt-shelf__custom-input"
          type="text"
          placeholder={hasOptions ? '或输入自定义回答…' : '输入回答后回车…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) {
                e.preventDefault();
                pickCustom(v);
              }
            }
          }}
        />
        <button
          className="prompt-shelf__confirm"
          disabled={!anyAnswered}
          onClick={submitAll}
          data-tip={anyAnswered ? '提交全部答案（未答题按空返回）' : '先作答至少一题'}
          type="button"
        >
          {`提交（已答 ${answeredCount}/${total}）`}
        </button>
      </div>

      {/* 翻页行 */}
      {total > 1 && (
        <div className="prompt-shelf__pager">
          <button className="prompt-shelf__nav" disabled={!prev} onClick={() => setPage(page - 1)} type="button">
            ← 上一题
          </button>
          <ProgressDots total={total} page={page} answers={answers} />
          <button className="prompt-shelf__nav" disabled={!next} onClick={() => setPage(page + 1)} type="button">
            下一题 →
          </button>
        </div>
      )}

      <div id={hintId}>
        <Keyhint
          items={[
            hasOptions ? `1–${options.length} ${multi ? '多选' : '选择'}` : '',
            multi ? 'Enter 下一页' : 'Enter 提交',
            'Esc 取消整批',
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
  /** 激活卡注册的主输入作答回调（批量卡需要访问分页状态——只能由卡注册） */
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
    (prompt: AskPrompt & PromptOwner) => enqueue({ ...prompt, type: 'ask' }) as Promise<string[] | null>,
    [enqueue],
  );

  const showAskBatch = useCallback(
    (prompt: AskBatchPrompt & PromptOwner) =>
      enqueue({ ...prompt, type: 'ask-batch' }) as Promise<(string[] | null)[] | null>,
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
    for (const item of q) item.resolve(timeoutValue(item.prompt));
  }, []);

  /** 按归属卷关闭：匹配项按取消解析（含激活卡），其余照常。 */
  const dismissByOwner = useCallback((ownerSid: number | null) => {
    const remains: QueuedPrompt[] = [];
    const q = queueRef.current;
    queueRef.current = remains;
    let activeKilled = false;
    for (const item of q) {
      if ((item.prompt.ownerSid ?? null) === ownerSid) {
        item.resolve(timeoutValue(item.prompt));
        if (q[0] === item) activeKilled = true;
      } else {
        remains.push(item);
      }
    }
    if (activeKilled) setActive(remains[0]?.prompt ?? null);
  }, []);

  /** 把某卷的第一张在等卡顶到队头（2026-11-11 画布多卷审批 UX · A 面）。
   *  返回 true = 发生了移动。边界：该卷没有在等卡 / 本来就在队头 = false（no-op）；
   *  只重排**顺序**，不动卡的归属与内容。注意：原队头卡会被换下（组件卸载），
   *  用户在该卡上已填未交的内容随之丢弃——触发源是用户主动点名另一卷，属明确意图。 */
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

  /** 主输入作答：架头是提问卡时以 text 作答（单问整卡提交 / 批量填当前页）。 */
  const answerActiveText = useCallback(
    (text: string): boolean => {
      const head = queueRef.current[0];
      if (!head) return false;
      if (head.prompt.type === 'ask') {
        resolveHead([text]);
        return true;
      }
      if (head.prompt.type === 'ask-batch') return answerFnRef.current?.(text) ?? false;
      return false; // 权限卡不吃文本作答
    },
    [resolveHead],
  );

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
      {active?.type === 'ask' ? (
        <AskCard key={active.id} prompt={active} onResolve={resolveHead} registerAnswer={registerAnswer} />
      ) : active?.type === 'ask-batch' ? (
        <AskBatchCard key={active.id} prompt={active} onResolve={resolveHead} registerAnswer={registerAnswer} />
      ) : active?.type === 'permission' ? (
        <PermCard key={active.id} prompt={active} onResolve={resolveHead} />
      ) : null}
    </div>
  );
});
