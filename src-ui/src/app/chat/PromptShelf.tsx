// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PromptShelf — 消息和输入框之间的统一提示区
// 同时处理 ask_user 卡片和权限审批。
// 不在消息数组内 — 独立的 React root。

import type React from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { iconSvg } from '../../ui/icons';
import './prompt-shelf.css';

// ── 类型 ──

/** 内联 SVG 图标 — 单点色 dangerousHTML（iconSvg 返回自有静态图标库字符串，
 *  非用户输入，无 XSS 面）；全部使用点经此组件，豁免只留这一处。 */
function Icon({ name, size = 12 }: { name: string; size?: number }): React.ReactElement {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: 自有静态图标库字符串（ui/icons.ts），非用户输入
  return <span dangerouslySetInnerHTML={{ __html: iconSvg(name, size) }} />;
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

export type PromptData = AskPrompt | AskBatchPrompt | PermissionPrompt;

// ── 图标 ──（svgIcon 包装已删 — Icon 组件直用 iconSvg）

// ── 询问卡片（受 Reasonix 启发：键盘导航、悬停预览、多选） ──

const AskCard: React.FC<{
  prompt: AskPrompt;
  onResolve: (answer: string[] | null) => void;
}> = ({ prompt, onResolve }) => {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const advanceTimer = useRef<number | null>(null);

  /** 无 options = 开放式问题（用户输入自由文本回答）。 */
  const hasOptions = prompt.options.length > 0;

  const toggle = useCallback(
    (idx: number) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (prompt.multiSelect) {
          next.has(idx) ? next.delete(idx) : next.add(idx);
        } else {
          next.clear();
          next.add(idx);
        }
        return next;
      });

      // 单选：短暂延迟后自动确认（240ms——140ms 对误触零宽容，2026-08 UI 大清扫放宽；
      // 延迟窗内再点同一项 = 取消反悔，点其他项 = 改选）
      if (!prompt.multiSelect) {
        if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
        if (selected.has(idx)) {
          // 反悔：取消选中并放弃本次自动确认
          setSelected(new Set());
          return;
        }
        advanceTimer.current = window.setTimeout(() => {
          const labels = prompt.options.filter((_, i) => i === idx).map((o) => o.label);
          onResolve(labels);
        }, 240);
      }
    },
    [prompt, onResolve, selected],
  );

  const confirm = useCallback(() => {
    const labels = prompt.options.filter((_, i) => selected.has(i)).map((o) => o.label);
    onResolve(labels);
  }, [prompt.options, selected, onResolve]);

  const submitCustom = useCallback(() => {
    const v = inputRef.current?.value.trim();
    if (v) onResolve([v]);
  }, [onResolve]);

  const cancel = useCallback(() => {
    // 清掉待触发的自动确认，防取消后定时器泄漏到下一张卡
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    onResolve(null);
  }, [onResolve]);

  // 卸载时清掉未触发的自动确认定时器（挂载即注册清理，兜底所有后续 set 的 timer）
  useEffect(() => {
    return () => {
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      // 焦点在输入框（自定义回答 / 聊天输入）时不触发数字快选，防误答
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < prompt.options.length) {
        e.preventDefault();
        toggle(idx);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [prompt.options.length, toggle, cancel]);

  const hoveredOption = hoverIdx !== null ? prompt.options[hoverIdx] : null;

  return (
    <div className="prompt-shelf__card" role="dialog" aria-modal="false">
      {/* 头部 */}
      <div className="prompt-shelf__head">
        <span className="prompt-shelf__tag prompt-shelf__tag--ask">{prompt.header.slice(0, 12)}</span>
        <span className="prompt-shelf__question">{prompt.question}</span>
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

      {/* 用于输入预定义选项之外的自定义回答；开放式问题为主输入 */}
      <div className="prompt-shelf__custom">
        <input
          ref={inputRef}
          className="prompt-shelf__custom-input"
          type="text"
          placeholder={hasOptions ? '或者直接输入自定义回答…' : '输入回答后回车提交…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
              e.preventDefault();
              onResolve([(e.target as HTMLInputElement).value.trim()]);
            }
          }}
        />
        {!hasOptions && (
          <button className="prompt-shelf__submit" onClick={submitCustom} type="button">
            提交回答
          </button>
        )}
      </div>

      {/* 多选确认 */}
      {prompt.multiSelect && hasOptions && selected.size > 0 && (
        <div className="prompt-shelf__actions">
          <button className="prompt-shelf__confirm" onClick={confirm} type="button">
            确认选择 ({selected.size})
          </button>
        </div>
      )}
    </div>
  );
};

// ── 批量多问分页卡 — 一次推全部 questions，分页收集，可回看改答，末页一次提交 ──

const AskBatchCard: React.FC<{
  prompt: AskBatchPrompt;
  onResolve: (answers: (string[] | null)[] | null) => void;
}> = ({ prompt, onResolve }) => {
  const total = prompt.questions.length;
  const [page, setPage] = useState(0); // 0-based 当前页
  /** answers[i] = 第 i 题答案（string[]）；null = 未答 */
  const [answers, setAnswers] = useState<(string[] | null)[]>(() => prompt.questions.map(() => null));
  const inputRef = useRef<HTMLInputElement | null>(null);

  const q = prompt.questions[page];
  const options = q.options ?? [];
  const hasOptions = options.length > 0;
  const multi = hasOptions && !!q.multiSelect;
  const answered = answers[page] !== null;
  const isLast = page === total - 1;
  /** 有任一题已答即可提前提交（后页未答题按 null 返回） */
  const anyAnswered = answers.some((a) => a !== null);

  /** 当前页答案写入（覆盖式） */
  const setAnswer = useCallback(
    (v: string[]) => {
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
    (labels: string[]) => {
      setAnswer(labels);
      if (!isLast) setPage(page + 1);
    },
    [setAnswer, isLast, page],
  );

  const toggleMulti = useCallback(
    (idx: number) => {
      setAnswers((prev) => {
        const next = [...prev];
        const cur = new Set<number>(
          (next[page] ?? [])
            .map((label) => {
              const i = options.findIndex((o) => o.label === label);
              return i;
            })
            .filter((i): i is number => i >= 0),
        );
        cur.has(idx) ? cur.delete(idx) : cur.add(idx);
        next[page] = cur.size > 0 ? options.filter((_, i) => cur.has(i)).map((o) => o.label) : null;
        return next;
      });
    },
    [page, options],
  );

  const cancel = useCallback(() => onResolve(null), [onResolve]);

  /** 整批提交：未答题保持 null（模型侧对齐 questions 索引可见哪些没答） */
  const submitAll = useCallback(() => onResolve(answers), [onResolve, answers]);

  // Esc 取消整批；数字快选（焦点不在输入框时）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (hasOptions) {
        const idx = Number(e.key) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
          e.preventDefault();
          if (multi) toggleMulti(idx);
          else pickSingle(options.filter((_, i) => i === idx).map((o) => o.label));
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
    <div className="prompt-shelf__card prompt-shelf__card--batch" role="dialog" aria-modal="false">
      {/* 头部：进度 + 取消 */}
      <div className="prompt-shelf__head">
        <span className="prompt-shelf__tag prompt-shelf__tag--ask">
          {total > 1 ? `问 ${page + 1}/${total}` : '问询'}
          {prompt.header ? ` · ${prompt.header}` : ''}
        </span>
        <span className="prompt-shelf__question">{q.question}</span>
        <button className="prompt-shelf__dismiss" onClick={cancel} title="取消整批 (Esc)" type="button">
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* 选项（开放式无 options 隐藏） */}
      {hasOptions && (
        <div className="prompt-shelf__options">
          {options.map((opt, i) => {
            const cur = answers[page];
            const on = multi ? (cur?.includes(opt.label) ?? false) : cur?.[0] === opt.label;
            return (
              <button
                key={opt.label}
                className={`prompt-shelf__option${on ? ' prompt-shelf__option--on' : ''}`}
                onClick={() => (multi ? toggleMulti(i) : pickSingle([opt.label]))}
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
                setAnswer([v]);
                if (!isLast) setPage(page + 1);
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
  prompt: PermissionPrompt;
  onResolve: (result: { allow: boolean; remember: boolean }) => void;
}> = ({ prompt, onResolve }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在输入框（聊天输入等）时不触发快捷键，防打字误批准/误拒绝
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onResolve({ allow: false, remember: false });
        return;
      }
      if (e.key === 'Enter') {
        // 焦点已在弹层按钮上时让原生 click 走（避免 Enter 双发：监听 + 按钮激活各一次）
        if (target?.closest('button')) return;
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
        <span className={`prompt-shelf__tag${prompt.danger ? ' prompt-shelf__tag--danger' : ''}`}>
          {prompt.danger ? `危 · ${prompt.danger}` : '请示 · PERMIT'}
        </span>
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

// ── 暴露的命令式 API（core 注册接口签名不变）──

export interface PromptShelfHandle {
  readonly active: PromptData | null;
  /** 显示询问提示。返回 Promise，解析为选中的标签或 null（取消时）。 */
  showAsk(prompt: AskPrompt): Promise<string[] | null>;
  /** 显示批量多问（分页收集）。返回 Promise，解析为对齐 questions 的答案数组或 null（取消时）。 */
  showAskBatch(prompt: AskBatchPrompt): Promise<(string[] | null)[] | null>;
  /** 显示权限提示。返回 Promise，解析为 allow/remember。 */
  showPermission(prompt: PermissionPrompt): Promise<{ allow: boolean; remember: boolean }>;
  /** 关闭当前提示（取消挂起的 Promise）。 */
  dismiss(): void;
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
    (prompt: AskPrompt) => enqueue({ ...prompt, type: 'ask' }) as Promise<string[] | null>,
    [enqueue],
  );

  const showAskBatch = useCallback(
    (prompt: AskBatchPrompt) => enqueue({ ...prompt, type: 'ask-batch' }) as Promise<(string[] | null)[] | null>,
    [enqueue],
  );

  const showPermission = useCallback(
    (prompt: PermissionPrompt) =>
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
    }),
    [showAsk, showAskBatch, showPermission, dismissAll],
  );

  return (
    <div className="prompt-shelf">
      {active?.type === 'ask' ? (
        <AskCard key={active.id} prompt={active} onResolve={resolveHead} />
      ) : active?.type === 'ask-batch' ? (
        <AskBatchCard key={active.id} prompt={active} onResolve={resolveHead} />
      ) : active?.type === 'permission' ? (
        <PermCard key={active.id} prompt={active} onResolve={resolveHead} />
      ) : null}
    </div>
  );
});
