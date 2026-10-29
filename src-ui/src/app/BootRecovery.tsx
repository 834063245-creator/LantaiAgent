// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 启动失败面（boot recovery 的视图层，2026-10-29）——见 app/boot-recovery.ts 头注。
//
// ⚡ 两条实现纪律（都来自事故）：
//   ① **零产物依赖**：本组件只许 import 内核模块（store / 字体在 main.ts 已就位）。
//      一旦它依赖某个出厂产物（或产物的 CSS），产物缺席时诊断面自己也白——那正是
//      最需要它的时刻。故样式全部内联，不引任何 panel CSS。
//   ② **可行动**：按钮必须真的能做事（重新加载 / 复制诊断 / 进出安全模式），
//      不能只是「知道了」。重新加载用 location.reload()——WebView 内重跑 main.ts，
//      等价于冷启动且不需要新 RPC。

import { createElement, useState } from 'react';
import type { BootFailure } from './boot-recovery';

export interface BootRecoveryProps {
  failure: BootFailure;
  /** 构建锚（v + commit）——出问题时第一句要能定位到哪份代码。 */
  build: { v: string; commit: string };
  /** 运行时宿主面指纹（与产物 face.json 的 hostApi 对拍用）。 */
  hostSurface: string;
  /** 工作区目录（null = 还没有工作区）。 */
  workspace: string | null;
  /** ui.log 路径（null = 日志通道没起，本次失败可能无落盘记录）。 */
  logPath: string | null;
  /** 测试注入面（缺省 = 真浏览器行为）。 */
  onReload?: () => void;
  onToggleSafeMode?: () => void;
  /** 当前是否已在安全模式（决定按钮文案）。 */
  safeMode?: boolean;
}

const INK = '#2b2620';
const MUTED = '#6b6257';
const PAPER = '#f4efe4';
const RULE = '#c9bfa9';
const ACCENT = '#8c2f20';

/** 诊断文本（复制按钮的载荷；也是用户贴给别人的东西）。 */
export function diagnosticText(props: Omit<BootRecoveryProps, 'onReload' | 'onToggleSafeMode'>): string {
  const { failure, build, hostSurface, workspace, logPath } = props;
  return [
    '兰台启动失败 · ' + failure.kind,
    '构建: v' + build.v + ' (' + build.commit + ')',
    '宿主面: ' + hostSurface,
    '工作区: ' + (workspace ?? '（未知）'),
    '日志: ' + (logPath ?? '（未初始化——本次失败可能没有落盘记录）'),
    '',
    '结论: ' + failure.summary,
    '',
    '证据:',
    ...failure.evidence.map((e) => '  · ' + e),
    '',
    '建议:',
    ...failure.hints.map((h) => '  - ' + h),
  ].join('\n');
}

export function BootRecovery(props: BootRecoveryProps) {
  const { failure, build, hostSurface, workspace, logPath } = props;
  const [copied, setCopied] = useState(false);
  // 诊断载荷每次渲染现算：它是纯字符串拼接（几 KB），比维护依赖表更不容易错
  const text = diagnosticText(props);
  const reload = props.onReload ?? (() => window.location.reload());
  const toggleSafe = props.onToggleSafeMode;

  const copy = () => {
    // 剪贴板在部分 WebView/权限态下不可用——失败就退化成选中文本，不假装成功。
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    })();
  };

  const actions: Array<{ label: string; run: () => void }> = [
    { label: '重新加载界面', run: reload },
    { label: copied ? '已复制诊断信息' : '复制诊断信息', run: copy },
  ];
  if (toggleSafe) {
    actions.push({
      label: props.safeMode ? '退出安全模式并重新加载' : '以安全模式重启',
      run: toggleSafe,
    });
  }

  return createElement(
    'div',
    {
      style: {
        position: 'fixed',
        inset: 0,
        overflow: 'auto',
        background: PAPER,
        color: INK,
        fontFamily: '"Songti SC","Noto Serif CJK SC",serif',
        padding: '48px 56px 64px',
        lineHeight: 1.7,
      },
    },
    createElement('div', { style: { fontSize: 13, letterSpacing: '0.35em', color: MUTED } }, '兰 台 · 启 动 诊 断'),
    createElement(
      'h1',
      { style: { fontSize: 30, margin: '18px 0 6px', fontWeight: 600 } },
      failure.kind === 'safe-mode' ? '已进入安全模式' : '兰台没能完成启动',
    ),
    createElement('p', { style: { fontSize: 16, margin: '0 0 22px', color: ACCENT } }, failure.summary),
    createElement(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '2px 28px',
          padding: '12px 16px',
          borderTop: '1px solid ' + RULE,
          borderBottom: '1px solid ' + RULE,
          fontSize: 13,
          color: MUTED,
          marginBottom: 26,
        },
      },
      createElement('span', null, '版本 v' + build.v + ' · ' + build.commit),
      createElement('span', null, '宿主面 ' + hostSurface),
      createElement('span', null, '工作区 ' + (workspace ?? '（未知）')),
      createElement('span', null, '日志 ' + (logPath ?? '（未初始化）')),
    ),
    createElement('h2', { style: { fontSize: 14, letterSpacing: '0.2em', color: MUTED, margin: '0 0 10px' } }, '证 据'),
    createElement(
      'pre',
      {
        style: {
          margin: '0 0 26px',
          padding: '14px 16px',
          background: '#ebe4d4',
          border: '1px solid ' + RULE,
          fontFamily: '"Cascadia Mono","Noto Sans Mono CJK SC",monospace',
          fontSize: 12.5,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        },
      },
      failure.evidence.join('\n'),
    ),
    createElement(
      'h2',
      { style: { fontSize: 14, letterSpacing: '0.2em', color: MUTED, margin: '0 0 10px' } },
      '怎 么 修',
    ),
    createElement(
      'ol',
      { style: { margin: '0 0 30px', paddingLeft: 22, fontSize: 14.5 } },
      failure.hints.map((h, i) => createElement('li', { key: i, style: { marginBottom: 6 } }, h)),
    ),
    createElement(
      'div',
      { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
      actions.map((a) =>
        createElement(
          'button',
          {
            key: a.label,
            type: 'button',
            onClick: a.run,
            style: {
              padding: '9px 18px',
              background: '#efe6d2',
              color: INK,
              border: '1px solid ' + RULE,
              borderRadius: 2,
              fontSize: 14,
              fontFamily: 'inherit',
              cursor: 'pointer',
            },
          },
          a.label,
        ),
      ),
    ),
    createElement(
      'p',
      { style: { marginTop: 26, fontSize: 12.5, color: MUTED, maxWidth: 720 } },
      '这张诊断面由内核渲染——它不依赖任何出厂产物，所以产物全灭时它也出得来。' +
        '同一份信息已在日志里（若日志通道已起）；复制按钮拿到的就是它。',
    ),
  );
}
