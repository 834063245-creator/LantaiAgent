// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 文卷窗内主程序——文档面 / 卷库 / 草稿 / 桥事件 / 渲染。
//
// 分层：
//   bridge.js   宿主 postMessage 白名单桥（协议层）
//   editor.js   CodeMirror 适配（唯一知道内核的地方）
//   pure.js     无 DOM 的纯函数（单测覆盖）
//   main.js     文档模型 + UI 编排（本文件）
//
// 关键语义（与宿主文档通道对齐）：
//   · 宿主文档一次只有一枚令牌（宿主 v1 一窗一文档）；换页时旧令牌失效，
//     旧标签保留正文但标记 stale，保存按钮关闭——不假装还能写。
//   · 自家文档（卷库）直接 fs.write；宿主文档保存走 doc.save 改稿单。
//   · 每次改动先落草稿（drafts/），Ctrl+S 才是「定稿」；关窗不丢正文。

import { createBridge } from './bridge.js';
import { mountEditor, renderMarkdown } from './editor.js';
import {
  basename,
  countText,
  dirname,
  draftFileName,
  extractOutline,
  fuzzyScore,
  hashText,
  isDocumentName,
  isSafeRelPath,
  normalizeDocName,
  relativeTime,
  resolveLocalHref,
  splitFrontmatter,
} from './pure.js';

const DRAFTS_DIR = 'drafts';
const STATE_FILE = 'state.json';
const PREVIEW_LIMIT = 320_000;
const MAX_TABS = 16;
const MAX_RECENT = 30;
/** 工作区树默认不展开的构建/依赖目录（宿主 list_flat 只跳 VCS，不跳这些）。 */
const HIDDEN_WORKSPACE_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
]);
const TEXT_BRIDGE_FALLBACK = '宿主桥未就绪——文卷需在兰台宿主内打开';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  docKind: $('doc-kind'),
  docTitle: $('doc-title'),
  btnSidebar: $('btn-sidebar'),
  btnOutlineToggle: $('btn-outline-toggle'),
  btnMode: $('btn-mode'),
  btnSplit: $('btn-split'),
  btnSave: $('btn-save'),
  btnTheme: $('btn-theme'),
  btnPalette: $('btn-palette'),
  btnNew: $('btn-new'),
  sideBody: $('side-body'),
  sideFoot: $('side-foot'),
  filter: $('filter'),
  tabbar: $('tabbar'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerActions: $('banner-actions'),
  editorHost: $('editor-host'),
  previewHost: $('preview-host'),
  emptyHint: $('empty-hint'),
  emptyNew: $('empty-new'),
  emptyPalette: $('empty-palette'),
  statusLeft: $('status-left'),
  statusCount: $('status-count'),
  statusSave: $('status-save'),
  statusBridge: $('status-bridge'),
  outlineBody: $('outline-body'),
  btnOutline: $('btn-outline'),
  palette: $('palette'),
  paletteMark: $('palette-mark'),
  paletteInput: $('palette-input'),
  paletteList: $('palette-list'),
  paletteFoot: $('palette-foot'),
  modal: $('modal'),
  modalTitle: $('modal-title'),
  modalDesc: $('modal-desc'),
  modalInput: $('modal-input'),
  modalError: $('modal-error'),
  modalCancel: $('modal-cancel'),
  modalOk: $('modal-ok'),
  toastHost: $('toast-host'),
  sideResizer: $('side-resizer'),
  outlineResizer: $('outline-resizer'),
};

const bridge = createBridge();
let editor = null;
/** 宿主连点两份文件时串行开稿——并发读会让「谁是新令牌」难判。 */
let hostOpenChain = Promise.resolve();

const state = {
  bridgeReady: false,
  booted: false,
  tabs: [],
  activeId: null,
  side: 'files',
  sidebarOpen: true,
  outlineOpen: true,
  sidebarWidth: 236,
  outlineWidth: 220,
  theme: 'paper',
  localFiles: [],
  recent: [],
  drafts: new Map(),
  workspace: {
    rootToken: null,
    rootPath: '',
    nodes: new Map(),
    expanded: new Set(['']),
    sessionFiles: [],
    error: '',
  },
  outline: [],
  outlineActiveLine: 0,
  filter: '',
  banner: null,
  palette: {
    open: false,
    mode: 'files',
    query: '',
    index: 0,
    items: [],
    searchHits: [],
    searching: false,
    searchSeq: 0,
    searchTimer: null,
  },
  modal: null,
  pendingHostOpen: null,
  persistedTabs: [],
  persistedActive: null,
  previewTimer: 0,
  outlineTimer: 0,
  countTimer: 0,
  stateTimer: 0,
  draftTimers: new Map(),
  lastCheckAt: 0,
  lastWriteAt: 0,
};

/* ── 小工具 ── */

function textOf(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    if (typeof raw.text === 'string') return raw.text;
    if (typeof raw.content === 'string') return raw.content;
  }
  return '';
}

function activeTab() {
  if (!state.activeId) return null;
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null;
}

function tabById(id) {
  return state.tabs.find((tab) => tab.id === id) ?? null;
}

function draftKey(kind, path) {
  return `${kind}\u0000${path}`;
}

function viewHasPreview(tab) {
  return tab?.view === 'read' || tab?.view === 'split';
}

function viewHasEditor(tab) {
  return tab?.view === 'edit' || tab?.view === 'split';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function showToast(text, kind = 'info', duration = 2600) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = text;
  el.toastHost.append(node);
  while (el.toastHost.children.length > 4) el.toastHost.firstElementChild.remove();
  setTimeout(() => node.remove(), duration);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

/* ── 标签模型 ── */

function makeTab({ kind, path, name, text, view, docToken = null }) {
  return {
    id: `${kind}:${path}`,
    kind,
    path,
    name: name || basename(path),
    text,
    savedText: text,
    savedHash: hashText(text),
    dirty: false,
    view: view || (kind === 'host' ? 'read' : 'edit'),
    scroll: 0,
    cursor: { line: 1, col: 1 },
    docToken,
    reviewId: null,
    savedSnapshot: null,
    rev: null,
    workspace: false,
    rootToken: null,
    pending: false,
    stale: false,
    missing: false,
    restoredDraft: false,
  };
}

function addTab(tab, { activate = true } = {}) {
  const existing = tabById(tab.id);
  if (existing) {
    if (activate) activateTab(existing.id);
    return existing;
  }
  state.tabs.push(tab);
  if (state.tabs.length > MAX_TABS) {
    const victim = state.tabs.find((item) => item.id !== tab.id && !item.dirty);
    if (victim) closeTab(victim.id, { silent: true });
  }
  if (activate) activateTab(tab.id);
  else renderAll();
  return tab;
}

function activateTab(id, { focus = false } = {}) {
  const current = activeTab();
  if (current && editor) {
    current.scroll = editor.getScrollTop();
    current.cursor = editor.getCursor();
  }
  state.activeId = id;
  const tab = activeTab();
  if (!tab) {
    if (editor) editor.setText('');
    renderAll();
    return;
  }
  if (editor) {
    editor.setText(tab.text);
    editor.setReadOnly(tab.kind === 'host' && (tab.stale || !tab.docToken));
    editor.setCursor(tab.cursor.line, tab.cursor.col);
    requestAnimationFrame(() => {
      if (activeTab()?.id !== tab.id) return;
      if (viewHasEditor(tab)) editor.requestMeasure();
      editor.setScrollTop(tab.scroll);
      if (focus && viewHasEditor(tab)) editor.focus();
    });
  }
  renderAll();
  if (viewHasPreview(tab)) schedulePreview(0);
  if (tab.restoredDraft) {
    tab.restoredDraft = false;
    showBanner('已恢复上次未保存的草稿。Ctrl/Cmd+S 才会写回磁盘。', [
      { label: '知道了', run: clearBanner },
    ]);
  } else if (tab.stale) {
    showBanner('这份宿主文档的令牌已被另一份替换——正文还在，保存已关闭。需要保留就复制正文另存。', [
      { label: '知道了', run: clearBanner },
    ]);
  }
}

function closeTab(id, { silent = false } = {}) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const tab = state.tabs[index];
  if (tab.pending) {
    showToast('这份文档有改稿单待宿主确认，暂时不能关这个标签', 'info', 3600);
    return;
  }
  if (tab.dirty) flushDraft(tab);
  state.tabs.splice(index, 1);
  if (state.activeId === id) {
    const next = state.tabs[index] ?? state.tabs[index - 1] ?? null;
    state.activeId = next ? next.id : null;
    if (next) activateTab(next.id);
    else {
      if (editor) editor.setText('');
      renderAll();
    }
  } else {
    renderAll();
  }
  if (tab.dirty && !silent) showToast('未保存改动已留在草稿里，重开可恢复', 'info', 3200);
  schedulePersist();
}

/* ── 文档打开 ── */

async function refreshLocalFiles({ silent = false } = {}) {
  if (!state.bridgeReady) return [];
  try {
    const raw = await bridge.call('fs.list', { path: '' });
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    const docs = entries
      .filter((entry) => entry && !entry.is_dir && isDocumentName(entry.name))
      .map((entry) => ({ name: entry.name, path: entry.name, size: entry.size ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    state.localFiles = docs;
    for (const tab of state.tabs) {
      if (tab.kind !== 'local') continue;
      tab.missing = !docs.some((doc) => doc.path === tab.path);
    }
    if (!silent) renderSidebar();
    renderSideFoot();
    return docs;
  } catch (error) {
    if (!silent) showToast(`卷库读取失败：${error.message}`, 'err', 4200);
    return [];
  }
}

async function loadDrafts() {
  state.drafts.clear();
  if (!state.bridgeReady) return;
  let entries = [];
  try {
    const raw = await bridge.call('fs.list', { path: DRAFTS_DIR });
    entries = Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return; // 首次运行没有 drafts/ 目录——不是错误
  }
  const files = entries.filter((entry) => entry && !entry.is_dir && entry.name.endsWith('.json')).slice(0, 200);
  for (const entry of files) {
    try {
      const raw = await bridge.call('fs.read', { path: `${DRAFTS_DIR}/${entry.name}` });
      const parsed = JSON.parse(textOf(raw));
      if (!parsed || typeof parsed.path !== 'string' || typeof parsed.text !== 'string') continue;
      if (parsed.kind !== 'local' && parsed.kind !== 'host') continue;
      state.drafts.set(draftKey(parsed.kind, parsed.path), parsed);
    } catch (error) {
      console.warn('[wenjuan] 草稿读取失败', entry.name, error);
    }
  }
}

function applyDraft(tab) {
  const draft = state.drafts.get(draftKey(tab.kind, tab.path));
  if (!draft || typeof draft.text !== 'string') return false;
  if (draft.text === tab.savedText) return false;
  tab.text = draft.text;
  tab.dirty = true;
  tab.restoredDraft = true;
  return true;
}

/* ── 工作区（P1）── */

function syncSideTabs() {
  for (const tab of document.querySelectorAll('.side-tab')) {
    const on = tab.dataset.side === state.side;
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', String(on));
  }
}

function workspaceNode(relPath) {
  return state.workspace.nodes.get(relPath) ?? null;
}

async function onWorkspaceOpen(payload) {
  const rootToken = String(payload?.rootToken ?? '');
  if (!rootToken) return;
  const rootPath = String(payload?.rootPath ?? '');
  const changed = state.workspace.rootToken !== rootToken;
  state.workspace.rootToken = rootToken;
  state.workspace.rootPath = rootPath;
  state.workspace.sessionFiles = Array.isArray(payload?.sessionFiles)
    ? payload.sessionFiles.filter((rel) => typeof rel === 'string')
    : [];
  if (changed) {
    state.workspace.nodes.clear();
    state.workspace.expanded = new Set(['']);
    state.workspace.error = '';
    // 换根 = 旧根下签发的文档令牌全部作废（宿主侧已回收）；旧标签留正文但关闭保存。
    for (const tab of state.tabs) {
      if (tab.kind === 'host' && tab.workspace) {
        tab.docToken = null;
        tab.stale = true;
      }
    }
    state.workspace.nodes.set('', {
      relPath: '',
      name: basename(rootPath) || '工作区',
      is_dir: true,
      size: 0,
      loaded: false,
      loading: false,
      children: [],
      error: '',
    });
    if (state.side === 'files') state.side = 'workspace';
  }
  syncSideTabs();
  renderSidebar();
  await loadWorkspaceDir('');
}

async function loadWorkspaceDir(relPath) {
  const rootToken = state.workspace.rootToken;
  if (!rootToken) return;
  const node = workspaceNode(relPath);
  if (!node || node.loading) return;
  node.loading = true;
  node.error = '';
  if (relPath === '') state.workspace.error = '';
  if (state.side === 'workspace') renderSidebar();
  try {
    const raw = await bridge.call('ws.list', { rootToken, relPath });
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    const children = [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string') continue;
      // 点文件默认隐藏（与 DSH 一致）；构建/依赖目录不展开（P1 不做显隐开关）
      if (entry.name.startsWith('.')) continue;
      if (entry.is_dir === true && HIDDEN_WORKSPACE_DIRS.has(entry.name.toLowerCase())) continue;
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      let child = state.workspace.nodes.get(childRel);
      if (!child) {
        child = {
          relPath: childRel,
          name: entry.name,
          is_dir: entry.is_dir === true,
          size: Number(entry.size) || 0,
          loaded: false,
          loading: false,
          children: [],
          error: '',
        };
        state.workspace.nodes.set(childRel, child);
      } else {
        child.name = entry.name;
        child.is_dir = entry.is_dir === true;
        child.size = Number(entry.size) || 0;
      }
      children.push(childRel);
    }
    node.children = children;
    node.loaded = true;
    node.loading = false;
  } catch (error) {
    node.loading = false;
    node.error = String(error.message || error);
    if (relPath === '') state.workspace.error = node.error;
    showToast(`工作区读取失败：${error.message}`, 'err', 4200);
  }
  if (state.side === 'workspace') renderSidebar();
  renderSideFoot();
}

function toggleWorkspaceDir(relPath) {
  const node = workspaceNode(relPath);
  if (!node || !node.is_dir) return;
  if (state.workspace.expanded.has(relPath)) {
    state.workspace.expanded.delete(relPath);
  } else {
    state.workspace.expanded.add(relPath);
    if (!node.loaded && !node.loading) void loadWorkspaceDir(relPath);
  }
  renderSidebar();
}

function workspaceRows(relPath, depth, out, filter) {
  if (out.length >= 2500) return;
  const node = workspaceNode(relPath);
  if (!node?.loaded) return;
  const children = node.children.map((rel) => workspaceNode(rel)).filter(Boolean);
  children.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  for (const child of children) {
    if (filter) {
      if (!child.is_dir) {
        if (fuzzyScore(filter, child.relPath) < 0) continue;
        out.push({ node: child, depth });
      } else {
        // 目录只有在自身或后代命中时才出现；后代命中时展开显示
        const before = out.length;
        workspaceRows(child.relPath, depth + 1, out, filter);
        if (out.length === before && fuzzyScore(filter, child.relPath) >= 0) {
          out.push({ node: child, depth });
        } else if (out.length > before) {
          out.splice(before, 0, { node: child, depth });
        }
      }
      continue;
    }
    out.push({ node: child, depth });
    if (child.is_dir && state.workspace.expanded.has(child.relPath)) {
      workspaceRows(child.relPath, depth + 1, out, filter);
    }
  }
}

async function openWorkspaceFile(relPath, { line = 0 } = {}) {
  if (!state.workspace.rootToken) {
    showToast('宿主还没有签发工作区根授权', 'err', 3600);
    return;
  }
  if (!isDocumentName(relPath)) {
    showToast('工作区里暂只接 Markdown / 文本文件（非文本文件下一批接系统打开）', 'info', 4200);
    return;
  }
  const existing = state.tabs.find((tab) => tab.kind === 'host' && tab.workspace && tab.path === relPath);
  if (existing) {
    activateTab(existing.id, { focus: true });
    if (line > 0) jumpToDocLine(existing, line);
    return;
  }
  try {
    const raw = await bridge.call('ws.read', { rootToken: state.workspace.rootToken, relPath });
    const text = textOf(raw);
    const tab = makeTab({
      kind: 'host',
      path: relPath,
      name: basename(relPath),
      text,
      view: line > 0 ? 'edit' : 'read',
      docToken: typeof raw?.docToken === 'string' ? raw.docToken : null,
    });
    tab.workspace = true;
    tab.rootToken = state.workspace.rootToken;
    tab.rev = typeof raw?.rev === 'string' ? raw.rev : null;
    if (line > 0) tab.cursor = { line: Math.max(0, line - 1), col: 0 };
    applyDraft(tab);
    addTab(tab, { activate: true });
    touchRecent({ kind: 'workspace', path: relPath, name: tab.name });
    if (line > 0) jumpToDocLine(tab, line);
  } catch (error) {
    showToast(`打开失败：${error.message}`, 'err', 4200);
  }
}

function jumpToDocLine(tab, line) {
  if (!editor) return;
  if (!viewHasEditor(tab)) {
    tab.view = 'edit';
    renderAll();
    schedulePreview(0);
  }
  requestAnimationFrame(() => {
    if (activeTab()?.id !== tab.id) return;
    editor.setCursor(Math.max(0, line - 1), 0);
    editor.scrollToLine(line);
    editor.focus();
    editor.requestMeasure();
  });
}


async function openLocal(path, { activate = true, view = 'edit', silent = false } = {}) {
  if (!isSafeRelPath(path) || !isDocumentName(path)) {
    showToast('文件名不合法（只认数据地盘里的 .md / .txt）', 'err');
    return null;
  }
  const existing = tabById(`local:${path}`);
  if (existing) {
    if (activate) activateTab(existing.id, { focus: viewHasEditor(existing) });
    return existing;
  }
  let text = '';
  try {
    const raw = await bridge.call('fs.read', { path });
    text = textOf(raw);
  } catch (error) {
    showToast(`打开失败：${error.message}`, 'err', 4200);
    return null;
  }
  const tab = makeTab({ kind: 'local', path, name: basename(path), text, view });
  applyDraft(tab);
  addTab(tab, { activate });
  touchRecent({ kind: 'local', path, name: tab.name });
  if (!silent) showToast(`已打开 ${tab.name}`, 'ok', 1500);
  return tab;
}

async function openHostDocument(payload) {
  const docToken = String(payload?.docToken ?? '');
  const path = String(payload?.path ?? '');
  if (!docToken) return;
  const existing = state.tabs.find((tab) => tab.kind === 'host' && tab.path === path);
  if (existing) {
    existing.docToken = docToken;
    existing.stale = false;
    existing.pending = false;
    existing.reviewId = null;
    existing.view = existing.view === 'edit' ? 'edit' : 'read';
    if (!existing.dirty) {
      try {
        const raw = await bridge.call('doc.read', { docToken });
        const text = textOf(raw);
        existing.text = text;
        existing.savedText = text;
        existing.savedHash = hashText(text);
        existing.rev = typeof raw?.rev === 'string' ? raw.rev : null;
        existing.missing = false;
      } catch (error) {
        showToast(`宿主文档读取失败：${error.message}`, 'err', 4200);
      }
    }
    applyDraft(existing);
    if (editor && state.activeId === existing.id) editor.setText(existing.text);
    activateTab(existing.id);
    touchRecent({ kind: 'host', path, name: existing.name });
    return;
  }
  let text = '';
  let realPath = path;
  let rev = null;
  try {
    const raw = await bridge.call('doc.read', { docToken });
    text = textOf(raw);
    if (raw && typeof raw.path === 'string' && raw.path) realPath = raw.path;
    if (raw && typeof raw.rev === 'string') rev = raw.rev;
  } catch (error) {
    showToast(`宿主文档读取失败：${error.message}`, 'err', 4200);
    return;
  }
  const tab = makeTab({
    kind: 'host',
    path: realPath,
    name: basename(realPath),
    text,
    view: 'read',
    docToken,
  });
  tab.rev = rev;
  applyDraft(tab);
  addTab(tab, { activate: true });
  touchRecent({ kind: 'host', path: realPath, name: tab.name });
  renderAll();
  if (viewHasPreview(tab)) schedulePreview(0);
}

async function reloadActive() {
  const tab = activeTab();
  if (!tab) return;
  if (tab.dirty && !window.confirm('放弃未保存改动，从磁盘重新载入？')) return;
  try {
    const raw =
      tab.kind === 'host'
        ? await bridge.call('doc.read', { docToken: tab.docToken })
        : await bridge.call('fs.read', { path: tab.path });
    const text = textOf(raw);
    tab.text = text;
    tab.savedText = text;
    tab.savedHash = hashText(text);
    tab.dirty = false;
    tab.missing = false;
    if (raw && typeof raw === 'object' && typeof raw.rev === 'string') tab.rev = raw.rev;
    await deleteDraft(tab);
    if (editor) editor.setText(text);
    renderAll();
    schedulePreview(0);
    showToast('已从磁盘重新载入', 'ok');
  } catch (error) {
    showToast(`重载失败：${error.message}`, 'err', 4200);
  }
}

/* ── 保存 ── */

async function saveActive() {
  const tab = activeTab();
  if (!tab || !tab.dirty) return;
  if (tab.kind === 'host') {
    if (!tab.docToken || tab.stale) {
      showToast('这份宿主文档的令牌已失效——请从会话里重新点开', 'err', 4200);
      return;
    }
    if (tab.pending) {
      showToast('本窗已有一张待审改稿单，先在宿主里处理它', 'info', 3200);
      return;
    }
    tab.pending = true;
    tab.savedSnapshot = tab.text;
    renderTopbar();
    renderStatus();
    try {
      const params = { docToken: tab.docToken, content: tab.text };
      if (typeof tab.rev === 'string' && tab.rev) params.baseRev = tab.rev;
      const res = await bridge.call('doc.save', params);
      if (res?.status === 'pending-review') {
        tab.reviewId = res.reviewId;
        showToast(`已交改稿单（+${res.added ?? 0} / −${res.removed ?? 0}）——等宿主确认`, 'ok', 4200);
      } else if (res?.status === 'unchanged') {
        tab.savedText = tab.text;
        tab.savedHash = hashText(tab.text);
        tab.dirty = false;
        tab.pending = false;
        await deleteDraft(tab);
        showToast('正文没有变化，未交单', 'info');
      } else if (res?.status === 'conflict') {
        tab.pending = false;
        tab.savedSnapshot = null;
        showBanner(`磁盘上的「${tab.name}」在你编辑期间被改过，改稿单未交。`, [
          {
            label: '用磁盘版',
            run: () => {
              clearBanner();
              void reloadActive();
            },
          },
          { label: '保留我的', run: clearBanner },
        ]);
      } else {
        tab.pending = false;
        showToast('保存回执不认识——未确认写入', 'err', 4200);
      }
    } catch (error) {
      tab.pending = false;
      tab.savedSnapshot = null;
      showToast(`交单失败：${error.message}`, 'err', 4600);
    }
    renderAll();
    return;
  }

  try {
    await bridge.call('fs.write', { path: tab.path, content: tab.text });
    tab.savedText = tab.text;
    tab.savedHash = hashText(tab.text);
    tab.dirty = false;
    tab.missing = false;
    state.lastWriteAt = Date.now();
    await deleteDraft(tab);
    await refreshLocalFiles({ silent: true });
    renderAll();
    schedulePreview(0);
    showToast(`已保存 ${tab.name}`, 'ok', 1600);
  } catch (error) {
    showToast(`保存失败：${error.message}`, 'err', 4600);
  }
}

async function deleteDraft(tab) {
  const key = draftKey(tab.kind, tab.path);
  state.drafts.delete(key);
  if (!state.bridgeReady) return;
  try {
    await bridge.call('fs.delete', { path: `${DRAFTS_DIR}/${draftFileName(tab.kind, tab.path)}` });
  } catch {
    // 草稿本来就不存在 / 已删——不是错误
  }
}

function scheduleDraft(tab) {
  const key = tab.id;
  clearTimeout(state.draftTimers.get(key));
  state.draftTimers.set(
    key,
    setTimeout(() => {
      state.draftTimers.delete(key);
      flushDraft(tab);
    }, 650),
  );
}

function flushDraft(tab) {
  const key = draftKey(tab.kind, tab.path);
  if (!tab.dirty) {
    void deleteDraft(tab);
    return;
  }
  if (!state.bridgeReady) return;
  const payload = {
    version: 1,
    kind: tab.kind,
    path: tab.path,
    name: tab.name,
    text: tab.text,
    savedHash: tab.savedHash,
    updatedAt: Date.now(),
  };
  state.drafts.set(key, payload);
  void bridge
    .call('fs.write', {
      path: `${DRAFTS_DIR}/${draftFileName(tab.kind, tab.path)}`,
      content: JSON.stringify(payload),
    })
    .catch((error) => console.warn('[wenjuan] 草稿落盘失败', error));
}

function flushAllDrafts() {
  for (const tab of state.tabs) {
    if (tab.dirty) flushDraft(tab);
  }
}

/* ── 宿主事件 ── */

function onDocSaved(payload) {
  const tab =
    state.tabs.find((item) => item.reviewId && item.reviewId === payload?.reviewId) ??
    state.tabs.find((item) => item.kind === 'host' && item.path === payload?.path);
  if (!tab) {
    showToast('宿主已写入一份文档（本窗没有对应标签）', 'info', 3000);
    return;
  }
  tab.savedText = tab.savedSnapshot ?? tab.text;
  tab.savedHash = hashText(tab.savedText);
  tab.dirty = tab.text !== tab.savedText;
  tab.pending = false;
  tab.reviewId = null;
  tab.savedSnapshot = null;
  tab.stale = false;
  if (typeof payload?.rev === 'string') tab.rev = payload.rev;
  if (!tab.dirty) void deleteDraft(tab);
  showToast(
    tab.dirty ? `已写入快照；你在审阅期间的改动仍是草稿 · ${tab.name}` : `已写入宿主文档 · ${tab.name}`,
    'ok',
    3000,
  );
  renderAll();
  if (state.activeId === tab.id) schedulePreview(0);
}

function onDocRejected(payload) {
  const tab =
    state.tabs.find((item) => item.reviewId && item.reviewId === payload?.reviewId) ??
    state.tabs.find((item) => item.kind === 'host' && item.path === payload?.path);
  if (tab) {
    tab.pending = false;
    tab.reviewId = null;
    tab.savedSnapshot = null;
  }
  const reason = payload?.reason;
  showToast(reason === 'rejected' ? '改稿单已取消——正文还在窗里' : `写入失败：${reason ?? '未知原因'}`, 'err', 4600);
  renderAll();
}

/* ── 外部变更 ── */

async function checkExternal(force = false) {
  if (!state.bridgeReady) return;
  if (document.hidden && !force) return;
  if (Date.now() - state.lastWriteAt < 2000) return;
  const tab = activeTab();
  if (!tab || tab.pending) return;
  const now = Date.now();
  if (!force && now - state.lastCheckAt < 5000) return;
  state.lastCheckAt = now;
  try {
    const raw =
      tab.kind === 'host'
        ? tab.docToken
          ? await bridge.call('doc.read', { docToken: tab.docToken })
          : null
        : await bridge.call('fs.read', { path: tab.path });
    if (!raw) return;
    const text = textOf(raw);
    if (hashText(text) === tab.savedHash) return;
    if (!tab.dirty) {
      tab.text = text;
      tab.savedText = text;
      tab.savedHash = hashText(text);
      tab.missing = false;
      if (raw && typeof raw === 'object' && typeof raw.rev === 'string') tab.rev = raw.rev;
      if (editor && state.activeId === tab.id) editor.setText(text);
      renderAll();
      schedulePreview(0);
      showToast('磁盘上的内容已更新，窗里已同步', 'ok', 2400);
      return;
    }
    showBanner(`磁盘上的「${tab.name}」已变更，你的草稿还在。`, [
      {
        label: '用磁盘版',
        run: () => {
          void (async () => {
            tab.text = text;
            tab.savedText = text;
            tab.savedHash = hashText(text);
            tab.dirty = false;
            if (raw && typeof raw === 'object' && typeof raw.rev === 'string') tab.rev = raw.rev;
            await deleteDraft(tab);
            if (editor) editor.setText(text);
            clearBanner();
            renderAll();
            schedulePreview(0);
            showToast('已换成磁盘版', 'info');
          })();
        },
      },
      {
        label: '保留我的',
        run: () => {
          clearBanner();
          showToast('保留窗内正文；下一次保存会覆盖磁盘版', 'info', 3600);
        },
      },
    ]);
  } catch {
    // 文件被删/令牌失效：静默；用户下一次操作会看到具名错误
  }
}

/* ── 预览 ── */

function schedulePreview(delay = 160) {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(() => renderPreview(), delay);
}

function renderPreview() {
  const tab = activeTab();
  if (!tab || !viewHasPreview(tab)) return;
  const scrollRatio = el.previewHost.scrollHeight > 0 ? el.previewHost.scrollTop / el.previewHost.scrollHeight : 0;
  let source = tab.text;
  let notice = '';
  if (source.length > PREVIEW_LIMIT) {
    const cut = source.lastIndexOf('\n', PREVIEW_LIMIT);
    source = source.slice(0, cut > 0 ? cut : PREVIEW_LIMIT);
    notice = `预览已截断（${(PREVIEW_LIMIT / 1000).toFixed(0)}k 字符上限）；编辑与保存不受影响。`;
  }
  const split = splitFrontmatter(source);
  const bodyHtml = bodyForPreview(split.body, split.bodyLineOffset);
  const frag = document.createDocumentFragment();

  if (notice) {
    const node = document.createElement('div');
    node.className = 'preview-note';
    node.textContent = notice;
    frag.append(node);
  }
  if (split.fields.length) {
    const card = document.createElement('div');
    card.className = 'frontmatter';
    const dl = document.createElement('dl');
    for (const field of split.fields) {
      const dt = document.createElement('dt');
      dt.textContent = field.key;
      const dd = document.createElement('dd');
      dd.textContent = field.value;
      dl.append(dt, dd);
    }
    card.append(dl);
    frag.append(card);
  }
  const body = document.createElement('div');
  body.className = 'md-body';
  body.innerHTML = bodyHtml || '<p class="side-empty">（空文档）</p>';
  frag.append(body);
  el.previewHost.replaceChildren(frag);
  hydrateDocAssets(body, tab);
  requestAnimationFrame(() => {
    el.previewHost.scrollTop = scrollRatio * el.previewHost.scrollHeight;
  });
}

/** 相对图片：宿主 `doc.asset` 按当前文档目录解析，回 data URL；本地卷库暂不预览。 */
function hydrateDocAssets(root, tab) {
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('data-doc-src') || img.getAttribute('src') || '';
    if (!src || /^(data:|https?:|blob:)/i.test(src)) continue;
    img.removeAttribute('data-doc-src');
    img.removeAttribute('src');
    img.classList.add('md-img-pending');
    img.title = tab.kind === 'host' ? '正在读取工作区图片…' : '本地卷库图片暂不预览';
    if (tab.kind !== 'host' || !tab.docToken) continue;
    void (async () => {
      try {
        const res = await bridge.call('doc.asset', { docToken: tab.docToken, href: src });
        if (!img.isConnected) return;
        img.src = res.dataUrl;
        img.classList.remove('md-img-pending');
        img.title = '';
      } catch (error) {
        img.classList.remove('md-img-pending');
        img.classList.add('md-img-error');
        img.title = `图片读取失败：${error.message}`;
      }
    })();
  }
}

function bodyForPreview(body, lineOffset = 0) {
  try {
    return renderMarkdown(body, lineOffset);
  } catch (error) {
    console.error('[wenjuan] 预览渲染失败', error);
    return `<p class="preview-note">预览渲染失败：${escapeHtml(error.message)}</p>`;
  }
}

function onPreviewClick(event) {
  const anchor = event.target.closest?.('a');
  if (!anchor) return;
  const href = anchor.getAttribute('data-href') || anchor.getAttribute('href') || '';
  if (!href) return;
  event.preventDefault();
  const tab = activeTab();
  if (!tab) return;
  if (href.startsWith('#')) {
    const target = el.previewHost.querySelector(href);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
    void copyText(href).then((ok) => {
      showToast(ok ? '外部链接已复制（窗口沙箱不直接开浏览器）' : `外部链接：${href}`, 'info', 4200);
    });
    return;
  }
  if (tab.kind === 'host') {
    if (!tab.docToken) {
      showToast('这份宿主文档的令牌已失效，无法跟随相对链接', 'info', 3200);
      return;
    }
    void (async () => {
      try {
        const followed = await bridge.call('doc.follow', { docToken: tab.docToken, href });
        if (!isDocumentName(followed.relPath)) {
          showToast(`相对链接指向非文档文件：${followed.relPath}`, 'info', 3600);
          return;
        }
        await openWorkspaceFile(followed.relPath, { line: 0 });
      } catch (error) {
        showToast(`链接打开失败：${error.message}`, 'err', 4200);
      }
    })();
    return;
  }
  const resolved = resolveLocalHref(href, tab.path);
  if (!resolved) {
    showToast('这个链接不在当前文档的数据地盘内', 'info', 3200);
    return;
  }
  if (resolved.external) {
    void copyText(href).then((ok) => {
      showToast(ok ? '外部链接已复制（窗口沙箱不直接开浏览器）' : `外部链接：${href}`, 'info', 4200);
    });
    return;
  }
  if (isDocumentName(resolved.path)) {
    void openLocal(resolved.path);
  } else {
    showToast(`非文档文件：${resolved.path}（下一批接系统打开）`, 'info', 3600);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ── 大纲 ── */

function scheduleOutline() {
  clearTimeout(state.outlineTimer);
  state.outlineTimer = setTimeout(renderOutline, 220);
}

function renderOutline() {
  const tab = activeTab();
  const items = tab ? extractOutline(tab.text) : [];
  state.outline = items;
  const frag = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'outline-empty';
    empty.textContent = tab ? '这份文档还没有标题' : '打开文档后显示标题';
    frag.append(empty);
  } else {
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'outline-item';
      button.dataset.line = String(item.line);
      button.dataset.level = String(item.level);
      button.style.setProperty('--lvl', String(item.level));
      button.textContent = item.text || '（无标题）';
      button.title = item.text;
      frag.append(button);
    }
  }
  el.outlineBody.replaceChildren(frag);
  updateOutlineActive(tab?.cursor?.line ?? 0);
}

function updateOutlineActive(line) {
  state.outlineActiveLine = line;
  let active = null;
  for (const item of state.outline) {
    if (item.line <= line) active = item;
    else break;
  }
  for (const button of el.outlineBody.querySelectorAll('.outline-item')) {
    button.classList.toggle('on', active != null && Number(button.dataset.line) === active.line);
  }
}

function jumpToLine(line) {
  const tab = activeTab();
  if (!tab) return;
  if (viewHasPreview(tab)) {
    const target = el.previewHost.querySelector(`#md-h-${line}`);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  if (viewHasEditor(tab) && editor) editor.scrollToLine(line);
}

/* ── 侧栏 ── */

function renderSidebar() {
  syncSideTabs();
  const frag = document.createDocumentFragment();
  if (state.side === 'workspace') {
    const ws = state.workspace;
    if (!ws.rootToken) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      empty.innerHTML = '宿主没有签发工作区根。<br>打开一份宿主文档后再看这里。';
      frag.append(empty);
    } else {
      const root = workspaceNode('');
      const errorText = ws.error || root?.error;
      if (errorText) {
        const empty = document.createElement('div');
        empty.className = 'side-empty';
        empty.textContent = `工作区读取失败：${errorText}`;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'tb-btn';
        retry.textContent = '重试';
        retry.addEventListener('click', () => void loadWorkspaceDir(''));
        empty.append(document.createElement('br'), retry);
        frag.append(empty);
      } else if (!root?.loaded) {
        const empty = document.createElement('div');
        empty.className = 'side-empty';
        empty.textContent = '正在读取工作区…';
        frag.append(empty);
      } else {
        const query = state.filter.trim();
        const refs = state.workspace.sessionFiles.filter((rel) => isDocumentName(rel)).slice(0, 12);
        if (refs.length) {
          const title = document.createElement('div');
          title.className = 'side-section';
          title.textContent = '本卷引用';
          frag.append(title);
          for (const rel of refs) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tree-row';
            button.dataset.rel = rel;
            button.dataset.dir = '0';
            button.style.setProperty('--depth', '0');
            if (state.activeId === `host:${rel}` && activeTab()?.workspace) button.classList.add('on');
            const caret = document.createElement('span');
            caret.className = 'tree-caret';
            caret.textContent = '·';
            const name = document.createElement('span');
            name.className = 'tree-name';
            name.textContent = rel;
            button.append(caret, name);
            button.title = `本卷引用 · ${rel}`;
            frag.append(button);
          }
        }
        const rows = [];
        workspaceRows('', 0, rows, query);
        if (!rows.length) {
          const empty = document.createElement('div');
          empty.className = 'side-empty';
          empty.textContent = query ? '没有匹配的工作区文件。' : '工作区里没有可显示的文本文件。';
          frag.append(empty);
        } else {
          for (const row of rows) {
            const node = row.node;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tree-row';
            button.dataset.rel = node.relPath;
            button.dataset.dir = node.is_dir ? '1' : '0';
            button.style.setProperty('--depth', String(row.depth));
            if (node.is_dir) {
              button.setAttribute('aria-expanded', String(state.workspace.expanded.has(node.relPath)));
            }
            if (
              state.activeId === `host:${node.relPath}` &&
              activeTab()?.kind === 'host' &&
              activeTab()?.workspace
            ) {
              button.classList.add('on');
            }
            const caret = document.createElement('span');
            caret.className = 'tree-caret';
            caret.textContent = node.is_dir ? (state.workspace.expanded.has(node.relPath) ? '▾' : '▸') : '·';
            const name = document.createElement('span');
            name.className = 'tree-name';
            name.textContent = node.name;
            button.append(caret, name);
            button.title = node.relPath || node.name;
            frag.append(button);
          }
        }
      }
    }
  } else if (state.side === 'files') {
    const query = state.filter.trim();
    let docs = state.localFiles;
    if (query) {
      docs = docs
        .map((doc) => ({ doc, score: fuzzyScore(query, doc.path) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name, 'zh-Hans-CN'))
        .map((entry) => entry.doc);
    }
    if (!docs.length) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      empty.innerHTML = query
        ? '没有匹配的文档。<br>换一个词，或清空筛选。'
        : '卷库还是空的。<br>新建一份，或从会话里点开宿主文档。';
      if (!query) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tb-btn';
        button.textContent = '新建一份';
        button.addEventListener('click', () => void createDocument());
        empty.append(document.createElement('br'), button);
      }
      frag.append(empty);
    } else {
      for (const doc of docs) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'file-row';
        row.dataset.kind = 'local';
        row.dataset.path = doc.path;
        if (state.activeId === `local:${doc.path}`) row.classList.add('on');
        const ext = document.createElement('span');
        ext.className = 'ext';
        ext.textContent = (doc.name.split('.').pop() || 'md').slice(0, 4).toUpperCase();
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = doc.name.replace(/\.(md|markdown|txt)$/i, '');
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = formatBytes(doc.size);
        row.append(ext, name, meta);
        row.title = `${doc.path}（右键删除）`;
        frag.append(row);
      }
    }
  } else {
    const query = state.filter.trim();
    const recent = state.recent.filter((entry) => !query || fuzzyScore(query, entry.path) >= 0);
    if (!recent.length) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      empty.textContent = query ? '没有匹配的最近记录。' : '还没有打开过文档。';
      frag.append(empty);
    } else {
      for (const entry of recent.slice(0, MAX_RECENT)) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'file-row';
        row.dataset.kind = entry.kind;
        row.dataset.path = entry.path;
        const ext = document.createElement('span');
        ext.className = 'ext';
        ext.textContent =
          entry.kind === 'host'
            ? 'HOST'
            : entry.kind === 'workspace'
              ? 'WS'
              : (entry.name.split('.').pop() || 'md').slice(0, 4).toUpperCase();
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = entry.name.replace(/\.(md|markdown|txt)$/i, '');
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = relativeTime(entry.at);
        row.append(ext, name, meta);
        row.title =
          entry.kind === 'host'
            ? `${entry.path}（从会话里重新点开）`
            : entry.kind === 'workspace'
              ? `工作区 · ${entry.path}`
              : entry.path;
        frag.append(row);
      }
    }
  }
  el.sideBody.replaceChildren(frag);
  renderSideFoot();
}

function renderSideFoot() {
  if (state.side === 'workspace') {
    el.sideFoot.textContent = state.workspace.rootToken
      ? `${state.workspace.rootPath || '工作区'} · 只读`
      : '工作区根未签发';
    el.sideFoot.title = state.workspace.rootPath;
    return;
  }
  el.sideFoot.title = '';
  el.sideFoot.textContent =
    state.side === 'files'
      ? `${state.localFiles.length} 份文档 · ${state.drafts.size} 份草稿 · 数据地盘`
      : `${state.recent.length} 条最近记录`;
}

function touchRecent(entry) {
  const key = `${entry.kind}:${entry.path}`;
  state.recent = [
    { ...entry, at: Date.now() },
    ...state.recent.filter((item) => `${item.kind}:${item.path}` !== key),
  ].slice(0, MAX_RECENT);
  schedulePersist();
}

/* ── 标签栏 / 顶栏 / 状态栏 ── */

function renderTabbar() {
  const frag = document.createDocumentFragment();
  if (!state.tabs.length) {
    const empty = document.createElement('span');
    empty.className = 'tabbar-empty';
    empty.textContent = '未打开文档';
    frag.append(empty);
  } else {
    for (const tab of state.tabs) {
      const node = document.createElement('div');
      node.className = 'tab';
      node.dataset.id = tab.id;
      node.setAttribute('role', 'tab');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-selected', String(tab.id === state.activeId));
      node.title = tab.path;
      if (tab.id === state.activeId) node.classList.add('on');
      if (tab.dirty) node.classList.add('dirty');
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tab.name;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-x';
      close.textContent = '×';
      close.setAttribute('aria-label', `关闭 ${tab.name}`);
      close.dataset.close = tab.id;
      node.append(dot, name);
      if (tab.pending) {
        const flag = document.createElement('span');
        flag.className = 'tab-flag';
        flag.textContent = '审';
        flag.title = '改稿单待宿主确认';
        node.append(flag);
      }
      node.append(close);
      frag.append(node);
    }
  }
  el.tabbar.replaceChildren(frag);
  const active = el.tabbar.querySelector('.tab.on');
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderTopbar() {
  const tab = activeTab();
  if (!tab) {
    el.docKind.textContent = '未打开';
    el.docTitle.textContent = '从左侧选一份文档';
    el.btnSave.disabled = true;
    el.btnMode.textContent = '编辑';
    el.btnSplit.classList.remove('on');
    el.app.dataset.view = 'read';
    el.btnTheme.textContent = state.theme === 'night' ? '白' : '夜';
    return;
  }
  el.docKind.textContent =
    tab.kind === 'host'
      ? tab.workspace
        ? '工作区文档 · 只读根'
        : tab.stale
          ? '宿主文档 · 令牌失效'
          : '宿主文档'
      : tab.missing
        ? '卷库文档 · 已删除'
        : '卷库文档';
  el.docTitle.textContent = tab.name;
  el.docTitle.title = tab.path;
  el.btnSave.disabled =
    !tab.dirty || (tab.kind === 'host' && (!tab.docToken || tab.stale || tab.pending)) || tab.missing;
  el.btnMode.textContent = tab.view === 'read' ? '编辑' : '阅读';
  el.btnSplit.classList.toggle('on', tab.view === 'split');
  el.btnTheme.textContent = state.theme === 'night' ? '白' : '夜';
  el.app.dataset.view = tab.view;
}

function renderStatus() {
  const tab = activeTab();
  el.statusBridge.textContent = state.bridgeReady ? '桥：已连接' : '桥：未连接';
  el.statusBridge.className = `status-bridge${state.bridgeReady ? '' : ' off'}`;
  if (!tab) {
    el.statusLeft.textContent = '未打开文档';
    el.statusCount.textContent = '';
    el.statusSave.textContent = '';
    el.statusSave.className = 'status-save';
    return;
  }
  const viewLabel = tab.view === 'read' ? '阅读' : tab.view === 'split' ? '分栏' : '编辑';
  el.statusLeft.textContent = `Ln ${tab.cursor.line}, Col ${tab.cursor.col} · ${viewLabel}`;
  clearTimeout(state.countTimer);
  state.countTimer = setTimeout(() => {
    const current = activeTab();
    if (!current) return;
    const count = countText(current.text);
    el.statusCount.textContent = `${count.words} 字 · ${count.lines} 行`;
  }, 120);
  if (tab.pending) {
    el.statusSave.textContent = '待审';
    el.statusSave.className = 'status-save saving';
  } else if (tab.dirty) {
    el.statusSave.textContent = '草稿已存 · 未定稿';
    el.statusSave.className = 'status-save saving';
  } else if (tab.missing) {
    el.statusSave.textContent = '文件已不在磁盘';
    el.statusSave.className = 'status-save error';
  } else {
    el.statusSave.textContent = '已保存';
    el.statusSave.className = 'status-save saved';
  }
}

function renderBanner() {
  if (!state.banner) {
    el.banner.hidden = true;
    el.bannerText.textContent = '';
    el.bannerActions.replaceChildren();
    return;
  }
  el.banner.hidden = false;
  el.bannerText.textContent = state.banner.text;
  const frag = document.createDocumentFragment();
  for (const action of state.banner.actions ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => action.run());
    frag.append(button);
  }
  el.bannerActions.replaceChildren(frag);
}

function showBanner(text, actions = []) {
  state.banner = { text, actions };
  renderBanner();
}

function clearBanner() {
  state.banner = null;
  renderBanner();
}

function updateEmptyState() {
  el.app.dataset.empty = state.tabs.length ? 'off' : 'on';
  el.emptyHint.textContent = state.bridgeReady
    ? state.workspace.rootToken
      ? `工作区 ${state.workspace.rootPath || '根'} · 只读 · 卷库 ${state.localFiles.length} 份`
      : `卷库 ${state.localFiles.length} 份 · 数据地盘（宿主未签发工作区根）`
    : TEXT_BRIDGE_FALLBACK;
}

function renderAll() {
  renderTopbar();
  renderTabbar();
  renderSidebar();
  renderOutline();
  renderStatus();
  renderBanner();
  updateEmptyState();
  applyTheme();
}

/* ── 主题 / 布局 ── */

function applyTheme() {
  el.app.dataset.theme = state.theme;
  el.btnTheme.textContent = state.theme === 'night' ? '白' : '夜';
}

function applyLayout() {
  el.app.dataset.sidebar = state.sidebarOpen ? 'on' : 'off';
  el.app.dataset.outline = state.outlineOpen ? 'on' : 'off';
  el.btnSidebar.classList.toggle('on', state.sidebarOpen);
  el.btnOutlineToggle.classList.toggle('on', state.outlineOpen);
  setSidebarWidth(state.sidebarWidth, false);
  setOutlineWidth(state.outlineWidth, false);
}

function setSidebarWidth(width, persist = true) {
  const next = clamp(Math.round(Number(width) || 236), 168, 420);
  state.sidebarWidth = next;
  el.app.style.setProperty('--sidebar-w', `${next}px`);
  if (persist) schedulePersist();
}

function setOutlineWidth(width, persist = true) {
  const next = clamp(Math.round(Number(width) || 220), 150, 360);
  state.outlineWidth = next;
  el.app.style.setProperty('--outline-w', `${next}px`);
  if (persist) schedulePersist();
}

function bindResizer(resizer, { getValue, setValue, min, max, reverse = false }) {
  let startX = 0;
  let startValue = 0;
  const onMove = (event) => {
    const delta = reverse ? startX - event.clientX : event.clientX - startX;
    setValue(clamp(startValue + delta, min, max));
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    schedulePersist();
  };
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    startX = event.clientX;
    startValue = getValue();
    resizer.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  resizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 48 : 12;
    let delta = 0;
    if (event.key === 'ArrowLeft') delta = reverse ? step : -step;
    if (event.key === 'ArrowRight') delta = reverse ? -step : step;
    if (event.key === 'Home') delta = min - getValue();
    if (event.key === 'End') delta = max - getValue();
    if (!delta) return;
    event.preventDefault();
    setValue(clamp(getValue() + delta, min, max));
    schedulePersist();
  });
}

/* ── 命令面板 ── */

function commandItems() {
  return [
    { label: '新建文档', hint: '卷库', keywords: 'new create 新建', run: () => void createDocument() },
    { label: '搜索工作区内容', hint: '⌘⇧F', keywords: 'search content 搜索 内容', run: () => openPalette('search') },
    { label: '快速打开工作区文件', hint: '⌘P', keywords: 'quick open 快速 打开 工作区', run: () => openPalette('files') },
    { label: '保存当前文档', hint: '⌘S', keywords: 'save 保存', run: () => void saveActive() },
    { label: '切换阅读 / 编辑', hint: '⌘E', keywords: 'mode read edit 阅读 编辑', run: toggleMode },
    { label: '切换分栏预览', hint: '', keywords: 'split 分栏 预览', run: toggleSplit },
    { label: '切换夜读 / 纸白', hint: '', keywords: 'theme dark night 主题 夜读', run: toggleTheme },
    { label: '收起 / 展开卷库', hint: '⌘B', keywords: 'sidebar 侧栏 卷库', run: toggleSidebar },
    { label: '收起 / 展开大纲', hint: '', keywords: 'outline 大纲', run: toggleOutline },
    { label: '从磁盘重新载入', hint: '', keywords: 'reload 重载', run: () => void reloadActive() },
    { label: '关闭当前标签', hint: '⌘W', keywords: 'close 关闭', run: closeActive },
    { label: '刷新卷库列表', hint: '', keywords: 'refresh 刷新', run: () => void refreshLocalFiles() },
  ];
}

function paletteItems() {
  const query = state.palette.query.trim();
  if (state.palette.mode === 'files') {
    const local = state.localFiles.map((doc) => ({
      type: 'file',
      kind: 'local',
      name: doc.name.replace(/\.(md|markdown|txt)$/i, ''),
      path: doc.path,
      dir: dirname(doc.path) || '卷库',
      hint: formatBytes(doc.size),
    }));
    const seen = new Set(local.map((item) => item.path));
    for (const entry of state.recent) {
      if (entry.kind !== 'local' || seen.has(entry.path)) continue;
      local.push({
        type: 'file',
        kind: 'local',
        name: entry.name.replace(/\.(md|markdown|txt)$/i, ''),
        path: entry.path,
        dir: dirname(entry.path) || '卷库',
        hint: '最近',
      });
      seen.add(entry.path);
    }
    const workspace = state.palette.searchHits
      .filter((hit) => typeof hit?.relPath === 'string' && !seen.has(hit.relPath))
      .map((hit) => ({
        type: 'file',
        kind: 'workspace',
        name: basename(hit.relPath).replace(/\.(md|markdown|txt)$/i, ''),
        path: hit.relPath,
        dir: dirname(hit.relPath) || '工作区',
        hint: '工作区',
      }));
    const merged = [...local, ...workspace];
    return merged
      .map((item) => ({ ...item, score: fuzzyScore(query, `${item.path} ${item.name}`) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, 60);
  }
  if (state.palette.mode === 'search') {
    if (!query) return [];
    return state.palette.searchHits
      .filter((hit) => typeof hit?.relPath === 'string')
      .slice(0, 80)
      .map((hit) => ({
        type: 'hit',
        relPath: hit.relPath,
        line: Number(hit.line) || 0,
        preview: String(hit.preview || ''),
        label: `${hit.relPath}${hit.line ? `:${hit.line}` : ''}`,
      }));
  }
  return commandItems()
    .map((item) => ({ ...item, type: 'command', score: fuzzyScore(query, `${item.label} ${item.keywords}`) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}

function openPalette(mode) {
  const searchSeq = state.palette.searchSeq;
  state.palette = {
    open: true,
    mode,
    query: '',
    index: 0,
    items: [],
    searchHits: [],
    searching: false,
    searchSeq,
    searchTimer: null,
  };
  el.palette.hidden = false;
  el.paletteMark.textContent = mode === 'files' ? '文' : mode === 'search' ? '搜' : '令';
  el.paletteInput.value = '';
  el.paletteInput.placeholder =
    mode === 'files' ? '输入文件名，或直接搜索工作区…' : mode === 'search' ? '搜索工作区内容…' : '输入命令…';
  el.paletteFoot.textContent =
    mode === 'commands' ? '↑↓ 选择 · Enter 执行 · Esc 关闭' : '↑↓ 选择 · Enter 打开 · Esc 关闭';
  renderPalette();
  el.paletteInput.focus();
  if (mode !== 'commands') scheduleWorkspaceSearch('');
}

function closePalette() {
  if (state.palette.searchTimer) clearTimeout(state.palette.searchTimer);
  state.palette.searchSeq += 1;
  state.palette.open = false;
  el.palette.hidden = true;
}

/** 快速打开 / 内容搜索：防抖调宿主 ws.search（只回根内相对路径）。 */
function scheduleWorkspaceSearch(query) {
  const mode = state.palette.mode;
  if (mode === 'commands') return;
  if (state.palette.searchTimer) clearTimeout(state.palette.searchTimer);
  const seq = ++state.palette.searchSeq;
  if (!state.workspace.rootToken) {
    state.palette.searchHits = [];
    state.palette.searching = false;
    renderPalette();
    return;
  }
  const trimmed = query.trim();
  if (mode === 'search' && !trimmed) {
    state.palette.searchHits = [];
    state.palette.searching = false;
    renderPalette();
    return;
  }
  state.palette.searching = true;
  renderPalette();
  state.palette.searchTimer = setTimeout(() => {
    void (async () => {
      try {
        const res = await bridge.call('ws.search', {
          rootToken: state.workspace.rootToken,
          query: trimmed,
          mode: mode === 'search' ? 'content' : 'name',
          limit: mode === 'search' ? 60 : 80,
        });
        if (seq !== state.palette.searchSeq || !state.palette.open) return;
        state.palette.searchHits = Array.isArray(res?.hits) ? res.hits : [];
      } catch (error) {
        if (seq !== state.palette.searchSeq || !state.palette.open) return;
        state.palette.searchHits = [];
        showToast(`搜索失败：${error.message}`, 'err', 3600);
      } finally {
        if (seq === state.palette.searchSeq && state.palette.open) {
          state.palette.searching = false;
          renderPalette();
        }
      }
    })();
  }, 140);
}

function renderPalette() {
  const items = paletteItems();
  state.palette.items = items;
  state.palette.index = clamp(state.palette.index, 0, Math.max(0, items.length - 1));
  const frag = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = state.palette.searching
      ? '搜索中…'
      : state.palette.mode === 'files'
        ? '没有匹配的文档'
        : state.palette.mode === 'search'
          ? '没有匹配的内容'
          : '没有匹配的命令';
    frag.append(empty);
  } else {
    items.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-item';
      if (index === state.palette.index) button.classList.add('on');
      button.dataset.index = String(index);
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = item.type === 'file' ? item.name : item.type === 'hit' ? item.label : item.label;
      const hint = document.createElement('span');
      hint.className = 'p-hint';
      hint.textContent =
        item.type === 'file' ? item.dir : item.type === 'hit' ? item.preview || '工作区' : item.hint || '';
      button.append(name, hint);
      frag.append(button);
    });
  }
  el.paletteList.replaceChildren(frag);
  const active = el.paletteList.querySelector('.palette-item.on');
  active?.scrollIntoView({ block: 'nearest' });
}

function runPaletteIndex(index) {
  const item = state.palette.items[index];
  if (!item) return;
  closePalette();
  if (item.type === 'file') {
    if (item.kind === 'workspace') void openWorkspaceFile(item.path);
    else void openLocal(item.path);
  } else if (item.type === 'hit') {
    void openWorkspaceFile(item.relPath, { line: item.line });
  } else {
    item.run?.();
  }
}

/* ── 模态 ── */

function showPrompt({ title, desc, value = '', placeholder = '', okLabel = '确定', validate = () => null }) {
  return new Promise((resolve) => {
    state.modal = { resolve, validate };
    el.modalTitle.textContent = title;
    el.modalDesc.textContent = desc;
    el.modalInput.value = value;
    el.modalInput.placeholder = placeholder;
    el.modalError.hidden = true;
    el.modalError.textContent = '';
    el.modalOk.textContent = okLabel;
    el.modal.hidden = false;
    el.modalInput.focus();
    el.modalInput.select();
  });
}

function settleModal(value) {
  if (!state.modal) return;
  const { resolve } = state.modal;
  state.modal = null;
  el.modal.hidden = true;
  resolve(value);
}

function confirmModal() {
  if (!state.modal) return;
  const value = el.modalInput.value;
  const error = state.modal.validate(value);
  if (error) {
    el.modalError.textContent = error;
    el.modalError.hidden = false;
    el.modalInput.focus();
    return;
  }
  settleModal(value);
}

async function createDocument() {
  const value = await showPrompt({
    title: '新建文档',
    desc: '文档写进文卷自己的数据地盘，不会碰工作区文件。',
    value: '未命名',
    placeholder: '文档名（自动补 .md）',
    okLabel: '新建',
    validate: (input) => {
      const name = normalizeDocName(input);
      if (!name) return '名字不能为空';
      if (state.localFiles.some((doc) => doc.name.toLowerCase() === name.toLowerCase())) return '同名文档已存在';
      return null;
    },
  });
  if (value == null) return;
  const name = normalizeDocName(value);
  if (!name) return;
  try {
    await bridge.call('fs.write', {
      path: name,
      content: `# ${name.replace(/\.md$/i, '')}\n\n`,
    });
    await refreshLocalFiles({ silent: true });
    await openLocal(name, { view: 'edit' });
    showToast(`已新建 ${name}`, 'ok', 1800);
  } catch (error) {
    showToast(`新建失败：${error.message}`, 'err', 4600);
  }
}

async function deleteDocument(path) {
  if (!window.confirm(`删除「${path}」？此操作不可撤销。`)) return;
  const tab = tabById(`local:${path}`);
  if (tab) {
    clearTimeout(state.draftTimers.get(tab.id));
    state.draftTimers.delete(tab.id);
  }
  try {
    await bridge.call('fs.delete', { path });
    if (tab) {
      tab.dirty = false;
      closeTab(tab.id, { silent: true });
    }
    // 文档本体已删，草稿也不能留着冒充「可恢复」
    state.drafts.delete(draftKey('local', path));
    await bridge.call('fs.delete', { path: `${DRAFTS_DIR}/${draftFileName('local', path)}` }).catch(() => {});
    await refreshLocalFiles({ silent: true });
    renderAll();
    showToast(`已删除 ${path}`, 'info');
  } catch (error) {
    showToast(`删除失败：${error.message}`, 'err', 4600);
  }
}

/* ── 持久化 ── */

function schedulePersist() {
  clearTimeout(state.stateTimer);
  state.stateTimer = setTimeout(persistStateNow, 500);
}

function persistStateNow() {
  if (!state.bridgeReady) return;
  const active = activeTab();
  const payload = {
    version: 1,
    theme: state.theme,
    sidebarOpen: state.sidebarOpen,
    outlineOpen: state.outlineOpen,
    sidebarWidth: state.sidebarWidth,
    outlineWidth: state.outlineWidth,
    active: active?.kind === 'local' ? active.path : null,
    localTabs: state.tabs.filter((tab) => tab.kind === 'local').map((tab) => tab.path).slice(0, MAX_TABS),
    recent: state.recent.slice(0, MAX_RECENT),
  };
  void bridge
    .call('fs.write', { path: STATE_FILE, content: JSON.stringify(payload) })
    .catch((error) => console.warn('[wenjuan] 界面状态落盘失败', error));
}

async function loadPersistedState() {
  try {
    const raw = await bridge.call('fs.read', { path: STATE_FILE });
    const parsed = JSON.parse(textOf(raw));
    if (!parsed || typeof parsed !== 'object') return;
    state.theme = parsed.theme === 'night' ? 'night' : 'paper';
    state.sidebarOpen = parsed.sidebarOpen !== false;
    state.outlineOpen = parsed.outlineOpen !== false;
    state.sidebarWidth = clamp(Number(parsed.sidebarWidth) || 236, 168, 420);
    state.outlineWidth = clamp(Number(parsed.outlineWidth) || 220, 150, 360);
    state.recent = Array.isArray(parsed.recent)
      ? parsed.recent
          .filter(
            (entry) =>
              entry &&
              (entry.kind === 'local' || entry.kind === 'host' || entry.kind === 'workspace') &&
              typeof entry.path === 'string' &&
              typeof entry.name === 'string',
          )
          .slice(0, MAX_RECENT)
      : [];
    state.persistedTabs = Array.isArray(parsed.localTabs)
      ? parsed.localTabs.filter((path) => typeof path === 'string' && isSafeRelPath(path) && isDocumentName(path))
      : [];
    state.persistedActive = typeof parsed.active === 'string' ? parsed.active : null;
  } catch {
    // 首次运行：没有 state.json
  }
  applyLayout();
  applyTheme();
}

/* ── 视图操作 ── */

function toggleMode() {
  const tab = activeTab();
  if (!tab) return;
  tab.view = tab.view === 'read' ? 'edit' : 'read';
  applyView(tab);
}

function toggleSplit() {
  const tab = activeTab();
  if (!tab) return;
  tab.view = tab.view === 'split' ? 'edit' : 'split';
  applyView(tab);
}

function applyView(tab) {
  el.app.dataset.view = tab.view;
  renderTopbar();
  renderStatus();
  if (viewHasEditor(tab)) {
    if (editor) {
      editor.setReadOnly(tab.kind === 'host' && (tab.stale || !tab.docToken));
      editor.setText(tab.text);
      editor.focus();
      requestAnimationFrame(() => editor?.requestMeasure());
    }
  }
  if (viewHasPreview(tab)) schedulePreview(0);
  schedulePersist();
}

function toggleTheme() {
  state.theme = state.theme === 'night' ? 'paper' : 'night';
  applyTheme();
  schedulePersist();
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  applyLayout();
  schedulePersist();
}

function toggleOutline() {
  state.outlineOpen = !state.outlineOpen;
  applyLayout();
  schedulePersist();
}

function closeActive() {
  if (state.activeId) closeTab(state.activeId);
}

/* ── 事件绑定 ── */

function bindUi() {
  el.btnSidebar.addEventListener('click', toggleSidebar);
  el.btnOutlineToggle.addEventListener('click', toggleOutline);
  el.btnMode.addEventListener('click', toggleMode);
  el.btnSplit.addEventListener('click', toggleSplit);
  el.btnSave.addEventListener('click', () => void saveActive());
  el.btnTheme.addEventListener('click', toggleTheme);
  el.btnPalette.addEventListener('click', () => openPalette('files'));
  el.btnNew.addEventListener('click', () => void createDocument());
  el.emptyNew.addEventListener('click', () => void createDocument());
  el.emptyPalette.addEventListener('click', () => openPalette('files'));
  el.btnOutline.addEventListener('click', toggleOutline);

  for (const tab of document.querySelectorAll('.side-tab')) {
    tab.addEventListener('click', () => {
      state.side = tab.dataset.side;
      for (const other of document.querySelectorAll('.side-tab')) {
        const on = other === tab;
        other.classList.toggle('on', on);
        other.setAttribute('aria-selected', String(on));
      }
      renderSidebar();
    });
  }

  el.filter.addEventListener('input', () => {
    state.filter = el.filter.value;
    renderSidebar();
  });

  el.sideBody.addEventListener('click', (event) => {
    const tree = event.target.closest?.('.tree-row');
    if (tree?.dataset.rel != null) {
      if (tree.dataset.dir === '1') toggleWorkspaceDir(tree.dataset.rel);
      else void openWorkspaceFile(tree.dataset.rel);
      return;
    }
    const row = event.target.closest?.('.file-row');
    if (!row) return;
    const kind = row.dataset.kind;
    const path = row.dataset.path;
    if (!path) return;
    if (kind === 'local') void openLocal(path);
    else if (kind === 'workspace') {
      if (state.workspace.rootToken) void openWorkspaceFile(path);
      else showToast('工作区根未签发，无法重开这份文件', 'info', 3200);
    } else showToast('宿主文档请从会话里的文件引用重新点开', 'info', 3200);
  });

  el.sideBody.addEventListener('contextmenu', (event) => {
    if (state.side !== 'files') return;
    const row = event.target.closest?.('.file-row');
    if (!row || row.dataset.kind !== 'local' || !row.dataset.path) return;
    event.preventDefault();
    void deleteDocument(row.dataset.path);
  });

  el.tabbar.addEventListener('click', (event) => {
    const close = event.target.closest?.('.tab-x');
    if (close?.dataset.close) {
      event.stopPropagation();
      closeTab(close.dataset.close);
      return;
    }
    const tab = event.target.closest?.('.tab');
    if (tab?.dataset.id) activateTab(tab.dataset.id, { focus: true });
  });

  el.tabbar.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('.tab');
    if (!tab?.dataset.id) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateTab(tab.dataset.id, { focus: true });
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      closeTab(tab.dataset.id);
    }
  });

  el.outlineBody.addEventListener('click', (event) => {
    const item = event.target.closest?.('.outline-item');
    if (!item?.dataset.line) return;
    jumpToLine(Number(item.dataset.line));
  });

  el.previewHost.addEventListener('click', onPreviewClick);

  el.paletteInput.addEventListener('input', () => {
    state.palette.query = el.paletteInput.value;
    state.palette.index = 0;
    renderPalette();
    scheduleWorkspaceSearch(el.paletteInput.value);
  });
  el.paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.palette.index = Math.min(state.palette.index + 1, Math.max(0, state.palette.items.length - 1));
      renderPalette();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.palette.index = Math.max(0, state.palette.index - 1);
      renderPalette();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runPaletteIndex(state.palette.index);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  });
  el.paletteList.addEventListener('click', (event) => {
    const item = event.target.closest?.('.palette-item');
    if (!item?.dataset.index) return;
    runPaletteIndex(Number(item.dataset.index));
  });
  el.palette.addEventListener('mousedown', (event) => {
    if (event.target === el.palette) closePalette();
  });

  el.modalOk.addEventListener('click', confirmModal);
  el.modalCancel.addEventListener('click', () => settleModal(null));
  el.modalInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmModal();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      settleModal(null);
    }
  });
  el.modal.addEventListener('mousedown', (event) => {
    if (event.target === el.modal) settleModal(null);
  });

  bindResizer(el.sideResizer, {
    getValue: () => state.sidebarWidth,
    setValue: (value) => setSidebarWidth(value),
    min: 168,
    max: 420,
  });
  bindResizer(el.outlineResizer, {
    getValue: () => state.outlineWidth,
    setValue: (value) => setOutlineWidth(value),
    min: 150,
    max: 360,
    reverse: true,
  });

  window.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('focus', () => void checkExternal(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkExternal(true);
  });
  window.addEventListener('beforeunload', () => {
    flushAllDrafts();
    persistStateNow();
  });

  bridge.on('workspace-open', (payload) => {
    void onWorkspaceOpen(payload);
  });
  bridge.on('doc-open', (payload) => {
    if (!state.booted) {
      state.pendingHostOpen = payload;
      return;
    }
    hostOpenChain = hostOpenChain
      .then(() => openHostDocument(payload))
      .catch((error) => console.warn('[wenjuan] 宿主文档开稿失败', error));
  });
  bridge.on('doc-saved', onDocSaved);
  bridge.on('doc-rejected', onDocRejected);
  bridge.on('window-closing', () => {
    flushAllDrafts();
    persistStateNow();
  });
}

function onGlobalKeydown(event) {
  // CM6 已处理的键会 preventDefault（Mod-S / Mod-W / Mod-E 的 keymap 在编辑器内）——
  // 不再重复执行，否则「关一个标签」会连关两个。
  if (event.defaultPrevented) return;
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') {
    if (state.palette.open) {
      event.preventDefault();
      closePalette();
      return;
    }
    if (state.modal) {
      event.preventDefault();
      settleModal(null);
      return;
    }
    if (state.banner) {
      event.preventDefault();
      clearBanner();
    }
    return;
  }
  if (!mod) return;
  if (state.palette.open || state.modal) return;
  const key = event.key.toLowerCase();
  if (key === 'p' && !event.shiftKey) {
    event.preventDefault();
    openPalette('files');
    return;
  }
  if (key === 'f' && event.shiftKey) {
    event.preventDefault();
    openPalette('search');
    return;
  }
  if ((key === 'k' && !event.shiftKey) || (key === 'p' && event.shiftKey)) {
    event.preventDefault();
    openPalette('commands');
    return;
  }
  if (key === 'b' && !event.shiftKey) {
    event.preventDefault();
    toggleSidebar();
    return;
  }
  if (key === 'o' && event.shiftKey) {
    event.preventDefault();
    toggleOutline();
    return;
  }
  if (key === 's') {
    event.preventDefault();
    void saveActive();
    return;
  }
  if (key === 'w') {
    event.preventDefault();
    closeActive();
    return;
  }
  if (key === 'e') {
    event.preventDefault();
    toggleMode();
    return;
  }
  if (/^[1-9]$/.test(key)) {
    const tab = state.tabs[Number(key) - 1];
    if (tab) {
      event.preventDefault();
      activateTab(tab.id, { focus: true });
    }
  }
}

/* ── 启动 ── */

async function boot() {
  bindUi();
  applyLayout();
  applyTheme();

  editor = mountEditor(el.editorHost, {
    doc: '',
    readOnly: true,
    onChange: onEditorChange,
    onCursor: onCursor,
    onSave: () => void saveActive(),
    onCloseTab: closeActive,
    onToggleMode: toggleMode,
  });

  updateEmptyState();
  renderAll();

  const ready = await bridge.whenReady(2_500);
  state.bridgeReady = ready;
  el.statusBridge.textContent = ready ? '桥：已连接' : '桥：未连接';
  el.statusBridge.className = `status-bridge${ready ? '' : ' off'}`;
  if (!ready) {
    updateEmptyState();
    showToast(TEXT_BRIDGE_FALLBACK, 'err', 6_000);
    return;
  }

  await loadPersistedState();
  await refreshLocalFiles({ silent: true });
  await loadDrafts();

  for (const path of state.persistedTabs.slice(0, MAX_TABS)) {
    if (!state.localFiles.some((doc) => doc.path === path)) continue;
    await openLocal(path, { activate: false, silent: true });
  }
  const preferred = state.persistedActive ? tabById(`local:${state.persistedActive}`) : null;
  const first = preferred ?? state.tabs[0] ?? null;
  if (first) activateTab(first.id);
  else renderAll();

  state.booted = true;
  if (state.pendingHostOpen) {
    const payload = state.pendingHostOpen;
    state.pendingHostOpen = null;
    await openHostDocument(payload);
  }
  if (state.side === 'recent') renderSidebar();
  window.setInterval(() => void checkExternal(false), 30_000);
}

function onEditorChange(text) {
  const tab = activeTab();
  if (!tab) return;
  const wasDirty = tab.dirty;
  tab.text = text;
  tab.dirty = text !== tab.savedText;
  if (tab.dirty !== wasDirty) {
    renderTabbar();
    renderTopbar();
    renderStatus();
  }
  scheduleDraft(tab);
  schedulePreview();
  scheduleOutline();
  schedulePersist();
}

function onCursor(pos) {
  const tab = activeTab();
  if (!tab) return;
  tab.cursor = pos;
  const viewLabel = tab.view === 'read' ? '阅读' : tab.view === 'split' ? '分栏' : '编辑';
  el.statusLeft.textContent = `Ln ${pos.line}, Col ${pos.col} · ${viewLabel}`;
  updateOutlineActive(pos.line);
}

boot().catch((error) => {
  console.error('[wenjuan] 启动失败', error);
  el.emptyHint.textContent = `启动失败：${error.message}`;
  showToast(`文卷启动失败：${error.message}`, 'err', 8_000);
});
