// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// shell 粘性 cwd —— TS 编排层的落点截流（R3-d，kernel-capability-c3-design.md §9
// 裁定：粘性 cwd 是「编排记忆」，归 TS；Rust process_cap 只按方言包装命令，
// marker 字节原样流经 shell:output 事件/结果，本模块负责截流 + 归一 + 提交
// （session-context 的 per-owner stickyCwd 字段）。
//
// 动机（会话日志实证）：46.9% 的 run_shell 调用是 `cd X && cmd` 复合——模型在
// 手动模拟持久 shell。粘性 cwd 让 cd 的效果跨调用保持（按 agent 身份键控），
// 消灭这笔税。
//
// 语义（与退役前 Rust utils/sticky_cwd.rs 逐行为等价——自 sticky_cwd.rs 迁入）：
//   - 落点捕获：fg 命令被包装为 `<cmd>; printf '<START>%s<END>' "$PWD"`，
//     输出流里的 marker 被截留（不进结果/进度），提取真实落点更新粘性值
//   - 自愈：cd 失败 / 命令被杀 / 超时 / cmd 回退 → 无 marker → 粘性值不动
//   - 隔离：按 owner（bus id——_owner_id 回退 _agent_id）键控，多 Agent 互不影响；
//     注册表随 agent 拆卸重置（切工作区即重置，Rust 侧 generation 换代语义的
//     TS 对应物 = owner 行消失）
//   - 失效：粘性路径已不存在（被删）→ Rust process_cap 内跳过候选（自愈回退）
//
// 不覆盖：后台任务（长驻命令的落点对下一次调用意义小，且完成时机被动）。
//
// 模块级可变态：无（filter 是调用方持有的实例态；存储在 session-context）。

/** 粘性 cwd 标记 — OSC 序列（终端消费型，即使泄漏到 UI 也不可见）。
 *  与 Rust process_cap 的常量字节一致（包装在口内）。 */
export const CWD_MARKER_START = '\u001b]lantaicwd;';
export const CWD_MARKER_END = '\u0007';

// ── MSYS 路径规整 ──
// 捆绑 bash 的 $PWD 是 POSIX 风格（`/d/HoloGramHG/engine`），而 spawn 侧 /
// 回显需要 Windows 风格。只处理盘符挂载（绝对主流）；UNC `//server/...` 与
// 其他形态放弃（返回 null → 粘性不动，自愈）。
export function normalizeMsysPath(raw: string): string | null {
  const t = raw.trim();
  if (/^\/[a-zA-Z]/.test(t)) {
    const drive = t[1]?.toLowerCase();
    const rest = t.slice(2).replace(/^\/+/, '');
    if (!drive) return null;
    return rest === '' ? `${drive}:/` : `${drive}:/${rest}`;
  }
  // 已经是 Windows 风格（pwsh 捕获路径）— 原样接受
  if (t.length >= 2 && t[1] === ':') return t;
  return null;
}

/** 流式路径的跨 chunk marker 截流器（自 Rust sticky_cwd.rs CwdMarkerFilter 迁入）。
 *  逐块喂入已解码文本，返回应进结果/进度的干净增量 + 识别完成时的归一化落点
 *  （调用方据此提交粘性值）。marker 跨块分裂时挂起中间片段（下一块续判）。
 *  未识别的挂起片段在 flush 时原样放行（命令没走到 printf —— 粘性不动）。
 *  已提交过一次后放行后续一切（每次命令只有一个 marker；后续同形文本是命令
 *  自己的输出，不再截留）。 */
export class CwdMarkerFilter {
  private pending = '';
  private consumed = false;

  /** 喂入一块解码文本：干净输出 + 捕获的归一化落点（无 marker = null）。 */
  push(chunk: string): { clean: string; captured: string | null } {
    if (this.consumed) {
      return { clean: chunk, captured: null };
    }
    this.pending += chunk;
    const start = this.pending.indexOf(CWD_MARKER_START);
    if (start < 0) {
      // 无起点：若尾部是 START 的前缀（跨块分裂中），挂起尾段待续；否则全放行。
      const hold = longestSuffixIsPrefix(this.pending, CWD_MARKER_START);
      const keepFrom = this.pending.length - hold;
      const emit = this.pending.slice(0, keepFrom);
      this.pending = this.pending.slice(keepFrom);
      return { clean: emit, captured: null };
    }
    // 找到起点：起点之前的文本放行
    const before = this.pending.slice(0, start);
    const after = this.pending.slice(start + CWD_MARKER_START.length);
    const end = after.indexOf(CWD_MARKER_END);
    if (end >= 0) {
      const rawPath = after.slice(0, end);
      const captured = normalizeMsysPath(rawPath);
      const rest = after.slice(end + 1);
      this.pending = '';
      this.consumed = true;
      // marker 之后的余段随本块一起放行（consumed 后不再有挂起语义）
      return { clean: before + rest, captured };
    }
    // marker 未闭合：挂起起点之后的一切，放行起点之前的部分。
    // 若 after 已包含换行（路径不可能含换行），说明这是命令自己输出的伪 marker
    // 文本 → 连同换行放行，不再截留。
    const nl = after.indexOf('\n');
    if (nl >= 0) {
      const fakeEnd = CWD_MARKER_START.length + nl + 1;
      const emit = before + this.pending.slice(start, start + fakeEnd);
      this.pending = this.pending.slice(start + fakeEnd);
      return { clean: emit, captured: null };
    }
    // 挂起上限保护：路径不会超过 4KB；超过视为异常输出
    if (after.length > 4096) {
      const emit = this.pending;
      this.pending = '';
      this.consumed = true;
      return { clean: emit, captured: null };
    }
    this.pending = this.pending.slice(start);
    return { clean: before, captured: null };
  }

  /** 流结束：放行挂起的一切（无提交）。 */
  flush(): string {
    const out = this.pending;
    this.pending = '';
    return out;
  }
}

/** `text` 尾段是否为 `pattern` 的前缀（跨块分裂检测；返回挂起长度 0 = 不是）。 */
function longestSuffixIsPrefix(text: string, pattern: string): number {
  const max = Math.min(text.length, pattern.length);
  for (let hold = max; hold >= 1; hold--) {
    if (text.endsWith(pattern.slice(0, hold))) return hold;
  }
  return 0;
}
