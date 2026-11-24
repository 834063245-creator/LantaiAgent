// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 文卷窗内编辑器依赖的唯一入口——由 vendor.mjs 打成 app/vendor/lantai-editor.js。
//
// 为什么要有这一层：窗内容是 opaque origin 的自包含 HTML，没有包管理器、没有
// import map、拿不到宿主 node_modules。CodeMirror / markdown-it 这类重依赖只能
// 预构建成单文件 ESM 随插件提交，窗内 `import './vendor/lantai-editor.js'`。
//
// 产物只导出两个面：
//   createEditor(...)  编辑器适配层（宿主/文档逻辑对它零知识）
//   renderMarkdown(t)  预览渲染（markdown-it + GFM 插件 + DOMPurify + highlight.js）
// 其余 CM6 细节全部封在文件内——换内核只改这一个文件，窗内逻辑不动。

import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { StreamLanguage } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { javascript as javascriptLang } from '@codemirror/lang-javascript';
import { json as jsonLang } from '@codemirror/lang-json';
import { python as pythonLang } from '@codemirror/lang-python';
import { rust as rustLang } from '@codemirror/lang-rust';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { shell as shellMode } from '@codemirror/legacy-modes/mode/shell';
import { yaml as yamlMode } from '@codemirror/legacy-modes/mode/yaml';
import { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { c as cMode, cpp as cppMode, java as javaMode, csharp as csharpMode, kotlin as kotlinMode, dart as dartMode } from '@codemirror/legacy-modes/mode/clike';
import { go as goMode } from '@codemirror/legacy-modes/mode/go';
import { dockerFile as dockerMode } from '@codemirror/legacy-modes/mode/dockerfile';
import { powerShell as powershellMode } from '@codemirror/legacy-modes/mode/powershell';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import footnote from 'markdown-it-footnote';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGS = {
  bash,
  c,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  markdown: markdownLang,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['md'], { languageName: 'markdown' });

const ALIAS = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
};

/** 代码语言 → CM 语言扩展。未知语言返回空数组（纯文本编辑，不丢内容）。 */
const LANGUAGE_PACKS = {
  markdown: () => markdown(),
  javascript: () => javascriptLang(),
  jsx: () => javascriptLang({ jsx: true }),
  typescript: () => javascriptLang({ typescript: true }),
  tsx: () => javascriptLang({ jsx: true, typescript: true }),
  json: () => jsonLang(),
  python: () => pythonLang(),
  rust: () => rustLang(),
  html: () => htmlLang(),
  css: () => cssLang(),
  shell: () => StreamLanguage.define(shellMode),
  yaml: () => StreamLanguage.define(yamlMode),
  toml: () => StreamLanguage.define(tomlMode),
  sql: () => StreamLanguage.define(standardSQL),
  c: () => StreamLanguage.define(cMode),
  cpp: () => StreamLanguage.define(cppMode),
  java: () => StreamLanguage.define(javaMode),
  csharp: () => StreamLanguage.define(csharpMode),
  kotlin: () => StreamLanguage.define(kotlinMode),
  dart: () => StreamLanguage.define(dartMode),
  go: () => StreamLanguage.define(goMode),
  dockerfile: () => StreamLanguage.define(dockerMode),
  powershell: () => StreamLanguage.define(powershellMode),
};

function languageExtension(name) {
  const make = LANGUAGE_PACKS[String(name ?? '').toLowerCase()];
  return make ? make() : [];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

/* ── 编辑器主题：纸面。变量由窗内 app.css 定义，这里只引用，不复制色值。 ── */
const paperTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--ink)',
      backgroundColor: 'transparent',
      fontSize: 'var(--editor-size, 13.5px)',
    },
    '.cm-scroller': {
      fontFamily: 'var(--mono)',
      lineHeight: '1.85',
      overflow: 'auto',
    },
    '.cm-content': {
      padding: '18px 0 46px',
      caretColor: 'var(--accent)',
    },
    '.cm-line': { padding: '0 18px 0 6px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--ink-faint)',
      border: 'none',
      paddingRight: '2px',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 12px', minWidth: '30px' },
    '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--selection)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-panels': {
      backgroundColor: 'var(--paper-deep)',
      color: 'var(--ink)',
      borderColor: 'var(--line)',
    },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
    '.cm-search': {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 10px',
      fontFamily: 'var(--ui)',
      fontSize: '12px',
    },
    '.cm-search label': { color: 'var(--ink-soft)', display: 'inline-flex', alignItems: 'center', gap: '3px' },
    '.cm-search input, .cm-search button': {
      fontFamily: 'var(--ui)',
      fontSize: '12px',
      color: 'var(--ink)',
      backgroundColor: 'var(--paper)',
      border: '1px solid var(--line)',
      borderRadius: '4px',
      padding: '2px 6px',
    },
    '.cm-search button': { cursor: 'pointer' },
    '.cm-search button:hover': { borderColor: 'var(--ink-soft)' },
    '.cm-search .cm-button': { backgroundImage: 'none' },
    '.cm-searchMatch': { backgroundColor: 'var(--match)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--match-on)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--match-soft)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--paper)',
      color: 'var(--ink)',
      border: '1px solid var(--line)',
      borderRadius: '6px',
      boxShadow: 'var(--shadow)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--paper-deep)',
      color: 'var(--ink-soft)',
      border: '1px solid var(--line)',
      borderRadius: '3px',
    },
    '.cm-matchingBracket': { backgroundColor: 'var(--match)', outline: 'none' },
  },
  { dark: false },
);

/**
 * 创建编辑器实例（窗内唯一适配点）。
 * @param {{
 *   parent: HTMLElement,
 *   doc?: string,
 *   language?: string,
 *   readOnly?: boolean,
 *   onChange?: (text: string) => void,
 *   onCursor?: (pos: { line: number, col: number }) => void,
 *   onSave?: () => void,
 *   onCloseTab?: () => void,
 *   onToggleMode?: () => void,
 * }} opts
 */
export function createEditor(opts) {
  const parent = opts.parent;
  const readOnly = new Compartment();
  const language = new Compartment();
  let applying = false;

  const saveKey = {
    key: 'Mod-s',
    preventDefault: true,
    run: () => {
      opts.onSave?.();
      return true;
    },
  };
  const closeKey = {
    key: 'Mod-w',
    preventDefault: true,
    run: () => {
      opts.onCloseTab?.();
      return true;
    },
  };
  const modeKey = {
    key: 'Mod-e',
    preventDefault: true,
    run: () => {
      opts.onToggleMode?.();
      return true;
    },
  };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc ?? '',
      extensions: [
        basicSetup,
        language.of(languageExtension(opts.language ?? 'markdown')),
        EditorView.lineWrapping,
        paperTheme,
        readOnly.of(EditorState.readOnly.of(opts.readOnly === true)),
        Prec.high(keymap.of([saveKey, closeKey, modeKey])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applying) opts.onChange?.(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) opts.onCursor?.(cursorOf(update.state));
        }),
      ],
    }),
  });

  function cursorOf(state) {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1 };
  }

  return {
    getText: () => view.state.doc.toString(),
    setText(text) {
      const next = String(text ?? '');
      if (next === view.state.doc.toString()) return;
      applying = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          selection: { anchor: 0 },
          scrollIntoView: false,
        });
      } finally {
        applying = false;
      }
    },
    setReadOnly(value) {
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(value === true)) });
    },
    setLanguage(name) {
      view.dispatch({ effects: language.reconfigure(languageExtension(name)) });
    },
    setValueWithoutNotify(text) {
      const next = String(text ?? '');
      if (next === view.state.doc.toString()) return;
      applying = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      } finally {
        applying = false;
      }
    },
    focus: () => view.focus(),
    requestMeasure: () => view.requestMeasure(),
    getCursor: () => cursorOf(view.state),
    setCursor(lineNumber, column = 1) {
      const target = Math.min(Math.max(Number(lineNumber) || 1, 1), view.state.doc.lines);
      const line = view.state.doc.line(target);
      const offset = Math.min(Math.max(Number(column) || 1, 1) - 1, line.length);
      view.dispatch({ selection: { anchor: line.from + offset } });
    },
    lineCount: () => view.state.doc.lines,
    scrollToLine(lineNumber) {
      const target = Math.min(Math.max(Number(lineNumber) || 1, 1), view.state.doc.lines);
      const line = view.state.doc.line(target);
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 24 }),
      });
      view.focus();
    },
    getScrollTop: () => view.scrollDOM.scrollTop,
    setScrollTop(value) {
      view.scrollDOM.scrollTop = Math.max(0, Number(value) || 0);
    },
    destroy: () => view.destroy(),
  };
}

/* ── Markdown 预览 ── */
const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
});
md.use(taskLists, { enabled: false, label: true });
md.use(footnote);

const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = (token.info || '').trim().split(/\s+/)[0];
  const langName = info ? ALIAS[info] || info : '';
  if (langName && hljs.getLanguage(langName)) {
    const highlighted = hljs.highlight(token.content, { language: langName, ignoreIllegals: true }).value;
    return `<pre class="md-code"><code class="hljs language-${escapeAttr(info)}">${highlighted}</code></pre>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

const defaultLinkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet('href') || '';
  token.attrSet('data-href', href);
  token.attrSet('rel', 'noreferrer');
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('class', 'md-ext');
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
    token.attrSet('class', 'md-ext');
  } else {
    token.attrSet('class', 'md-local');
  }
  return defaultLinkOpen ? defaultLinkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

const defaultHeadingOpen = md.renderer.rules.heading_open;
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const line = token.map ? token.map[0] + 1 + (env?.lineOffset || 0) : idx;
  token.attrSet('id', `md-h-${line}`);
  token.attrSet('data-line', String(line));
  return defaultHeadingOpen ? defaultHeadingOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet('src') || '';
  if (/^(https?:|data:)/i.test(src)) return defaultImage(tokens, idx, options, env, self);
  const alt = token.content || src;
  // 相对图片交给窗内 hydrateDocAssets 调宿主 doc.asset；不直接发相对 src（iframe 会 404）。
  return `<img class="md-img-pending" data-doc-src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" title="相对图片：加载中">`;
};

/**
 * 渲染 Markdown 为可插入 DOM 的安全 HTML。
 * @param {string} text
 * @param {number} [lineOffset] 正文前面被剥掉的行数（frontmatter）——标题锚点 id
 *   必须按**原文行号**生成，否则大纲跳转会找不到目标。
 */
export function renderMarkdown(text, lineOffset = 0) {
  const source = String(text ?? '');
  const html = md.render(source, { lineOffset: Number(lineOffset) || 0 });
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-href', 'data-line', 'data-doc-src', 'id'],
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'textarea', 'select'],
    FORBID_ATTR: ['formaction', 'xlink:href'],
  });
}

/** 供窗内做「按语言高亮」之外的单行内联渲染（大纲/状态用不到，留作扩展）。 */
export function version() {
  return 'cm6+md-it/1';
}
