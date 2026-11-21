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

/** 手动覆盖的初始声明：优先沿用供应商映射的请求值，其次才算整档位名。 */
function seedEntries(
  efforts: readonly ThinkingEffort[] | undefined,
  sourceLevelMap: ThinkingLevelMap | undefined,
): Entry[] {
  const mapLevels = sourceLevelMap ? THINKING_EFFORTS.filter((level) => sourceLevelMap[level] !== undefined) : [];
  const levels: ReasoningLevel[] =
    efforts !== undefined && efforts.length > 0
      ? [...efforts]
      : mapLevels.length > 0
        ? mapLevels
        : ['low', 'medium', 'high'];
  const off = sourceLevelMap?.off ?? null;
  return [
    ['off', off],
    ...levels.map((level): Entry => {
      const wire = sourceLevelMap?.[level];
      return [level, typeof wire === 'string' && wire.trim() ? wire.trim() : level];
    }),
  ];
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
  /** 该模型已声明的档位（API 拉取/目录）；手动覆盖时作为播种底稿。 */
  efforts?: readonly ThinkingEffort[];
  /** 供应商/目录给出的「档位 → API 参数值」；缺省 = 档位按名称原值发送。 */
  sourceLevelMap?: ThinkingLevelMap;
  /** 当前生效声明来自哪儿（API 拉取 / 内置目录 / 手动覆盖 / 未声明）。 */
  sourceLabel: string;
  /** 已存储的自定义声明（false = 显式不推理；undefined = 未声明）。 */
  value: false | ThinkingLevelMap | undefined;
  /** 写入新声明；undefined = 删除声明（回落到 API 拉取/目录的档位）。 */
  onChange: (next: false | ThinkingLevelMap | undefined) => void;
}

/** 渲染一个模型的推理等级声明编辑器。 */
export function ModelReasoningLevels({
  efforts,
  sourceLevelMap,
  sourceLabel,
  value,
  onChange,
}: ModelReasoningLevelsProps) {
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
  const sourceRows: Entry[] = sourceLevelMap
    ? (Object.entries(sourceLevelMap) as Entry[])
    : (efforts ?? []).map((level): Entry => [level, level]);

  return (
    <div className="pp-model-reasoning">
      <div className="pp-model-reasoning-head">
        <span className="pp-model-param">
          推理档位声明（模型支持哪些档）
          <span
            className="pp-model-param-src"
            data-tip="这里只描述模型能力：支持哪些档、每档请求里发什么参数值。它不决定这次用哪一档——那是创作坞「思考」里的会话选择。通常由供应商 /models 或内置目录给出，只有声明缺失或错误时才需要手动覆盖。"
          >
            ?
          </span>
          <span className="pp-chip">{sourceLabel}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="手动覆盖推理档位声明"
          className={`sp-btn-sm${on ? ' is-on' : ''}`}
          onClick={() => {
            write(on ? undefined : seedEntries(efforts, sourceLevelMap));
          }}
        >
          {on ? '恢复声明' : '手动覆盖'}
        </button>
      </div>
      {entries === undefined ? (
        // 未手动覆盖：如实展示供应商/目录给出的能力声明与请求值映射。
        <span className="pp-model-levels-current">
          {sourceRows.length > 0
            ? `生效声明：${sourceRows
                .map(([level, wire]) =>
                  sourceLevelMap
                    ? `${thinkingModeLabel(level)} → ${wire === null ? '不发送参数' : wire}`
                    : thinkingModeLabel(level),
                )
                .join(' · ')}${sourceLevelMap ? '（请求按该映射发送）' : '（档位名原值发送）'}`
            : '生效声明：未声明——创作坞只提供「自动 / 关闭」安全兜底，不编造档位。可点「手动覆盖」补声明。'}
        </span>
      ) : (
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
          ? '当前是手动覆盖：这里的档位和参数值会原样写进请求声明。点「恢复声明」= 回落到供应商 / 内置目录。'
          : '以上只是「模型支持什么」，不是默认强度。本次实际用哪一档，请在创作坞的「思考」里按会话选择。'}
      </span>
    </div>
  );
}
