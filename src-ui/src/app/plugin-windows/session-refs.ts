// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 本卷引用（P1c 尾项）：从当前活跃会话的消息里抽文件引用，交给文卷的
// `workspace-open` 载荷。只抽**可见事实**（用户附件 / 正文 Markdown 链接 /
// 行内码路径 / 工具调用 path/file_path），不猜、不扫盘。
//
// 路径解析与工作区根围栏复用 `state/plugin-workspace-path`；相对路径按工作区根
// 解析（与纸面文件引用点击同一口径），绝对路径必须在根内。结果只回相对路径。

import {
  isWithinWorkspace,
  joinWorkspacePath,
  normalizeRelPath,
  relativeWorkspacePath,
} from '../../state/plugin-workspace-path';
import { msgStoreForActive } from '../../ui/chat-store';
import type { AssistantMessage, ChatMessage } from '../../ui/message-model';
import { useCoreStore } from '../chat/core-instance';

const FILE_TAIL =
  /\.(md|markdown|txt|json|jsonc|ts|tsx|js|jsx|css|html|htm|py|rs|go|java|yml|yaml|toml|csv|log|xml|sh)$/i;

function normalizeCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }
  raw = raw.replace(/[?#].*$/, '');
  if (!raw || raw.length > 500) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  return raw;
}

function addCandidate(out: Set<string>, rootPath: string, value: unknown): void {
  const raw = normalizeCandidate(value);
  if (!raw) return;
  let absolute: string | null;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) {
    absolute = raw.replace(/\\/g, '/');
  } else {
    const relNorm = normalizeRelPath(raw);
    if (relNorm == null) return;
    absolute = joinWorkspacePath(rootPath, relNorm);
  }
  if (!absolute || !isWithinWorkspace(rootPath, absolute)) return;
  const rel = relativeWorkspacePath(rootPath, absolute);
  if (!rel || !FILE_TAIL.test(rel)) return;
  out.add(rel);
}

/** 从消息里抽文件引用（相对工作区根；去重、限量）。 */
export function extractSessionFileRefs(messages: readonly ChatMessage[], rootPath: string): string[] {
  if (!rootPath) return [];
  const out = new Set<string>();
  const addText = (text: string | undefined): void => {
    if (!text) return;
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      addCandidate(out, rootPath, match[1]);
    }
    for (const match of text.matchAll(/`([^`\n]{1,300})`/g)) {
      addCandidate(out, rootPath, match[1]);
    }
  };
  for (const message of messages) {
    if (message.role === 'user') {
      addText(message.text);
      for (const file of message.files ?? []) addCandidate(out, rootPath, file.path);
      continue;
    }
    if (message.role !== 'assistant') continue;
    for (const part of (message as AssistantMessage).parts) {
      if (part.type === 'text') {
        addText(part.text);
        continue;
      }
      if (part.type !== 'tool') continue;
      try {
        const args = JSON.parse(part.args || '{}') as Record<string, unknown>;
        for (const key of ['path', 'file_path', 'file', 'directory']) {
          addCandidate(out, rootPath, args[key]);
        }
      } catch {
        // 工具参数还在流/不是 JSON：不猜
      }
    }
    if (out.size >= 200) break;
  }
  return [...out].slice(0, 200);
}

/** 当前活跃会话的文件引用（无 core / 无活跃卷 ⇒ []）。 */
export function collectActiveSessionFileRefs(rootPath: string): string[] {
  const core = useCoreStore.getState().core;
  if (!core) return [];
  const store = msgStoreForActive(core.panelId);
  if (!store) return [];
  return extractSessionFileRefs(store.getState().messages, rootPath);
}
