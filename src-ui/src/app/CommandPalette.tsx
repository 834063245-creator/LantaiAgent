// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：命令面板（Ctrl+K）— 动作注册表的统一入口。
// 过滤 = 标签子串匹配；↑↓ 选择，↵ 执行，esc 关闭。
// S4-1.5 消费闭环（设计件 §2.3）：清单 = listActions() + ctx.commands 贡献
// （折算为 AppAction 形状：action.type 'local' + handler 调用贡献执行面）；
// commandsTick 信号驱动贡献变更后的清单刷新（palette 每次打开本就重取——
// tick 让打开态的长驻清单也跟上）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { activeCommandContributions, type CommandContribution } from '../composition/services';
import { shellRefs } from '../shell/runtime';
import { usePanelDefsStore } from '../state/panel-defs-store';
import type { CommandDef } from '../ui/command-registry';
import { type AppAction, listActions } from './actions';
import { Icon } from './Icon';
import { useShellStore } from './shell-store';

/** 命令贡献 → AppAction 折算（'plugin/<id>' 命名空间防撞内置动作 id）。 */
function commandContributionActions(): AppAction[] {
  const out: AppAction[] = [];
  for (const c of activeCommandContributions()) {
    if (c == null || typeof c.id !== 'string' || c.id === '' || typeof c.label !== 'string') {
      continue; // 无效贡献跳过（插件代码不受编译期类型约束）
    }
    const contribution: CommandContribution = c;
    out.push({
      id: 'plugin/' + c.id,
      group: c.group || '插件',
      label: c.label,
      icon: undefined,
      kbd: c.shortcut || undefined,
      run: () => {
        // 折算为 local handler 型 AppAction：run 调用贡献的执行面（§2.3）。
        // local → 直接调 handler；send/fill/skill → 经聊天面板的命令执行面
        //（executeCommand 四型全语义：清输入/聚焦/发文本）。
        if (contribution.action.type === 'local') {
          contribution.action.handler();
          return;
        }
        const panel = shellRefs.chatPanel;
        if (panel) {
          panel.executeCommand(contribution as unknown as CommandDef);
        } else {
          console.warn('[palette] 无聊天面板承接命令贡献（send/fill/skill 型）:', contribution.id);
        }
      },
    });
  }
  return out;
}

export function CommandPalette() {
  const open = useShellStore((s) => s.paletteOpen);
  const setOpen = useShellStore((s) => s.setPaletteOpen);
  const commandsTick = usePanelDefsStore((s) => s.commandsTick);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0); // 动作在 init 期间注入 — 打开时重取列表
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  void commandsTick; // 贡献变更信号——长驻打开态也重取清单（S4-1.5）

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTick((t) => t + 1);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // 点击面板外关闭（document 级监听，静态元素上不挂交互处理器）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);

  const rows = useMemo(() => {
    void tick;
    void commandsTick;
    const q = query.trim().toLowerCase();
    return [...listActions(), ...commandContributionActions()].filter((a) => !q || a.label.toLowerCase().includes(q));
  }, [query, tick, commandsTick]);

  if (!open) return null;

  const run = (a: AppAction | undefined) => {
    setOpen(false);
    a?.run();
  };

  const groups: Array<{ g: string; items: Array<{ a: AppAction; idx: number }> }> = [];
  rows.forEach((a, idx) => {
    let g = groups[groups.length - 1];
    if (!g || g.g !== a.group) {
      g = { g: a.group, items: [] };
      groups.push(g);
    }
    g.items.push({ a, idx });
  });

  return (
    <div className="pal-veil" role="presentation">
      <div className="pal-box" role="dialog" aria-label="命令面板" ref={boxRef}>
        <div className="pal-input">
          <span className="pal-prompt">❯</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="输入命令、面板或符号名…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((v) => Math.min(v + 1, rows.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((v) => Math.max(v - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(rows[active]);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
        </div>
        <div className="pal-list">
          {rows.length === 0 ? <div className="pal-group">无匹配命令</div> : null}
          {groups.map((g) => (
            <div key={g.g}>
              <div className="pal-group">{g.g}</div>
              {g.items.map(({ a, idx }) => (
                <button
                  key={a.id}
                  type="button"
                  className={`pal-row${idx === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => run(a)}
                >
                  {a.icon ? <Icon name={a.icon} /> : null}
                  <span className="pal-label">{a.label}</span>
                  {a.kbd ? <kbd>{a.kbd}</kbd> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span>esc 关闭</span>
          <span className="pal-foot-right">HOLOGRAM COMMAND</span>
        </div>
      </div>
    </div>
  );
}
