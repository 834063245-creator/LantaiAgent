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
import {
  kernelAppendFileDurable,
  kernelDeleteFile,
  kernelListDirectory,
  kernelReadFileRaw,
  kernelTruncateFile,
  kernelWriteFile,
} from './host';

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
    case 'delete_log': {
      // 卷真删（Phase 3b 权威翻转）：事件日志 + UI 投影缓存一并删除。墓碑语义
      // 退役——「文件不在 = 卷不存在」（缺日志即判空），不再写 deleted:true 占位。
      // **日志删不掉必须上抛**（2026-09-18 会话树「枝」P2 连坐删除）：吞掉就是
      // 「报成功而卷还在」——侧栏说「已删」、下次清点它又冒出来（宪法「错误不
      // 静默」+ CONVENTIONS §2.2「写入/持久化错误必须传播或 warn」）。投影缓存
      // 缺失是常态（空卷不落盘），故 `.json` 照旧容忍。
      await kernelDeleteFile(`${root}/${id}.ndjson`);
      await kernelDeleteFile(`${root}/${id}.json`).catch(() => '');
      return 'null';
    }
    case 'append_events': {
      // 事件日志追加（DSH 参照移植 Phase 1）：durable=true → append + fsync，
      // 返回即已落盘（检查点「排空队列」的天花板语义靠它成立）。
      // 头行是否随本批写入由 TS 侧（写作面 materialized 标志）决定——
      // provider 无隐藏状态，只落给定字节（DSH appendBatch(isMaterialized) 同形）。
      await kernelAppendFileDurable(`${root}/${id}.ndjson`, String(args.data ?? ''));
      return 'null';
    }
    case 'read_log': {
      // 事件日志读取：缺失/不可读 = 空串（不抛——「没有日志」是首启常态，
      // 与 read_volume 的 'null' 判空语义同族）。
      try {
        return await kernelReadFileRaw(`${root}/${id}.ndjson`);
      } catch {
        return '';
      }
    }
    case 'write_log': {
      // 整体物化（首批：头行 + 当时全部事件）——原子替换写（tmp→rename），
      // 崩溃不会留下「已物化但空」的会话。
      await kernelWriteFile(`${root}/${id}.ndjson`, String(args.data ?? ''));
      return 'null';
    }
    case 'truncate_log': {
      // 断尾修复（Phase 2）：截到扫描器给的 committedBytes 并 fsync。
      await kernelTruncateFile(`${root}/${id}.ndjson`, Number(args.offset ?? 0));
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
