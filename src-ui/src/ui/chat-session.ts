// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 聊天面板 — 会话管理（CRUD、持久化、恢复）的**公开面**。
//
// 2026-11-06 上帝文件治理·第 1 刀：实现按既有分区注释拆到 app/chat/session/*，
// 本文件只保留对外导出的再导出——调用方（chat-core / workspace / 测试）零改动，
// 行为零变更。新增会话能力直接落 app/chat/session/<域>.ts，并在此登记公开面；
// 不要再把实现写回本文件（它只负责「这组能力对外长什么样」）。

export type { SavedSessionRow, SessionSaveOutcome, SessionSaveReport } from '../app/chat/session/session-catalog';
export {
  drainVolumeWrites,
  resetSessionListCacheForTests,
  summarizeSaveReport,
} from '../app/chat/session/session-catalog';
export type { CreateSessionOptions } from '../app/chat/session/session-crud';
export {
  closeSession,
  createNewSession,
  ensureSessionAgent,
  ensureVolumeAgent,
  switchSession,
} from '../app/chat/session/session-crud';
export { exportSession } from '../app/chat/session/session-export';
export type { StoredSession } from '../app/chat/session/session-paths';
export {
  noteVolumeIssued,
  reconcileVolumeIssueFloor,
  scanMaxSessionId,
  workspaceSessionsDir,
} from '../app/chat/session/session-paths';
export { listSavedSessions, listVolumeIds, readVolumeData } from '../app/chat/session/session-read';
export { _rebuildMessagesFromSession, rebuildMessagesFromMessages } from '../app/chat/session/session-rebuild';
export {
  clearPanelAgents,
  disposePanelMessages,
  getActiveAgent,
  getActiveIdx,
  getAgentFactory,
  getNextSessionId,
  getSessionAgent,
  getSessionExecState,
  getSessions,
  getTurnPairs,
  removeSessionExecState,
  resetSessionState,
  setAgentFactory,
  setNextSessionId,
  setTurnPairs,
  syncActiveSessionTokens,
} from '../app/chat/session/session-registry';
export type { SessionDeleteResult } from '../app/chat/session/session-restore';
export { batchRestoreSessions, deleteSessionFile, loadSessionFromDisk } from '../app/chat/session/session-restore';
export { canRetraceUserTurn, retractUserMessage } from '../app/chat/session/session-retract';
export {
  autoRestoreLastSession,
  cancelScheduledAutoSave,
  renameSessionFile,
  saveActiveSession,
  saveAllSessions,
  saveSessionById,
  scheduleAutoSave,
} from '../app/chat/session/session-save';
export { autoTitleSessionIfDefault, refineVolumeTitleIfDerived } from '../app/chat/session/session-titles';
export type { ChatSession, SessionContext } from '../app/chat/session/session-types';
export { isInternalMessage } from '../app/chat/session/session-types';
