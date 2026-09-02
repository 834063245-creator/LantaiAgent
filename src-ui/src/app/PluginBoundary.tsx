// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/PluginBoundary — 插件渲染面错误边界（保险丝 b，2026-09-03 生产事故立法）。
//
// 起因：产物与 exe 版本偏斜 → 插件贡献的组件渲染期 TypeError → React
// 整树卸载（应用零错误边界，一个插件崩 = 全 UI 死）。装载期有 face 键集
// 对拍（保险丝 a）拒已知偏斜；边界是第二道——任何渲染期崩溃（偏斜 /
// 产物 bug / 插件 bug）只死自己那格，崩溃面可见可重试，宿主永生。
//
// 崩溃面刻意自持内联样式 + var() 回退：边界不得依赖任何可能正在崩溃的
// 样式面（插件 CSS / 面板布局）——它必须是全应用最不可能坏的组件。

import { Component, type ReactNode } from 'react';

interface PluginBoundaryProps {
  /** 崩溃面展示的归属标签（面板 id / 覆盖层 id / 块 kind）。 */
  label: string;
  children: ReactNode;
}

interface PluginBoundaryState {
  err: unknown;
}

export class PluginBoundary extends Component<PluginBoundaryProps, PluginBoundaryState> {
  state: PluginBoundaryState = { err: null };

  static getDerivedStateFromError(err: unknown): PluginBoundaryState {
    return { err };
  }

  componentDidCatch(err: unknown, info: { componentStack?: string | null }): void {
    console.error('[plugin-boundary] 渲染面崩溃:', this.props.label, err, info.componentStack ?? '');
  }

  render(): ReactNode {
    if (this.state.err == null) return this.props.children;
    const msg = this.state.err instanceof Error ? this.state.err.message : String(this.state.err);
    const firstLine = msg.split('\n')[0] ?? '';
    return (
      <div
        style={{
          padding: '12px 16px',
          background: 'var(--paper, #f7f2e5)',
          color: 'var(--ink-1, #26221c)',
          fontFamily: 'var(--f-song, serif)',
          fontSize: 13,
          lineHeight: 1.9,
          borderTop: '2px solid var(--warn, #8a6d1a)',
        }}
      >
        <div style={{ fontWeight: 600 }}>{this.props.label} 渲染崩溃</div>
        <div style={{ fontSize: 12, color: 'var(--ink-2, rgba(38,34,28,0.7))', wordBreak: 'break-all' }}>
          {firstLine}
        </div>
        <button
          type="button"
          onClick={() => this.setState({ err: null })}
          style={{
            marginTop: 6,
            padding: '2px 12px',
            fontFamily: 'inherit',
            fontSize: 12,
            background: 'transparent',
            color: 'var(--seal, #a03c2e)',
            border: 'none',
            borderTop: '2px solid currentColor',
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </div>
    );
  }
}
