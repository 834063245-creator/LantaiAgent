// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 「引用到的文件点一下」的宿主出口（2026-11-23）——钉两条：
//   · 没有声明 app.documents 的插件 ⇒ false + 状态栏具名提示（不静默）；
//   · 有 ⇒ 开窗并**当场签发令牌**（路径只进宿主令牌表，不进窗）。
//   · 已经开着窗也照样能换页（设施走「重签令牌 + 直接推 doc-open」那条路）。

import { beforeEach, describe, expect, it } from 'vitest';
import { useShellStore } from '../src/app/shell-store';
import { openFileWithPlugin } from '../src/plugins/window-facility';
import { pendingDocumentGrant, resetDocumentGrantsForTests } from '../src/state/plugin-document-store';
import { usePluginWindowStore } from '../src/state/plugin-window-store';

const DEF = {
  pluginName: 'acme/md',
  entryUrl: 'http://127.0.0.1:14570/plugins/acme/md/app/index.html',
  kind: 'asset' as const,
  mode: 'floating' as const,
  title: '文卷',
  documents: true,
};

beforeEach(() => {
  resetDocumentGrantsForTests();
  usePluginWindowStore.getState().resetPluginWindowsForTests();
  useShellStore.getState().setProjectPath('');
});

describe('openFileWithPlugin：会话文件引用的宿主出口', () => {
  it('没有文档能力插件 → false（不静默：状态栏有具名提示）', () => {
    expect(openFileWithPlugin('/work/docs/a.md')).toBe(false);
    expect(usePluginWindowStore.getState().windows).toHaveLength(0);
  });

  it('有文档能力插件 → 开窗并签发令牌（路径只在令牌表里）', () => {
    usePluginWindowStore.getState().registerAppDef(DEF);
    expect(openFileWithPlugin('/work/docs/a.md')).toBe(true);
    const win = usePluginWindowStore.getState().windows[0];
    expect(win.pluginName).toBe('acme/md');
    const grant = pendingDocumentGrant(win.windowId);
    expect(grant).not.toBeNull();
    expect(grant?.path).toBe('/work/docs/a.md');
  });

  it('相对路径按工作区根解析后再进令牌表（Rust 只收绝对路径）', () => {
    useShellStore.getState().setProjectPath('D:/ws');
    usePluginWindowStore.getState().registerAppDef(DEF);
    expect(openFileWithPlugin('docs/README.md')).toBe(true);
    const win = usePluginWindowStore.getState().windows[0];
    expect(pendingDocumentGrant(win.windowId)?.path).toBe('D:/ws/docs/README.md');
  });

  it('窗已开着再点另一份 → 仍 true，令牌换成新路径（换页不重开窗）', () => {
    usePluginWindowStore.getState().registerAppDef(DEF);
    expect(openFileWithPlugin('/work/docs/a.md')).toBe(true);
    const first = usePluginWindowStore.getState().windows[0];
    expect(openFileWithPlugin('/work/docs/b.md')).toBe(true);
    const windows = usePluginWindowStore.getState().windows;
    expect(windows).toHaveLength(1);
    expect(pendingDocumentGrant(windows[0].windowId)?.path).toBe('/work/docs/b.md');
    expect(windows[0].windowId).toBe(first.windowId);
  });
});
