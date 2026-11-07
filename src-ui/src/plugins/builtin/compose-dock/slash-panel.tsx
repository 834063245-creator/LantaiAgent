// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 斜杠补全面板（v3，2026-11-07）——从 ComposerDock 拆出（上帝文件体量门禁
// tests/god-file-budget.test.ts 的「拆小」，拆出后坞本体重回档内）。
//
// 形态 = 用户拍板的「分组双行」：节头（组名 + 方墨锚点，非按钮）→ 每行两行制
//   （斜杠词 mono + 显示名 600 + 描述 11px 单行省略）。
// 三件行为都在本件内自闭：
//   ① 分组：同名组合流成一节，节序 = 首现序（命令目录已按「三段来源相邻」排，
//      这里做的是同名兜底——插件贡献与内建命令可能撞同名组，散在两处会出双节头）；
//   ② 高亮可滚：↑↓ 走到可视区外时把那一行滚进来（旧实现只改 class，第 8 条起
//      高亮落在滚动区外——键盘选着选着就「不见了」）；用 rect 差值而不是
//      scrollIntoView（后者会连带滚动祖先，坞是浮层，禁连坐）；
//   ③ 命中标朱：查询词可能在斜杠词/显示名/描述三处命中，标出来才知道「它为什么在列」。
//
// 归属：纯呈现件——命令清单、高亮下标、提交动作全由坞注入；本件不持有命令状态。

import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import type { CommandContribution } from './host';

/** 面板一行：命令 + 在**过滤后扁平序**里的下标（↑↓ 的 slashIdx 认这个序）。 */
interface SectionRow {
  cmd: CommandContribution;
  idx: number;
}

interface Section {
  name: string;
  items: SectionRow[];
}

/** 同名组合流：Map 保插入序 ⇒ 节序 = 首现序。 */
export function groupCommands(commands: readonly CommandContribution[]): Section[] {
  const map = new Map<string, SectionRow[]>();
  commands.forEach((cmd, idx) => {
    const list = map.get(cmd.group) ?? [];
    list.push({ cmd, idx });
    map.set(cmd.group, list);
  });
  return [...map.entries()].map(([name, items]) => ({ name, items }));
}

/** 命中片段标朱：按出现位置切成 <mark> 段（大小写不敏感，同 filterCommands 口径）。 */
export function highlightHits(text: string, query: string) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let key = 0;
  for (;;) {
    const at = lower.indexOf(q, from);
    if (at < 0) {
      parts.push(text.slice(from));
      break;
    }
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={key++}>{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
  }
  return parts;
}

export interface SlashPanelProps {
  /** 过滤后的命令（扁平序 = ↑↓ 序）。 */
  commands: readonly CommandContribution[];
  /** 当前高亮下标（扁平序）。 */
  activeIdx: number;
  /** 命中查询词（已去首斜杠，小写口径由本件自理）。 */
  query: string;
  onHover: (idx: number) => void;
  onCommit: (cmd: CommandContribution) => void;
}

export function SlashPanel({ commands, activeIdx, query, onHover, onCommit }: SlashPanelProps) {
  const sections = useMemo(() => groupCommands(commands), [commands]);
  const listRef = useRef<HTMLDivElement>(null);

  // 换查询词 = 换清单，滚动位置作废（旧实现留着上一份清单的 scrollTop，首项常被藏在顶上）
  // biome-ignore lint/correctness/useExhaustiveDependencies: query 是刻意的「清单换代」触发器——正是要响应它把滚动归零
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);

  useEffect(() => {
    const box = listRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-slash-idx="${activeIdx}"]`);
    if (!box || !row) return;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }, [activeIdx]);

  return (
    <div className="pp-slash" role="listbox" aria-label="斜杠命令" ref={listRef}>
      {sections.map((section) => (
        // biome-ignore lint/a11y/useSemanticElements: listbox 分节只有 role="group" 能表达（fieldset 会割断 option 归属链）
        <div className="pp-slash-group" key={section.name} role="group" aria-label={section.name}>
          <div className="pp-slash-group-head">{section.name}</div>
          {section.items.map(({ cmd, idx }) => (
            <button
              key={cmd.id}
              type="button"
              role="option"
              aria-selected={idx === activeIdx}
              data-slash-idx={idx}
              className={`pp-slash-item${idx === activeIdx ? ' active' : ''}`}
              onMouseEnter={() => onHover(idx)}
              onClick={() => onCommit(cmd)}
            >
              <span className="pp-slash-lead">
                <span className="pp-slash-shortcut">{highlightHits(cmd.slash ?? cmd.kbd ?? '', query)}</span>
                <span className="pp-slash-label">{highlightHits(cmd.label, query)}</span>
              </span>
              {cmd.description ? <span className="pp-slash-desc">{highlightHits(cmd.description, query)}</span> : null}
            </button>
          ))}
        </div>
      ))}
      {sections.length === 0 && <div className="pp-slash-empty">无匹配命令</div>}
    </div>
  );
}
