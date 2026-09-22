// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 壳行（hologram/shell-drag-drop）：原生拖放接线 —— 把资源管理器里拖进来的文件
// 落到当前卷创作坞的草稿槽（图片走附图道，其余走路径附件道）。
//
// 为什么必须走原生通道（2026-09-22 真机失灵）：Tauri 缺省接管 webview 的 dragDrop
// （`dragDropEnabled` 缺省 true），网页层**收不到 HTML5 drop 事件**——`chat-core`
// 的 `handleFileDrop` 自迁入起就注明「从未在真机触发」，纸壳也一直没接。用户侧表现：
// 把图拖进创作坞毫无反应（连提示都没有），只能改成手打路径让 Agent 自己 `fs(read)`
// ——那正是 2026-09-22 读图挂起事故的触发路径。
//
// 语义（与 2026-09-19「先发、被拒再降级」一致）：**图片一律走附图道**，不再按
// `inputModalities` 声明分流成路径附件——声明面已降级为 UI 提示（真被服务商拒收时
// agent 侧记档 + 去图重发，用户侧表现为自动恢复）。非图仍走路径附件老路
// （`attachIntakePaths` 内部经 `splitIntakePaths` 分流）。声明缺失时的提示与创作坞
// 粘贴同文案。

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useCoreStore } from '../../app/chat/core-instance';
import { loadSettings, modelInput } from '../../settings';
import { getComposeStore } from '../../state/compose-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../state/toast-store';
import { getChatStore } from '../../ui/chat-store';

/** 进程级单例（模块级可变态分类 3：生命周期 = 进程）——boot 幂等，重入先解绑旧监听。 */
let unlistenDragDrop: (() => void) | null = null;

/** 当前卷生效模型是否**声明**图片输入。声明只决定要不要提示，不决定收不收。 */
function activeModelImageCapable(): boolean {
  const core = useCoreStore.getState().core;
  if (!core) return true;
  try {
    const sess = getChatStore(core.panelId).sess.getState();
    const sid = String(sess.sessions[sess.activeIdx]?.id ?? '');
    const prefs = getComposeStore(core.panelId).getState().resolveEffective(sid);
    const provider = loadSettings().providers.find((p) => p.name === prefs.providerName);
    return modelInput(provider, prefs.model).includes('image');
  } catch {
    return true; // 声明解析不出 ≠ 不收图：发送面兜底（先发语义）
  }
}

export async function bootDragDrop(): Promise<void> {
  try {
    unlistenDragDrop?.();
    unlistenDragDrop = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      const paths = event.payload.paths;
      if (paths.length === 0) return;
      const core = useCoreStore.getState().core;
      if (!core) return; // 核心未就绪（引导序早于 chat 行/卷未建）——静默跳过，不炸引导
      const imageCapable = activeModelImageCapable();
      void core.attachIntakePaths(paths).catch((e: unknown) => {
        // 入卷失败不静默：拖进来的东西没进草稿槽 = 用户眼里「拖放又失灵了」
        console.warn('[drag-drop] 拖放入卷失败:', e);
        showToast(`拖放入卷失败：${e instanceof Error ? e.message : String(e)}`, 'warn', TOAST_LONG_HOLD_MS);
      });
      if (!imageCapable) {
        showToast(
          '当前模型未声明图片输入——图已收；若服务商拒收会自动改用文字转述（可在设置行换 vision 模型）',
          'warn',
          TOAST_LONG_HOLD_MS,
        );
      }
    });
  } catch (e) {
    // 纯浏览器 dev / 无 Tauri 运行时：接线不发生，调用一致地失败（不炸引导）
    console.warn('[drag-drop] 原生拖放接线不可用（非 Tauri 环境？）:', e);
  }
}
