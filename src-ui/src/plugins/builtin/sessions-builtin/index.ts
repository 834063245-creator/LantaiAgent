// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置会话持久化 provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/sessions-provider.ts
// 整体迁入；运行时依赖 kernel* 具名 helper 经宿主桥取用。
//
// 动作面重设计（session-persistence-seam-wiring-plan C 定案，2026-09-05）：
// 旧 SESSIONS_FS_CAP_BY_ACTION 六动作表（fs 域五动作 + append 走 RPC 直呼）
// 整表退役——动作面全换，无保留面。四动作会话语义（read_volume/list_volumes/
// save_volume/delete_volume）直接转发 kernel* 具名 helper（kernelReadFileRaw/
// kernelListDirectory/kernelWriteFile——既有 fs_cap 用户路径包装）：
//   · 行为与今日直连（chat-session kernel* 直呼）逐字节一致（D-3 理由 ①）；
//   · 测试 mock 面（tests/helpers/kernel-fs.ts 站到 rpc-contract 具名 helper 上）
//     零迁移——会话族测试 mock 命中的就是本 provider 走的同一层（D-3 理由 ②，
//     三命运黄金标准：换轨 commit 测试 diff 零 = 行为零漂移最强证据）。
// append/appendLog 从动作面删除（D-5——目标 RPC agent_session_append 零 TS
// 产线调用方）；agent_session_append RPC 本体留 Rust 不动（TS 死链标注，退役
// 另立——rpc-contract.ts:524-534）。

import type {
  SessionPersistAction,
  SessionPersistenceProvider,
} from '../../../composition/session-persistence-service';
import type { Context } from '../../../cordis';
import { kernelListDirectory, kernelReadFileRaw, kernelWriteFile } from './host';

/** 动作 → kernel* helper 的 args 组装。args 已是 snake_case RPC 参数直传
 *  （无腰设计）；helper 返回已解析路径/原文。消费方各自 parse（见 D-1：
 *  read_volume 返 JSON 串或 'null'；list_volumes 返文件名 JSON 数组——helper
 *  返回 DirEntry[]，本层把文件名抽出序列化，目录由 DirEntry.is_dir 滤掉）。 */
async function executeViaKernel(action: SessionPersistAction, args: Record<string, unknown>): Promise<string> {
  const root = String(args.root ?? '');
  const id = String(args.id ?? '');
  switch (action) {
    case 'read_volume': {
      try {
        return await kernelReadFileRaw(`${root}/${id}.json`);
      } catch {
        // 缺失/坏文件 = 卷不存在（readVolumeData 判空语义——与今日
        // readSessionJSONOrNull 同源；错误不静默在消费方 catch 面）
        return 'null';
      }
    }
    case 'list_volumes': {
      // provider 滤目录；保留 _active.json 不过滤（消费方各自 parse id /
      // 墓碑判别——scanMaxSessionId 与 listSavedSessions 现过滤 _active.json，
      // 语义在消费方保真，不在本层）。目录缺席由 fs 层返回空集（不抛——
      // 与 kernel-fs mock「read_dir Err → 空」同语义）；**真错误上抛**让消费方
      // catch 降级（restoreCanvasSpread 的「列表失败 = 不剪枝」保守语义依赖
      // 失败可见——吞成 [] 会把失败误判为空目录而误剪幽灵卷）。
      const entries = await kernelListDirectory(root, false);
      return JSON.stringify(entries.filter((e) => !e.is_dir).map((e) => e.name));
    }
    case 'save_volume': {
      await kernelWriteFile(`${root}/${id}.json`, String(args.data ?? ''));
      return 'null';
    }
    case 'delete_volume': {
      // 墓碑重写 deleted:true（D-2）——listSavedSessions 过滤契约与恢复剪枝
      // 消费方依赖此形态，行为字节不变；SQLite provider 可真删
      await kernelWriteFile(
        `${root}/${id}.json`,
        JSON.stringify({ id: Number(id), deleted: true, label: '', messages: [], savedAt: '' }),
      );
      return 'null';
    }
  }
}

/** 默认 Rust 会话持久化 provider（id 'builtin/rust-sessions'）。 */
export const builtinSessionsProvider: SessionPersistenceProvider = {
  id: 'builtin/rust-sessions',
  execute(action, args) {
    return executeViaKernel(action, args);
  },
};

/** builtin 会话持久化 provider 贡献插件（loader 表序：sessionPersistenceServicePlugin 之后）。 */
export const builtinSessionsPlugin = {
  name: 'hologram/sessions-builtin',
  inject: ['sessionPersistence'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.sessionPersistence.register(builtinSessionsProvider), 'sessions-builtin');
  },
};

export default builtinSessionsPlugin;
