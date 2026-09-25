// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PromptShelf — 消息和输入框之间的统一提示区
// 同时处理 ask_user 卡片和权限审批。
// 不在消息数组内 — 独立的 React root。
//
// 批 9e-3（2026-09-26）：实现随产物包 `ask-cards`（旧 `app/chat/PromptShelf.tsx`）；
// **形状留内核契约** `app/chat/ask-card-contract.ts`（三个 prompt 类型 + `PromptData`
// + `PromptShelfHandle` 五动词）——内核 `chat-core` 是消费侧，铁律禁内核 import 产物源码。

import type React from 'react';
import type { ReactNode } from 'react';
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

/** 自定义答案提交钮（2026-09-16 修断链）——非空输入才出现。
 *  此前「提交回答」钮只在开放式问题（无选项）时渲染，有选项卡上用户自己
 *  打字后**没有任何可点的提交键**（测试也只走 Enter 路径，故长期未暴露）。
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

      {/* 自定义答案提交（2026-09-16 修断链）：**有选项时也出按钮**——
       *  此前按钮只在 `!hasOptions` 时渲染，有选项卡上用户自己打字后
       *  找不到任何可点的提交键（只能碰运气按 Enter，或误点选项把选项答案
       *  提交掉）——「用户填写内容再发送」的链路即断在这里。
       *  非空输入才出（避免与「确认选择」并排时按钮含义含糊）。 */}
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
      </div>

      {/* 底部动作区：自定义提交 + 选项确认并列（各自独立，互不遮蔽） */}
      <div className="prompt-shelf__actions">
        <SubmitCustomButton inputRef={inputRef} onResolve={onResolve} />
        {hasOptions && selected.size > 0 && (
          <button className="prompt-shelf__confirm" onClick={confirm} type="button">
            {prompt.multiSelect ? `确认选择 (${selected.size})` : '确认选择'}
          </button>
        )}
      </div>
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
