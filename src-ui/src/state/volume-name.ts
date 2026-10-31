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
//
// 2026-10-31（卷名自动命名 A 批，docs/plans/volume-naming-plan.md）：派生先**清洗**再截断。
// 病因实测：`trim().slice(0, 28)` 两处失真——① 多行来文的换行原样进卷名，而卷首题字按
// pre-wrap 实测行数（paper-shell/measure.ts `measureTextHeight`），一个 `\n` 就把卷级几何
// 撑高、窗口标题也跟着换行；② `slice` 按 UTF-16 单元，第 28 位碰上 emoji 会劈开代理对。
// **字面量仍是 28 个字符（不是显示宽度）**：中文是本产品主语言，按宽计（CJK 2）会把中文
// 卷名拦腰砍成 14 字——那是可见回归，不做。

/** 卷名派生用的省略号（28 字截断标记）。 */
export const VOLUME_LABEL_MAX_CHARS = 28;

/** 卷名来源（**内存态**，不进卷快照）：`user` = 人手起的名，任何自动命名不得覆盖；
 *  `derived` = 本进程内由首条来文自动派生（可被后续自动概括覆盖，B 批消费）；
 *  缺失 = 来源未知（旧卷 / 读盘卷）——一律按 `user` 对待（宁可不改，不可误改）。
 *  归属：CONVENTIONS §1.10 第 1 类（挂在面板级 session store 的字段上，无模块级态）。 */
export type VolumeLabelSource = 'derived' | 'user';

/** 旧存档遗留的默认名（历史**写入值**）——识别为「未命名」，不是用户起的名。
 *  旧实现：起卷写「案卷 N」（更早「会话 N」）。 */
const LEGACY_DEFAULT_LABEL = /^(?:会话|案卷)\s*\d*$/;

/** 恢复路径写过的两枚占位名（同为「未命名」）。 */
const LEGACY_PLACEHOLDER_LABELS: ReadonlySet<string> = new Set(['已恢复的会话', '已恢复的案卷']);

/** 除 \t \n \r 外的 C0/C1 控制符（换行交给空白折叠统一处理）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 本模块职责就是剔除控制符——范围字面量即规格（先例 src/paper/tool-text.ts）
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** 方向与不可见控制字符：能让显示的卷名与数据不一致（RTL 覆写 / 零宽）。 */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/** 行首排版壳：代码围栏 / 标题井号 / 引用 / 列表符号（含有序列表）。 */
const LEADING_MARKUP = /^(?:`{3,}[\w-]*|~{3,}[\w-]*|#{1,6}(?=\s)|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)\s*/u;

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

/** 剥掉行首累积的排版壳（`# - ` 这类叠用最多剥四层——防死循环，不做无限剥）。 */
function stripLeadingMarkup(text: string): string {
  let out = text;
  for (let depth = 0; depth < 4; depth += 1) {
    const next = out.replace(LEADING_MARKUP, '').trimStart();
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 来文 → 一行干净文本：去控制符、折叠所有空白（含换行）、剥行首排版壳。 */
function cleanVolumeLabelText(raw: string): string {
  const collapsed = raw.replace(CONTROL_CHARACTER, ' ').replace(DIRECTIONAL_CONTROL, '').replace(/\s+/gu, ' ').trim();
  return stripLeadingMarkup(collapsed);
}

/** 按 **code point** 截断（代理对不会被劈开），超限补省略号。 */
function truncateVolumeLabel(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

/** 首条来文 → 卷名（清洗后前 28 字 + 省略号）。活路径（发送时 / 每轮末）与读盘路径共用。 */
export function deriveVolumeLabel(firstUserText: string): string {
  return truncateVolumeLabel(cleanVolumeLabelText(firstUserText), VOLUME_LABEL_MAX_CHARS);
}
