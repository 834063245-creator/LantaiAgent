// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// folio-date — 卷首档行的**中文数字长日期**（案卷 register）。
//
// 规格源：prototype/lantai.html:490 卷首档行原文「二〇二六年八月廿二日 · 案卷 #12 · 8 块」
// ——卷首主日历用长日期（年月日全写、中文数字），与案卷首页 `.session-row .date`
// 的 `MM-DD`（app/SessionsHome.tsx formatSessionDate）是**两处不同 register**，
// 各有其规格源，勿合流。
//
// 落位：本文件在**插件目录内**（不是 src/paper/）——卷首档行的呈现文案是
// paper-shell 自己的事，不是纸面几何域原语；插件取宿主面必须走 './host'
// （产物构建按 host.aliased 换别名），本地模块免开新宿主面键、不动
// host-surface 基线指纹。将来若 app 层也要这份日历，再上提到共享层。
//
// 数字写法（古典案卷习惯）：
//   年 → 逐位直读（2026 = 二〇二六）
//   月 → 一…十 / 十一 / 十二
//   日 → 一…九 / 十…十九 / 二十 / 廿…廿九 / 三十 / 卅一
//
// 纯函数零依赖（同 paper/ 域其余纯函数的纪律：零 DOM、零 store）。

const DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

/** 年：逐位直读（不读作「二千零二十六」——案卷register用〇串）。 */
function year(n: number): string {
  return String(n)
    .split('')
    .map((c) => DIGITS[Number(c)] ?? c)
    .join('');
}

/** 月：1–12 的序数读法（十一 / 十二）。 */
function month(n: number): string {
  if (n <= 10) return n === 10 ? '十' : (DIGITS[n] ?? String(n));
  return `十${DIGITS[n - 10]}`;
}

/** 日：案卷register的古典写法——10–19 十X、20–29 廿X、30 三十、31 卅一。 */
function day(n: number): string {
  if (n <= 9) return DIGITS[n] ?? String(n);
  if (n === 10) return '十';
  if (n < 20) return `十${DIGITS[n - 10]}`;
  if (n === 20) return '二十';
  if (n < 30) return `廿${DIGITS[n - 20]}`;
  if (n === 30) return '三十';
  return `卅${DIGITS[n - 30]}`;
}

/** 档行日期：`二〇二六年八月廿二日`。
 *
 *  本地时区取年月日（卷首日期是**给人看的立卷日**，不是 UTC 时刻；跨时区
 *  读同一卷不应漂到隔天）。
 *  入参缺席 / 不可解析 → `''`（旧卷无 createdAt = 档行不显日期，不编造
 *  ——「错误不静默」在此表现为**不假装有日期**，而非抛错阻断卷首渲染）。 */
export function formatCNDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.getTime();
  if (!Number.isFinite(t)) return '';
  return `${year(d.getFullYear())}年${month(d.getMonth() + 1)}月${day(d.getDate())}日`;
}
