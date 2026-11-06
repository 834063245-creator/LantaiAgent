// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 已删卷的写拒绝名单（进程内，防死卷快照复活）
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

// ── 已删卷的写拒绝名单（内存，进程内）────────────────────────────────
//
// 病灶（2026-09-19「子卷卷名乱套」的**供给侧**）：`deleteSessionFile` 先 `delete_log`
// 真删两文件、后 `closeSession`，而合卷快照（C8）是 **fire-and-forget 的写链任务**
// ⇒ 已删卷的 `{id}.json` 被写回盘上，成为一份「死卷快照」（本机实测：`10.json` 的
// `savedAt` 恰是删除那一刻，比新卷 `13.ndjson` 的立卷时刻早 14 秒）。防抖自动存
// （`scheduleAutoSave`）在途时同理。
//
// 盘上墓碑（`deleted:true`）已随 Phase 3b 退役——「文件不在 = 卷不存在」；这里挡的是
// **同一进程内的在途写**，不是又立一套持久语义。键 = `{root}/{id}`：进程内发号单调
// （`nextSessionId` 只增不减，各恢复路径都取 max）⇒ 同号不会被新卷复用，名单不会误伤；
// **跨进程**的残留（旧格式化石 / 上次运行的删除竞态）由读面同代校验
// （`cacheOfThisVolume`）兜住——两侧合起来才是完整的「死卷不得冒充新卷」。
const _removedVolumes = new Set<string>();

function volumeKey(root: string, id: number): string {
  return `${root}/${id}`;
}

/** 该卷是否已被本进程删除（写面据此拒绝快照写）。 */
export function isVolumeRemoved(root: string, id: number): boolean {
  return _removedVolumes.has(volumeKey(root, id));
}

/** 登记「这一卷已删」（真删文件之前）——在途写链/防抖自动存据此拒绝写回。 */
export function markVolumeRemoved(root: string, id: number): void {
  _removedVolumes.add(volumeKey(root, id));
}

/** 撤销登记（真删失败 = 卷还在，写面必须继续工作）。 */
export function unmarkVolumeRemoved(root: string, id: number): void {
  _removedVolumes.delete(volumeKey(root, id));
}

/** 清空名单（跨用例隔离）。 */
export function resetVolumeGuardForTests(): void {
  _removedVolumes.clear();
}
