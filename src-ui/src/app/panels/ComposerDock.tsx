// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/panels/ComposerDock — 创作坞（Stage-4 §4.2 集成任务非新设计）。
//
// 定位（canvas-space-model-notes.md §5 拍板 9）：带设置的输入条，常驻画布
// 元素，状态跟活跃目标走（自动选中 + 高亮已定），设置项贴输入条（模型/
// 权限/思考强度，展开收起），发送前顺手拨。空白画布无活跃会话时处于无主
// 待命态。
//
// 归属铁律：创作坞是视图不是容器，不拥有任何会话状态，只"指向"当前活跃
// 会话。草稿按会话隔离 = input-store 既有 sessionDrafts 机制（chat-session
// 切卷时 save/restore，本组件只读写 live inputText）；模型/思考 = compose-store
// 每会话偏好（写全局 settings + 热切换信号）；权限 = mode-store 工作区级
// 单一真相。
//
// 挂载：compose-dock-plugin 以 ctx.overlays 贡献行注册（slot:'composer'），
// 由 PaperPanel 渲染在底部；经 paper/overlay-context 取活跃会话与输入锁存。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { agentSessionState } from '../../agent/agent-session-state';
import { composerSubmitOnKey } from '../../paper/ime';
import { usePaperDock } from '../../paper/overlay-context';
import { getModel } from '../../provider/catalog';
import { type StoredThinking, thinkingOptionsFor } from '../../provider/thinking';
import { loadSettings, type ProviderSettings } from '../../settings';
import { type ComposeSessionPrefs, getComposeStore } from '../../state/compose-store';
import {
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  PERMISSION_MODES,
  type PermissionMode,
  useModeStore,
} from '../../state/mode-store';
import { getChatStore } from '../../ui/chat-store';
import { CommandRegistry } from '../../ui/command-registry';
import { useCoreStore } from '../chat/core-instance';
import { ModelSelector } from './ModelSelector';

/** 把目录模型描述符映射到已配置 provider 名（跨 provider 搜索时联动切换）。 */
function providerNameForModel(desc: { vendor: string } | undefined, fallback: string): string {
  if (!desc?.vendor) return fallback;
  try {
    const providers = loadSettings().providers;
    const hit = providers.find((p) => p.name === desc.vendor);
    return hit ? hit.name : fallback;
  } catch {
    return fallback;
  }
}

/** rework P2-2：思考档位纯中文展示词（创作坞内不再中英混排）。 */
const THINKING_ZH: Record<string, string> = {
  '': '自动',
  off: '关闭',
  minimal: '最浅',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '较深',
  max: '极限',
};

function thinkingZhLabel(value: string | undefined): string {
  if (value == null || value === '') return THINKING_ZH[''] ?? '自动';
  return THINKING_ZH[value] ?? value;
}

export const ComposerDock = memo(function ComposerDock() {
  const core = useCoreStore((s) => s.core);
  const { activeSessionId, setInputLocked } = usePaperDock();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  /* ── 会话面：sess store 订阅（切卷/改名/token 变化自动重渲）── */
  const [sessions, setSessions] = useState<Array<{ id: number; label: string }>>([]);
  const [sessionTokens, setSessionTokens] = useState<Record<number, number>>({});
  useEffect(() => {
    if (!core) {
      setSessions([]);
      setSessionTokens({});
      return;
    }
    const sess = getChatStore(core.panelId).sess;
    const sync = () => {
      setSessions(sess.getState().sessions);
      setSessionTokens(sess.getState().sessionTokens);
    };
    sync();
    return sess.subscribe(sync);
  }, [core]);
  const activeSession =
    activeSessionId != null ? (sessions.find((s) => String(s.id) === activeSessionId) ?? null) : null;
  const activeSidNum = activeSessionId != null ? Number(activeSessionId) : null;
  const tokenCount = activeSidNum != null ? (sessionTokens[activeSidNum] ?? 0) : 0;

  /* ── 草稿（input-store live = 当前活跃会话的输入框；切卷由 chat-session
   *    负责 save/restore sessionDrafts，本组件只读写 live 槽）── */
  const [inputText, setInputTextState] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<Array<{ path: string; name: string; size: number }>>([]);
  useEffect(() => {
    if (!core) {
      setInputTextState('');
      setAttachedFiles([]);
      return;
    }
    const input = getChatStore(core.panelId).input;
    const sync = () => {
      setInputTextState(input.getState().inputText);
      setAttachedFiles(input.getState().attachedFiles);
    };
    sync();
    return input.subscribe(sync);
  }, [core]);

  const setInputText = useCallback(
    (text: string) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().setInputText(text);
    },
    [core],
  );

  const autoGrow = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 144) + 'px';
  }, []);

  useEffect(() => {
    void inputText;
    autoGrow();
  }, [inputText, autoGrow]);

  /* ── 运行态（停止按钮）── */
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!core || activeSidNum == null) {
      setRunning(false);
      return;
    }
    const exec = agentSessionState.getExec(core.panelId, activeSidNum);
    if (!exec) {
      setRunning(false);
      return;
    }
    setRunning(exec.isRunning);
    return exec.onChange(() => setRunning(exec.isRunning));
  }, [core, activeSidNum]);

  /* ── 会话状态对象（compose-store：模型/思考，缺失惰性快照）── */
  const [prefs, setPrefs] = useState<ComposeSessionPrefs | undefined>(undefined);
  useEffect(() => {
    if (!core || activeSessionId == null) {
      setPrefs(undefined);
      return;
    }
    const compose = getComposeStore(core.panelId);
    const sync = () => setPrefs(compose.getState().sessions[activeSessionId]);
    sync();
    return compose.subscribe(sync);
  }, [core, activeSessionId]);
  useEffect(() => {
    if (!core || activeSessionId == null) return;
    getComposeStore(core.panelId).getState().ensurePrefs(activeSessionId);
  }, [core, activeSessionId]);

  const providerName = prefs?.providerName ?? '';
  const model = prefs?.model ?? '';
  // 直接每渲染读 settings（ComposerDock 已 memo，且不随平移重渲——成本可忽略；
  // 用 useMemo 反而要管理「会话偏好变化时重读」的依赖）
  const settings = (() => {
    try {
      return loadSettings();
    } catch {
      return null;
    }
  })();
  const provider: ProviderSettings | undefined = settings?.providers.find((p) => p.name === providerName);
  const providerKind = provider?.kind ?? 'openai';
  const modelDesc = useMemo(() => getModel(model), [model]);
  const thinkingOptions = useMemo(() => thinkingOptionsFor(modelDesc), [modelDesc]);
  const currentThinking = prefs?.thinking;

  /* ── 权限（mode-store 工作区级单一真相）── */
  const permissionMode = useModeStore((s) => s.permissionMode);
  const pendingYolo = useModeStore((s) => s.pendingYolo);
  const setPermissionMode = useModeStore((s) => s.setPermissionMode);
  const setPendingYolo = useModeStore((s) => s.setPendingYolo);

  const selectMode = useCallback(
    (mode: PermissionMode) => {
      if (mode === 'yolo' && permissionMode !== 'yolo') {
        setPendingYolo(true);
        return;
      }
      setPendingYolo(false);
      setPermissionMode(mode);
    },
    [permissionMode, setPendingYolo, setPermissionMode],
  );
  // rework P0-1：卸载（含关窗）时清掉全放确认态，避免残留 DOM 参与销毁时序
  useEffect(() => () => setPendingYolo(false), [setPendingYolo]);

  /* ── 斜杠命令（沿用旧 composer 逻辑）── */
  const slashQuery = useMemo(() => {
    const v = inputText;
    if (!v) return null;
    const last = v.lastIndexOf('/');
    if (last < 0) return null;
    if (last > 0 && v[last - 1] !== ' ' && v[last - 1] !== '\n') return null;
    return v.slice(last + 1);
  }, [inputText]);
  const slashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return CommandRegistry.instance
      .getAll()
      .filter((c) => c.shortcut.toLowerCase().includes(q) || c.label.toLowerCase().includes(q));
  }, [slashQuery]);

  /* ── 附件 ── */
  const onAttach = useCallback(() => {
    void core?.openFilePicker();
  }, [core]);
  const onRemoveAttached = useCallback(
    (idx: number) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().removeAttachedFile(idx);
    },
    [core],
  );

  /* ── 发送 ── */
  const onSend = useCallback(async () => {
    if (!core) return;
    // ⚠ 读 input-store 实时值（真源），不读可能滞后的本地 inputText——
    // 快速连续输入后立刻回车时本地 state 可能缺最后一个字符；
    // 也不许拿旧值回写 store（否则覆盖刚输入的字符 = 丢字）。
    const live = getChatStore(core.panelId).input.getState();
    const t = live.inputText.trim();
    if (!t) return;
    const sessSt = getChatStore(core.panelId).sess.getState();
    if (sessSt.activeIdx < 0 || !sessSt.sessions[sessSt.activeIdx]) {
      setLocalNotice('当前没有活跃会话——请先在侧边栏另起一卷。');
      return;
    }
    setLocalNotice(null);
    await core.sendMessage();
  }, [core]);

  /* ── 热切换：模型 / 思考 ── */
  const onModelChange = useCallback(
    (modelId: string, desc?: { vendor: string }) => {
      if (!core || activeSessionId == null) return;
      const targetProvider = providerNameForModel(desc, providerName);
      getComposeStore(core.panelId).getState().setModel(activeSessionId, targetProvider, modelId);
    },
    [core, activeSessionId, providerName],
  );
  const onThinkingChange = useCallback(
    (value: string) => {
      if (!core || activeSessionId == null) return;
      const next = (value === '' ? '' : value) as StoredThinking;
      getComposeStore(core.panelId).getState().setThinking(activeSessionId, next);
    },
    [core, activeSessionId],
  );

  /* ── 输入锁存：聚焦/输入中关闭自动切换（Stage-4 §4.1）── */
  const onComposerFocus = useCallback(() => setInputLocked(true), [setInputLocked]);
  const onComposerBlur = useCallback(() => setInputLocked(false), [setInputLocked]);

  return (
    <div className="pp-composer">
      {/* 设置行：常驻一行只放高频件（模型 + 权限）；思考等进展开（stage-4 §8） */}
      <div className="pp-composer-settings">
        <span className="pp-composer-target" title={activeSession ? `案卷 ${activeSession.id}` : '未选中会话'}>
          {activeSession ? activeSession.label || `案卷 ${activeSession.id}` : '未选中会话'}
        </span>
        <span className="pp-composer-tokens" title="本卷 token 计数（惰性读取，切回直接读）">
          {tokenCount > 0 ? `${tokenCount} tok` : '—'}
        </span>
        {activeSessionId != null && (
          <>
            <ModelSelector
              value={model}
              onChange={onModelChange}
              providerName={providerName}
              kind={providerKind}
              compact
            />
            {/* rework P2-3：权限三档分段控件（不再循环按钮） */}
            <fieldset className="pp-mode-seg" aria-label="权限模式">
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`pp-mode-opt${permissionMode === m ? ' selected' : ''}`}
                  title={MODE_DESCRIPTIONS[m]}
                  aria-pressed={permissionMode === m}
                  onClick={() => selectMode(m)}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </fieldset>
            {thinkingOptions.length > 0 && (
              <button
                type="button"
                className={`pp-thinking-toggle${settingsOpen ? ' open' : ''}`}
                title="思考档位"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((v) => !v)}
              >
                思考 · {thinkingZhLabel(currentThinking)}
              </button>
            )}
          </>
        )}
        <div className="pp-composer-settings-spacer" />
      </div>

      {/* 思考档位展开区（stage-4 §8：思考进展开；rework P2-2：分段控件 + 纯中文） */}
      {settingsOpen && thinkingOptions.length > 0 && (
        <div className="pp-composer-expanded">
          <span className="pp-composer-expanded-label">思考档位</span>
          <fieldset className="pp-thinking-seg" aria-label="思考档位">
            {thinkingOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`pp-thinking-opt${(currentThinking ?? '') === o.value ? ' selected' : ''}`}
                aria-pressed={(currentThinking ?? '') === o.value}
                onClick={() => onThinkingChange(o.value)}
              >
                {thinkingZhLabel(o.value)}
              </button>
            ))}
          </fieldset>
        </div>
      )}

      {localNotice && (
        <div className="pp-local-notice">
          {localNotice}
          <button type="button" onClick={() => setLocalNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {/* 输入行（原 composer 主体） */}
      <div className="pp-composer-row">
        {slashCommands.length > 0 && (
          <div className="pp-slash">
            {slashCommands.map((c) => (
              <button key={c.id} type="button" className="pp-slash-item" onClick={() => core?.executeCommand(c)}>
                <span className="pp-slash-shortcut">{c.shortcut}</span>
                <span className="pp-slash-label">{c.label}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="pp-attach"
          title="拾遗——附文件入卷"
          aria-label="拾遗：附加文件"
          onClick={onAttach}
        >
          夹
        </button>
        {attachedFiles.length > 0 && (
          <div className="pp-attach-list">
            {attachedFiles.map((f, i) => (
              <button
                key={f.path}
                type="button"
                className="pp-attach-chip"
                title={`${f.path}（点击移除）`}
                onClick={() => onRemoveAttached(i)}
              >
                {f.name} ✕
              </button>
            ))}
            {attachedFiles.length > 3 && <span className="pp-attach-count">共 {attachedFiles.length} 件</span>}
          </div>
        )}
        <textarea
          ref={composerRef}
          rows={1}
          value={inputText}
          placeholder={
            activeSession
              ? '拟文…（Enter 发送 · Shift+Enter 换行 · ↑ 取历史；拖住任意块可移出钉住；拖流区边缘可移动流区）'
              : '先在侧边栏另起一卷，再在此拟文'
          }
          onChange={(e) => {
            setInputText(e.target.value);
          }}
          onFocus={onComposerFocus}
          onBlur={onComposerBlur}
          onKeyDown={(e) => {
            if (composerSubmitOnKey(e.key, e.nativeEvent.isComposing)) {
              e.preventDefault();
              onSend();
              return;
            }
            if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
              const el = e.currentTarget;
              const atFirstLine = el.selectionStart === 0 || !el.value.includes('\n');
              const history = core ? getChatStore(core.panelId).input.getState().inputHistory : [];
              if (atFirstLine && history.length > 0) {
                e.preventDefault();
                const next = history[history.length - 1] ?? '';
                setInputText(next);
                requestAnimationFrame(() => el.setSelectionRange(next.length, next.length));
              }
            }
          }}
        />
        {running && (
          <button
            type="button"
            className="pp-stop"
            title="停止当前回合（级联子 Agent）"
            aria-label="停止"
            onClick={() => core?.abort()}
          >
            停
          </button>
        )}
        <button type="button" onClick={onSend}>
          拟文
        </button>
      </div>

      {/* rework P2-3 / P0-1：全放二次确认 = 独立居中模态（不内嵌创作坞，避免高度/关窗竞态） */}
      {pendingYolo && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 模态遮罩点击空白 = 取消（明确对话框语义）
        <div
          className="pp-mode-dialog-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPendingYolo(false);
          }}
        >
          <div className="pp-mode-dialog" role="dialog" aria-modal="true" aria-label="确认全放模式">
            <div className="pp-mode-dialog-title">切换到全放模式</div>
            <div className="pp-mode-dialog-body">{MODE_DESCRIPTIONS.yolo}</div>
            <div className="pp-mode-dialog-actions">
              <button type="button" onClick={() => setPendingYolo(false)}>
                取消
              </button>
              <button type="button" className="primary" onClick={() => setPermissionMode('yolo')}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
