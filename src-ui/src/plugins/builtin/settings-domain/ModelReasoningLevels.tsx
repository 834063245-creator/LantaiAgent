// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// per-model 自定义推理等级（2026-10-22 对齐 DSH `ModelReasoningEfforts`）：
// 开关 + 每档一行「档位 / API 参数值」。声明本身进 ModelOverrides.reasoningEfforts，
// 请求期由三方言按值发送；关闭开关 = 删除声明、回落到 API 拉取/目录的档位。
//
// 只渲染模型里存着的东西（行序 = 声明序）；切换开关总是从「已有声明或默认档位」重新
// 播种，避免把上一行的编辑态带给下一个模型（DSH a0a041 同款修复）。

import {
  type ReasoningLevel,
  THINKING_EFFORTS,
  type ThinkingEffort,
  type ThinkingLevelMap,
  thinkingModeLabel,
} from '../../../provider/thinking';

/** 可选档位顺序（off 在前；其余按 canonical 词表）。 */
const ALL_LEVELS: readonly ReasoningLevel[] = ['off', ...THINKING_EFFORTS];

/** 一行声明：档位 + 请求里发送的 API 参数值。 */
type Entry = readonly [ReasoningLevel, string | null];

/** 档位默认发送值：档位名本身；off = 不发送参数。 */
function defaultValue(level: ReasoningLevel): string | null {
  return level === 'off' ? null : level;
}

/** 从存储值读出声明行（false/缺省 = 未声明；顺序 = 存储顺序）。 */
function readEntries(value: false | ThinkingLevelMap | undefined): Entry[] | undefined {
  if (value === undefined || value === false) return undefined;
  return Object.entries(value) as Entry[];
}

/** 开关打开时的初始声明：沿用模型已声明的档位，没有声明则给 off/low/medium/high。 */
function seedEntries(efforts: readonly ThinkingEffort[] | undefined): Entry[] {
  const levels: ReasoningLevel[] =
    efforts !== undefined && efforts.length > 0 ? [...efforts] : ['low', 'medium', 'high'];
  return [['off', null], ...levels.map((level): Entry => [level, level])];
}

/** 替换第 index 行，保留其余行的顺序与值。 */
function replaceAt(entries: readonly Entry[], index: number, entry: Entry): Entry[] {
  return entries.map((existing, at) => (at === index ? entry : existing));
}

/** 某一行可选的档位：本行当前值 + 其它行未占用的档位（保持 canonical 序）。 */
function choicesFor(level: ReasoningLevel, used: readonly ReasoningLevel[]): readonly ReasoningLevel[] {
  return ALL_LEVELS.filter((choice) => choice === level || !used.includes(choice));
}

export interface ModelReasoningLevelsProps {
  /** 该模型已声明的档位（API 拉取/目录）；开关打开时作为播种底稿。 */
  efforts?: readonly ThinkingEffort[];
  /** 已存储的自定义声明（false = 显式不推理；undefined = 未声明）。 */
  value: false | ThinkingLevelMap | undefined;
  /** 写入新声明；undefined = 删除声明（回落到 API 拉取/目录的档位）。 */
  onChange: (next: false | ThinkingLevelMap | undefined) => void;
}

/** 渲染一个模型的推理等级声明编辑器。 */
export function ModelReasoningLevels({ efforts, value, onChange }: ModelReasoningLevelsProps) {
  const entries = readEntries(value);
  const used = entries?.map(([level]) => level) ?? [];
  const write = (next: Entry[] | undefined): void => {
    onChange(next === undefined ? undefined : Object.fromEntries(next));
  };

  const changeLevel = (
    current: readonly Entry[],
    index: number,
    from: ReasoningLevel,
    wire: string | null,
    to: ReasoningLevel,
  ): void => {
    // 只有「思考档位之间」的自定义拼写才随行迁移；跨到/离开 off、或值仍等于旧档位名，
    // 都重置成新档位的默认值（避免 off 被写成 "high" 这类无意义组合）。
    const carried = typeof wire === 'string' && wire.length > 0 && wire !== from && from !== 'off' && to !== 'off';
    write(replaceAt(current, index, [to, carried ? wire : defaultValue(to)]));
  };

  const addLevel = (current: readonly Entry[]): void => {
    const highest = Math.max(-1, ...used.map((level) => ALL_LEVELS.indexOf(level)));
    const level =
      ALL_LEVELS.find((candidate, index) => index > highest && !used.includes(candidate)) ??
      ALL_LEVELS.find((candidate) => !used.includes(candidate));
    if (level === undefined) return;
    write([...current, [level, defaultValue(level)]]);
  };

  const editValue = (current: readonly Entry[], index: number, level: ReasoningLevel, text: string): void => {
    // 空串在离开字段时回落档位名；输入过程中保留原文，避免「删到一半被抢填」。
    write(replaceAt(current, index, [level, text]));
  };

  const leaveValue = (current: readonly Entry[], index: number, level: ReasoningLevel, wire: string | null): void => {
    const trimmed = typeof wire === 'string' ? wire.trim() : '';
    if (level !== 'off' && trimmed.length === 0) {
      write(replaceAt(current, index, [level, defaultValue(level)]));
    } else if (typeof wire === 'string' && trimmed !== wire) {
      write(replaceAt(current, index, [level, trimmed]));
    }
  };

  const on = entries !== undefined;
  const nonOff = entries?.filter(([level]) => level !== 'off').length ?? 0;
  const refused = on && nonOff === 0;
  const allUsed = used.length >= ALL_LEVELS.length;

  return (
    <div className="pp-model-reasoning">
      <div className="pp-model-reasoning-head">
        <span className="pp-model-param">
          推理等级
          <span
            className="pp-model-param-src"
            data-tip="API 参数值会写进请求的推理强度字段（如 OpenAI 的 reasoning_effort），默认与档位名相同；如有不同，以模型提供商的 API 文档为准。Off 表示关闭思考，不需要填写参数值。"
          >
            ?
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="推理等级"
          className={`sp-btn-sm${on ? ' is-on' : ''}`}
          onClick={() => {
            write(on ? undefined : seedEntries(efforts));
          }}
        >
          {on ? '已开启' : '未开启'}
        </button>
      </div>
      {entries === undefined ? null : (
        <>
          {entries.length > 0 ? (
            <div className="pp-model-reasoning-row pp-model-reasoning-cols" aria-hidden="true">
              <span className="pp-model-param-src">档位</span>
              <span className="pp-model-param-src">API 参数值</span>
              <span />
            </div>
          ) : null}
          {entries.map(([level, wire], index) => (
            // key 用行位置：行的身份 = 存储 dict 里的第几项；改档位 = 原地改这一项。
            // 用档位名作 key 会在改档位时重挂 select，键盘焦点丢失（DSH 同款）。
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上——行位置就是声明的身份
            <div key={index} className="pp-model-reasoning-row">
              <select
                className="sp-select"
                value={level}
                aria-label={`档位 ${String(index + 1)}`}
                onChange={(event) => {
                  changeLevel(entries, index, level, wire, event.target.value as ReasoningLevel);
                }}
              >
                {choicesFor(level, used).map((choice) => (
                  <option key={choice} value={choice}>
                    {thinkingModeLabel(choice)}
                  </option>
                ))}
              </select>
              <input
                className="sp-input"
                type="text"
                value={typeof wire === 'string' ? wire : ''}
                placeholder={level === 'off' ? '关闭思考（不发参数）' : level}
                aria-label={`${level} API 参数值`}
                disabled={level === 'off'}
                onChange={(event) => {
                  editValue(entries, index, level, event.target.value);
                }}
                onBlur={() => {
                  leaveValue(entries, index, level, wire);
                }}
              />
              <button
                type="button"
                className="pp-model-chip-x"
                aria-label={`删除档位 ${level}`}
                data-tip={
                  level !== 'off' && nonOff <= 1
                    ? '至少保留一个 Off 以外的档位；不需要思考请关闭推理等级'
                    : `删除档位 ${level}`
                }
                disabled={entries.length <= 1 || (level !== 'off' && nonOff <= 1)}
                onClick={() => {
                  write(entries.filter((_entry, at) => at !== index));
                }}
              >
                ✕
              </button>
            </div>
          ))}
          {refused ? (
            <span className="pp-model-reasoning-error">至少添加一个 Off 以外的档位，或关闭推理等级。</span>
          ) : null}
          <button
            type="button"
            className="sp-btn-sm pp-model-reasoning-add"
            disabled={allUsed}
            onClick={() => {
              addLevel(entries);
            }}
          >
            ＋ 添加档位
          </button>
        </>
      )}
      <span className="pp-model-params-hint">
        {on
          ? '本模型只提供上面这些档位；参数值原样写进请求。关闭开关 = 回落到 API 拉取/目录声明。'
          : '未自定义：沿用 API 拉取/目录声明的档位（原值发送）。'}
      </span>
    </div>
  );
}
