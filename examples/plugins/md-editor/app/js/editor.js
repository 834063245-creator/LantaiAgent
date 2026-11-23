// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 编辑器适配层：窗内唯一知道 CodeMirror 的地方。
// 换内核（Monaco / 原生）只改 vendor 与这一层；main.js 的文档/草稿/桥逻辑不动。

import { createEditor, renderMarkdown, version } from '../vendor/lantai-editor.js';

export { renderMarkdown, version };

/**
 * @param {HTMLElement} parent
 * @param {{
 *   doc?: string, readOnly?: boolean,
 *   onChange?: (text: string) => void,
 *   onCursor?: (pos: { line: number, col: number }) => void,
 *   onSave?: () => void, onCloseTab?: () => void, onToggleMode?: () => void,
 * }} options
 */
export function mountEditor(parent, options) {
  return createEditor({ parent, ...options });
}
