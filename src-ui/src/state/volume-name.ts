// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷名（案卷题名）的**唯一派生面**（2026-09-18 命名收口）。
//
// 形状：卷名 = **一个字段**（`ChatSessionMeta.label`，落盘 = 卷快照 `<id>.json` 的
// `label`）。**空 = 未命名**——数字名不再是写入值，只是显示兜底，且一律取**档号**。
//
// 收口前的病灶（三处各写一份、已经漂移过一次）：
//   · 起卷把**序数**写进 label（`案卷 ${sessions.length + 1}`）——合卷 splice 数组后
//     再起一卷会与在案卷撞名，与 D3 拍板的「案卷 N = 工作区内编号（档号）」也不一致；
//   · 读面兜底用**档号**（`案卷 ${id}`）——同一个「案卷 3」在两处指的不是同一个数；
//   · 判「这是不是默认名」有两把尺子：活路径严（`/^(?:会话|案卷) \d+$/`）、读盘路径松
//     （凡以「案卷 」开头即打回）——手起的名字在内存里活着、重开就没了。
//
// 三条纪律（新增用名场景一律经本文件，禁在调用点手写）：
//   ① 显示走 `volumeDisplayName`（禁 `label || \`案卷 ${id}\`` 散写）；
//   ② 「是否未命名」只有一把尺子 `isUnnamedVolumeLabel`（活路径与读盘路径同用）；
//   ③ 首条来文派生只有一处实现 `deriveVolumeLabel`。

/** 卷名派生用的省略号（28 字截断标记）。 */
export const VOLUME_LABEL_MAX_CHARS = 28;

/** 旧存档遗留的默认名（历史**写入值**）——识别为「未命名」，不是用户起的名。
 *  旧实现：起卷写「案卷 N」（更早「会话 N」）。 */
const LEGACY_DEFAULT_LABEL = /^(?:会话|案卷)\s*\d*$/;

/** 恢复路径写过的两枚占位名（同为「未命名」）。 */
const LEGACY_PLACEHOLDER_LABELS: ReadonlySet<string> = new Set(['已恢复的会话', '已恢复的案卷']);

/** 卷是否未命名（名字缺失）——空串与旧默认名同判。 */
export function isUnnamedVolumeLabel(label: string | null | undefined): boolean {
  const name = label?.trim() ?? '';
  return name === '' || LEGACY_DEFAULT_LABEL.test(name) || LEGACY_PLACEHOLDER_LABELS.has(name);
}

/** 卷的**显示名**：有名卷直采；无名卷 = 「案卷 N」档号兜底（与卷首眉行
 *  「案卷 Nº N」同源——数字在卷首恰出现一次的口径靠这里统一）。
 *  **旧存档遗留的默认名同判未命名**（`案卷 3` 显示为「案卷 <档号>」）：否则一个
 *  序数默认名会顶着一个与档号不符的数字冒充名字——正是收口前那个「两个源」的观感。 */
export function volumeDisplayName(label: string | null | undefined, id: number): string {
  const name = label?.trim() ?? '';
  return isUnnamedVolumeLabel(name) ? `案卷 ${id}` : name;
}

/** 首条来文 → 卷名（前 28 字 + 省略号）。活路径（每轮末）与读盘路径共用同一实现。 */
export function deriveVolumeLabel(firstUserText: string): string {
  const text = firstUserText.trim();
  return text.slice(0, VOLUME_LABEL_MAX_CHARS) + (text.length > VOLUME_LABEL_MAX_CHARS ? '…' : '');
}
