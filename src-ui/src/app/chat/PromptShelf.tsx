// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PromptShelf — 消息和输入框之间的统一提示区
// 同时处理 ask_user 卡片和权限审批。
// 不在消息数组内 — 独立的 React root。

import type React from 'react';
import type { ReactNode } from 'react';
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { iconSvg } from '../../ui/icons';
import './prompt-shelf.css';

// ── 类型 ──

/** 内联 SVG 图标 — 单点色 dangerousHTML（iconSvg 返回自有静态图标库字符串，
 *  非用户输入，无 XSS 面）；全部使用点经此组件，豁免只留这一处。 */
function Icon({ name, size = 12 }: { name: string; size?: number }): React.ReactElement {
  // 装饰性图标（2026-08-29 走查）：语义由宿主按钮 title 承载，不进无障碍树
  // biome-ignore lint/security/noDangerouslySetInnerHtml: 自有静态图标库字符串（ui/icons.ts），非用户输入
  return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconSvg(name, size) }} />;
}

/** 批量多问的单条题目 */
export interface AskQuestionItem {
  question: string;
  header?: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
}

export interface AskPrompt {
  type: 'ask';
  id: string;
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** 批量多问：一次推全部 questions，UI 分页收集后一次性提交全部答案 */
export interface AskBatchPrompt {
  type: 'ask-batch';
  id: string;
  /** 批次标签（卡片 tag 显示；缺省"提问"） */
  header?: string;
  questions: AskQuestionItem[];
}

export interface PermissionPrompt {
  type: 'permission';
  id: string;
  toolName: string;
  reason: string;
  subject: string;
  /** 高危操作标签，如 "ForceRecursiveRoot"。有值时显示红色警告卡片 */
  danger?: string;
}

/** 卡片归属面（2026-09-10 ask 用户侧完备化）：
 *  - ownerSid：归属卷号（null = 面板级/无归属）——停止语义按卷杀卡
 *    （dismissByOwner），切卷/停他卷不再一刀切清全架；
 *  - badge：归属卷名徽标（多卷并发时「替哪卷作答」），独立 chip 渲染
 *    （此前与 header 拼串后按 12 字截断——徽标把真 header 吃掉）。 */
export interface PromptOwner {
  ownerSid?: number | null;
  badge?: string | null;
}

export type PromptData = (AskPrompt | AskBatchPrompt | PermissionPrompt) & PromptOwner;

// ── 图标 ──（svgIcon 包装已删 — Icon 组件直用 iconSvg）

// ── 询问卡片（受 Reasonix 启发：键盘导航、悬停预览、多选）──
// 2026-09-10 ask 用户侧完备化：单选退役 240ms 自动确认——点选只选中，
// 显式「确认选择」/Enter 提交。自动确认是「没下判断就被回答」的历史病灶
// （用户实测报「我这实际没有给你下任何判断」：点选以为还能改，卡片已无声
// 提交）；240ms 反悔窗人类不可感知，等于没有确认环节。

/** 主输入作答回调面（shelf → 激活卡注册；text = 主输入框文本）。
 *  返回 false = 该卡不吃文本作答（权限卡等）。 */
export type ExternalAnswerFn = (text: string) => boolean;

/** 归属面 chips（badge 卷徽标与类型 tag 分列——徽标不再挤占 header 的 12 字预算） */
function OwnerChips({
  badge,
  typeClass,
  children,
}: {
  badge?: string | null;
  typeClass: string;
  children?: ReactNode;
}) {
  return (
    <>
      {badge ? <span className="prompt-shelf__tag prompt-shelf__tag--owner">{badge}</span> : null}
      <span className={`prompt-shelf__tag ${typeClass}`}>{children}</span>
    </>
  );
}

const AskCard: React.FC<{
  prompt: AskPrompt & PromptOwner;
  onResolve: (answer: string[] | null) => void;
  registerAnswer?: (fn: ExternalAnswerFn | null) => void;
}> = ({ prompt, onResolve, registerAnswer }) => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();

  /** 无 options = 开放式问题（用户输入自由文本回答）。 */
  const hasOptions = prompt.options.length > 0;

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

  const submitCustom = useCallback(() => {
    const v = inputRef.current?.value.trim();
    if (v) onResolve([v]);
  }, [onResolve]);

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

  const hoveredOption = hoverIdx !== null ? prompt.options[hoverIdx] : null;

  return (
    <div className="prompt-shelf__card" role="dialog" aria-modal="false" aria-labelledby={titleId}>
      {/* 头部 */}
      <div className="prompt-shelf__head">
        <OwnerChips badge={prompt.badge} typeClass="prompt-shelf__tag--ask">
          {prompt.header.slice(0, 12)}
        </OwnerChips>
        <span id={titleId} className="prompt-shelf__question">
          {prompt.question}
        </span>
        <button className="prompt-shelf__dismiss" onClick={cancel} title="取消 (Esc)" type="button">
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* 选项（开放式问题无 options 时隐藏） */}
      {hasOptions && (
        <div className="prompt-shelf__options">
          {prompt.options.map((opt, i) => {
            const on = selected.has(i);
            const num = i + 1;
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 选项允许重复 label（自定义回答场景），index 是唯一稳定键
                key={i}
                className={`prompt-shelf__option${on ? ' prompt-shelf__option--on' : ''}`}
                onClick={() => toggle(i)}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx((h) => (h === i ? null : h))}
                type="button"
              >
                <span className="prompt-shelf__num">{num <= 9 ? num : ''}</span>
                <div className="prompt-shelf__opt-body">
                  <span className="prompt-shelf__opt-label">{opt.label}</span>
                  {opt.description && <span className="prompt-shelf__opt-desc">{opt.description}</span>}
                </div>
                {on && (
                  <span className="prompt-shelf__check">
                    <Icon name="check-circle" size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 详情预览 — 始终以固定高度渲染以防抖动 */}
      {hasOptions && (
        <div className="prompt-shelf__detail">
          {hoveredOption?.description ? (
            <>
              <span className="prompt-shelf__detail-label">{hoveredOption.label}</span>
              <span className="prompt-shelf__detail-text">{hoveredOption.description}</span>
            </>
          ) : (
            <span className="prompt-shelf__detail-text" style={{ opacity: 0 }}>
              &nbsp;
            </span>
          )}
        </div>
      )}

      {/* 用于输入预定义选项之外的自定义回答；开放式问题为主输入。
       *  Enter 语义：有自定义文字提交文字；空输入且已选中项 → 提交已选项。 */}
      <div className="prompt-shelf__custom">
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
        {!hasOptions && (
          <button className="prompt-shelf__submit" onClick={submitCustom} type="button">
            提交回答
          </button>
        )}
      </div>

      {/* 确认（单选/多选同款显式提交——不选中不放行，反悔 = 再点取消选中） */}
      {hasOptions && selected.size > 0 && (
        <div className="prompt-shelf__actions">
          <button className="prompt-shelf__confirm" onClick={confirm} type="button">
            {prompt.multiSelect ? `确认选择 (${selected.size})` : '确认选择'}
          </button>
        </div>
      )}
    </div>
  );
};

// ── 批量多问分页卡 — 一次推全部 questions，分页收集，可回看改答，末页一次提交 ──

/** 单页答案内部形态（2026-09-10 完备化）：选项答案按 idx 存（重复 label 可
 *  分选——旧 label 存储在重复项上 findIndex 只命中第一枚），自定义回答存
 *  文本；提交时才折算回 label（对齐工具契约）。 */
type BatchPageAnswer = { kind: 'custom'; text: string } | { kind: 'idx'; idxs: number[] } | null;

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

  const q = prompt.questions[page];
  const options = q.options ?? [];
  const hasOptions = options.length > 0;
  const multi = hasOptions && !!q.multiSelect;
  const answered = answers[page] !== null;
  const isLast = page === total - 1;
  /** 有任一题已答即可提前提交（后页未答题按 null 返回） */
  const anyAnswered = answers.some((a) => a !== null);

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
    >
      {/* 头部：进度 + 取消 */}
      <div className="prompt-shelf__head">
        <OwnerChips badge={prompt.badge} typeClass="prompt-shelf__tag--ask">
          {total > 1 ? `问 ${page + 1}/${total}` : '问询'}
          {prompt.header ? ` · ${prompt.header}` : ''}
        </OwnerChips>
        <span id={titleId} className="prompt-shelf__question">
          {q.question}
        </span>
        <button className="prompt-shelf__dismiss" onClick={cancel} title="取消整批 (Esc)" type="button">
          <Icon name="close" size={14} />
        </button>
      </div>

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
                type="button"
              >
                <span className="prompt-shelf__num">{i + 1 <= 9 ? i + 1 : ''}</span>
                <div className="prompt-shelf__opt-body">
                  <span className="prompt-shelf__opt-label">{opt.label}</span>
                  {opt.description && <span className="prompt-shelf__opt-desc">{opt.description}</span>}
                </div>
                {on && (
                  <span className="prompt-shelf__check">
                    <Icon name="check-circle" size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 开放式 / 自定义输入 */}
      <div className="prompt-shelf__custom">
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
      </div>

      {/* 底部：分页导航 + 批量提交 */}
      <div className="prompt-shelf__pagebar">
        <div className="prompt-shelf__pager">
          <button className="prompt-shelf__nav" disabled={!prev} onClick={() => setPage(page - 1)} type="button">
            ← 上一题
          </button>
          <span className="prompt-shelf__dots">
            {prompt.questions.map((_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: 进度点无稳定 id（questions 仅题目文本），index 与页码同构
                key={i}
                className={`prompt-shelf__dot${i === page ? ' prompt-shelf__dot--cur' : ''}${
                  answers[i] !== null ? ' prompt-shelf__dot--done' : ''
                }`}
              />
            ))}
          </span>
          <button className="prompt-shelf__nav" disabled={!next} onClick={() => setPage(page + 1)} type="button">
            下一题 →
          </button>
        </div>
        <button
          className="prompt-shelf__confirm"
          disabled={!anyAnswered}
          onClick={submitAll}
          title={anyAnswered ? '提交全部答案（未答题按空返回）' : '先作答至少一题'}
          type="button"
        >
          {answered || !isLast ? `提交（已答 ${answers.filter((a) => a !== null).length}/${total}）` : '提交回答'}
        </button>
      </div>
    </div>
  );
};

// ── 权限卡片 ──

const PermCard: React.FC<{
  prompt: PermissionPrompt & PromptOwner;
  onResolve: (result: { allow: boolean; remember: boolean }) => void;
}> = ({ prompt, onResolve }) => {
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
      className={`prompt-shelf__card${prompt.danger ? ' prompt-shelf__card--danger' : ''}`}
      role="alertdialog"
      aria-modal="true"
      aria-label="权限请示"
    >
      <div className="prompt-shelf__head">
        <OwnerChips badge={prompt.badge} typeClass={prompt.danger ? 'prompt-shelf__tag--danger' : ''}>
          {prompt.danger ? `危 · ${prompt.danger}` : '请示 · PERMIT'}
        </OwnerChips>
        <span className="prompt-shelf__question">{prompt.toolName}</span>
      </div>
      {prompt.subject && <div className="prompt-shelf__perm-subject">{prompt.subject}</div>}
      <div className="prompt-shelf__perm-reason">{prompt.reason}</div>
      <div className="prompt-shelf__perm-btns">
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
          落印准此 · Enter
        </button>
        <button
          className="prompt-shelf__perm-btn prompt-shelf__perm-btn--deny"
          onClick={() => onResolve({ allow: false, remember: false })}
          type="button"
        >
          驳回 · Esc
        </button>
      </div>
    </div>
  );
};

// ── 暴露的命令式 API（core 注册接口签名不变 + 2026-09-10 完备化两面）──

export interface PromptShelfHandle {
  readonly active: PromptData | null;
  /** 显示询问提示。返回 Promise，解析为选中的标签或 null（取消时）。 */
  showAsk(prompt: AskPrompt & PromptOwner): Promise<string[] | null>;
  /** 显示批量多问（分页收集）。返回 Promise，解析为对齐 questions 的答案数组或 null（取消时）。 */
  showAskBatch(prompt: AskBatchPrompt & PromptOwner): Promise<(string[] | null)[] | null>;
  /** 显示权限提示。返回 Promise，解析为 allow/remember。 */
  showPermission(prompt: PermissionPrompt & PromptOwner): Promise<{ allow: boolean; remember: boolean }>;
  /** 关闭当前提示（取消挂起的 Promise）。 */
  dismiss(): void;
  /** 按归属卷关闭（2026-09-10 完备化）：停 A 卷只杀 A 卷的卡——
   *  切卷/停他卷不再一刀切清全架（别的卷在等答案的提问卡曾被误杀，
   *  Agent 收「用户取消」而用户没答过）。ownerSid 匹配 ownerSid ?? null。 */
  dismissByOwner(ownerSid: number | null): void;
  /** 主输入作答（2026-09-10 完备化）：架头是提问卡时以 text 作答——
   *  单问卡整卡提交（自定义回答）；批量卡填当前页并翻页。
   *  返回 false = 架头不是提问卡（权限卡/空架），调用方走常规发送路径。 */
  answerActiveText(text: string): boolean;
}

// ── Shelf 组件（P2′-2b：直接挂 ChatBeacon 树，Controller 包装已删）──
// FIFO 队列：同轮多个 ask_user / 权限请求排队展示，不再互相顶掉
// （旧实现第二个提示会以 null 静默取消第一个 → 模型收到"用户取消"并重复追问，
//   观感即"点击后卡死"）。每张卡激活时起 5 分钟超时兜底 —
//   无操作自动按取消解析，从根上防工具 promise 永久挂起。

/** 卡片激活后无操作的最长等待时间 — 超时按取消解析 */
const CARD_TIMEOUT_MS = 5 * 60 * 1000;

interface QueuedPrompt {
  prompt: PromptData;
  resolve: (v: unknown) => void;
  /** 激活时启动的超时定时器；未激活的队列项为 null */
  timer: number | null;
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

  /** 解析队头并激活下一张。稳定引用 — 超时定时器与卡片点击共用。 */
  const resolveHead = useCallback((v: unknown) => {
    const head = queueRef.current.shift();
    if (head) {
      if (head.timer !== null) window.clearTimeout(head.timer);
      head.resolve(v);
    }
    const next = queueRef.current[0];
    setActive(next?.prompt ?? null);
    if (next) {
      next.timer = window.setTimeout(() => resolveHead(timeoutValue(next.prompt)), CARD_TIMEOUT_MS);
    }
  }, []);

  /** 入队；队列原本为空时立即激活队头。 */
  const enqueue = useCallback(
    (prompt: PromptData): Promise<unknown> =>
      new Promise((resolve) => {
        queueRef.current.push({ prompt, resolve, timer: null });
        if (queueRef.current.length === 1) {
          const head = queueRef.current[0];
          head.timer = window.setTimeout(() => resolveHead(timeoutValue(head.prompt)), CARD_TIMEOUT_MS);
          setActive(head.prompt);
        }
      }),
    [resolveHead],
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
    for (const item of q) {
      if (item.timer !== null) window.clearTimeout(item.timer);
      item.resolve(timeoutValue(item.prompt));
    }
  }, []);

  /** 按归属卷关闭：匹配项按取消解析（含激活卡），其余照常。 */
  const dismissByOwner = useCallback(
    (ownerSid: number | null) => {
      const remains: QueuedPrompt[] = [];
      const q = queueRef.current;
      queueRef.current = remains;
      let activeKilled = false;
      for (const item of q) {
        if ((item.prompt.ownerSid ?? null) === ownerSid) {
          if (item.timer !== null) window.clearTimeout(item.timer);
          item.resolve(timeoutValue(item.prompt));
          if (q[0] === item) activeKilled = true;
        } else {
          remains.push(item);
        }
      }
      if (activeKilled) {
        const next = remains[0];
        setActive(next?.prompt ?? null);
        if (next) next.timer = window.setTimeout(() => resolveHead(timeoutValue(next.prompt)), CARD_TIMEOUT_MS);
      }
    },
    [resolveHead],
  );

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
      answerActiveText,
    }),
    [showAsk, showAskBatch, showPermission, dismissAll, dismissByOwner, answerActiveText],
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
