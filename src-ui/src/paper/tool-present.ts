// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/tool-present — 工具卡「语义投影层」（2026-10-29；用户报「聊天流里所有工具卡片
// 返回的内容，除了 asset 类几乎都不是给人看的，更像某种原始的格式化输入输出直接渲染」）。
//
// 与上一轮可读性专项（2026-09-14，paper/tool-text）的分界：那一轮解决**排版**（ANSI
// 转义 / JSON 双重转义 / 单行巨串 break-all 腰斩）；这一轮是**内容语义**——载荷的形状
// 本身是给程序看的协议面。两类病灶（真机载荷取自 .lantai/sessions/*.ndjson）：
//   ① 参数面把协议键与全文载荷当内容：`fs(edit)` 倾出整段 oldString/newString，而正文
//      紧跟着的 diff 已把同一份内容再打一遍（一次改动卡里同一段文本出现三次）；
//      `fs(write)` 把整份文件以转义 JSON 串倾出（真机 5865 字符）；`shell(run)` 的
//      `{"action":"run","command":"…"}`——action 早已在文类签上。
//   ② 结果面把结构化 JSON 直出：`git(status)` 的 {branch,ahead,behind,files:[{path,
//      status,staged}]}、`fs(list)` 的 44KB {entries:[{children,is_dir,name,path}]}
//      （path 还是 `\\?\D:\…` 扩展前缀）、`search(content)` 的 {results:[{file,
//      match_line,match_content,context_block:[{line,content,is_match}]}]}。
//      键名、布尔、转义路径全是程序语汇，人读到的是「格式」不是「事」。
//
// 裁定（施工单 .lantai/plans/plan-1793253129747-xi5o.md）：做**纯变换**，不做每工具一套
// React 组件。理由：纸面测高（paper-shell/measure.ts）按**文本行**算——任何新 DOM 结构
// 都要在 measure 里补一套等价测高模型（第二真源），而纸面的折叠/钉住/墨迹/虚拟化全挂在
// 同一套几何上。只要投影仍产出 ToolDisplay（text + lines），渲染/测量/墨迹天然同源。
//
// 纪律（违反即返工）：
//   ① **模型面零改动**——只读 payload 的 name/args/output/err 字符串，不碰工具返回值；
//   ② **解析不了就交回兜底**（toolDisplay 的通用结构化打印）：永不空、永不炸；
//   ③ **不静默丢信息**——presenter 解析到的语义字段必须全部浮现，未消费的键收成
//      「其余：k=v」一行；整体形状不认识 ⇒ 该段回落兜底（原文照旧读得到）；
//   ④ **文本是唯一量**——一律经 toolDisplayFromLines / 纯文本出口，不自拼 text，
//      否则测高与渲染漂移（镜像纪律见 paper/tool-text 头注）。

import { resolveSemanticToolName } from '../ui/tool-semantics';
import {
  diffLine,
  hasArgsToShow,
  hasPayloadToShow,
  sanitizePayloadText,
  type ToolDisplay,
  type ToolLine,
  type ToolSpan,
  type ToolTone,
  toolDisplay,
  toolDisplayFromLines,
} from './tool-text';

/* ── 契约 ── */

/** 语义名（= agent/tools/domains.ts 的旧工具名真源，经 resolveSemanticToolName 归一）。 */
type ArgsPresenter = (args: Record<string, unknown> | null) => ToolDisplay | null;
type ResultPresenter = (output: string | undefined, args: Record<string, unknown> | null) => PresentedSection[] | null;
type SummaryPresenter = (output: string | undefined, args: Record<string, unknown> | null) => string | null;

/** presenter 产出的段（段头文案 + 展示模型 + 视觉档）。
 *  variant 同时决定 CSS 类与测高字体档（args ⇒ PAPER_TOOL_FONT/PRE_MAX_H，
 *  其余 ⇒ PAPER_OUT_FONT/OUT_MAX_H——measure.ts 按此取档，渲染端按此取 class）。 */
export interface PresentedSection {
  label: string;
  display: ToolDisplay;
  variant?: 'out' | 'result' | 'err';
}

/** 工具卡的一段（渲染/测量/墨迹共用的唯一形状）。 */
export interface ToolSection {
  kind: 'args' | 'out' | 'err';
  /** 段头（人话：命令 / 读取 / 改动 / 命中 / 工作区…）。 */
  label: string;
  display: ToolDisplay;
  variant: 'args' | 'out' | 'result' | 'err';
}

export interface ToolPresentation {
  /** 段序即渲染序（参数 → 结果 → 错误；presenter 可给出多段结果）。 */
  sections: ToolSection[];
  /** 折叠行读数（「9 处 · 1 文件」「17 个改动」「42 行」）——空则回落字数读数。 */
  summary?: string;
}

/** 工具块载荷（与 paper/block-model 的 tool payload 同形，只取投影要用的字段）。 */
export interface ToolPayload {
  name?: string;
  args?: string;
  output?: string;
  err?: string;
}

interface Presenter {
  /** 参数面：函数 = 语义投影；`false` = 该动作没有值得看的参数（不展示、也不兜底——
   *  避免 `{"action":"status"}` 这类纯协议骨架冒充内容）。 */
  args?: ArgsPresenter | false;
  argsLabel?: string;
  result?: ResultPresenter;
  summary?: SummaryPresenter;
}

/* ── 展示行构造器（行/片段的字面工具，不自拼 text） ── */

const sp = (text: string, tone: ToolTone = 'plain'): ToolSpan => ({ text, tone });

const tl = (level: number, parts: ToolSpan[], marker = false): ToolLine =>
  marker ? { level, parts, marker } : { level, parts };

/* ── 通用助手 ── */

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function arrOf(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function tryJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseArgsObj(argsJson?: string): Record<string, unknown> | null {
  return rec(tryJson(argsJson));
}

/** 参数取字符串（首个非空）。 */
function str(a: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** 参数取数值（数字或数字串）。 */
function num(a: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!a) return undefined;
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/** Windows 扩展路径剥壳 + 反斜杠归一：`\\?\D:\ws\a.md` → `D:/ws/a.md`。
 *  只用于**已知是路径**的槽位（presenter 内），绝不改写正文。 */
export function tidyPath(p: string): string {
  let s = p.trim();
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  return s.replace(/\\/g, '/');
}

/** 一组路径的最长公共目录前缀（含尾 `/`）；不足两级返回空串。
 *  列表族据此显示「仓库内相对路径」而不是整条 `D:/…` 前缀。 */
function commonRoot(paths: readonly string[]): string {
  if (paths.length < 2) return '';
  const split = paths.map((p) => tidyPath(p).split('/'));
  const first = split[0];
  const limit = first.length - 1; // 不吞掉文件名本身
  let i = 0;
  while (i < limit) {
    const seg = first[i];
    if (!split.every((s) => s.length > i + 1 && s[i] === seg)) break;
    i += 1;
  }
  return i === 0 ? '' : `${first.slice(0, i).join('/')}/`;
}

function relativizer(paths: readonly string[]): (p: string) => string {
  const root = commonRoot(paths);
  if (!root) return tidyPath;
  return (p) => {
    const t = tidyPath(p);
    return t.startsWith(root) ? t.slice(root.length) : t;
  };
}

/** 行数（末尾换行不计一行）。 */
function countLines(s: string): number {
  if (!s) return 0;
  const body = s.endsWith('\n') ? s.slice(0, -1) : s;
  if (!body) return 1;
  return body.split('\n').length;
}

/** 残留键的值摘要（不静默丢信息的兜底行）。 */
function briefValue(v: unknown): string {
  if (typeof v === 'string') {
    const one = v.replace(/\s+/g, ' ').trim();
    return one.length > 40 ? `${one.slice(0, 40)}…` : one;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  const arr = arrOf(v);
  if (arr) return `[${arr.length} 项]`;
  if (rec(v)) return '{…}';
  return typeof v;
}

/** 参数残留键（presenter 未消费的键收成一行）。`_` 前缀是 executor 注入的 meta
 *  （_forceGate / _callId / _agent_id），不是模型意图，不算残留。 */
function residualSpans(a: Record<string, unknown> | null, consumed: readonly string[]): ToolSpan[] | null {
  if (!a) return null;
  const keys = Object.keys(a).filter((k) => !k.startsWith('_') && !consumed.includes(k));
  if (keys.length === 0) return null;
  const parts: ToolSpan[] = [sp('其余：', 'note')];
  keys.forEach((k, i) => {
    if (i > 0) parts.push(sp(' · ', 'punct'));
    parts.push(sp(k, 'key'), sp('=', 'punct'), sp(briefValue(a[k]), 'str'));
  });
  return parts;
}

/** 单行「路径 · 读数」形态（参数面最常见的一种）：路径实墨 + 读数注记。 */
function handleLine(path: string, notes: string[]): ToolLine {
  const parts: ToolSpan[] = [sp(tidyPath(path), 'str')];
  for (const n of notes) parts.push(sp(` · ${n}`, 'note'));
  return tl(0, parts);
}

/** 去掉尾部空行（工具输出常以换行收尾，不该多一行空行）。 */
function trimTailBlank(lines: ToolLine[]): ToolLine[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].parts.length === 0) end -= 1;
  return lines.slice(0, end);
}

/* ── shell 域 ── */

const SHELL_KNOWN = ['action', 'command', 'cwd', 'runInBackground', 'timeoutMs', 'jobId'];
const SHELL_DONE_RE = /^\[任务已完成, exit code: (-?\d+), 耗时: (\d+)s\]$/;
const SHELL_RUNNING_RE = /^\[任务运行中, 已运行: (\d+)s\]$/;
const CWD_FOOT_RE = /^\[cwd: (.+)\]$/;

/** 命令面：`$ <命令>`（原样、不转义）。多行命令逐行续排（level 1）。
 *  这是人看命令的唯一天然形态——`{"action":"run","command":"…"}` 只是把同一串
 *  塞进 JSON 再配一个卡片上已有的 action 键。 */
function shellArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const lines: ToolLine[] = [];
  const command = str(a, 'command');
  if (command) {
    const cmd = sanitizePayloadText(command).split('\n');
    lines.push(tl(0, [sp('$ ', 'punct'), sp(cmd[0] ?? '')]));
    for (const rest of cmd.slice(1)) lines.push(tl(1, [sp(rest)]));
    if (a?.runInBackground === true) lines.push(tl(0, [sp('后台运行', 'note')]));
    const timeout = num(a, 'timeoutMs');
    if (timeout !== undefined) lines.push(tl(0, [sp(`超时 ${Math.round(timeout / 1000)}s`, 'note')]));
  } else {
    const job = num(a, 'jobId');
    if (job === undefined) return null; // 既无命令也无任务号：交回兜底
    lines.push(tl(0, [sp('任务 #', 'key'), sp(String(job), 'num')]));
    const timeout = num(a, 'timeoutMs');
    if (timeout !== undefined) lines.push(tl(0, [sp(`最多等 ${Math.round(timeout / 1000)}s`, 'note')]));
  }
  const cwd = str(a, 'cwd');
  if (cwd) lines.push(tl(0, [sp('cwd ', 'key'), sp(tidyPath(cwd))]));
  const rest = residualSpans(a, SHELL_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

/** 输出面：stdout 正文 + 读数行（exit code / 耗时 / cwd）。
 *  读数行此前混在正文第一行（`[任务已完成, exit code: 0, 耗时: 110s]`）或末行
 *  （`[cwd: X]`）里，读起来像输出的一部分；提成文末带 `· ` 标记的读数行后，
 *  「正文是命令说的话、读数是执行的事实」两件事分开。 */
function shellResult(output: string | undefined): PresentedSection[] | null {
  if (!hasPayloadToShow(output)) return null;
  const body: ToolLine[] = [];
  const feet: ToolSpan[][] = [];
  for (const raw of sanitizePayloadText(output ?? '').split('\n')) {
    const t = raw.trim();
    const done = SHELL_DONE_RE.exec(t);
    if (done) {
      feet.push([sp(`exit ${done[1]}`, 'key'), sp(` · ${done[2]}s`, 'note')]);
      continue;
    }
    const running = SHELL_RUNNING_RE.exec(t);
    if (running) {
      feet.push([sp(`运行中 · 已 ${running[1]}s`, 'note')]);
      continue;
    }
    const cwd = CWD_FOOT_RE.exec(t);
    if (cwd) {
      feet.push([sp('cwd ', 'key'), sp(tidyPath(cwd[1]), 'note')]);
      continue;
    }
    body.push(tl(0, raw ? [sp(raw)] : []));
  }
  const lines = [...trimTailBlank(body), ...feet.map((f) => tl(0, f, true))];
  if (lines.length === 0) return null;
  return [{ label: '输出', display: toolDisplayFromLines(lines) }];
}

function shellSummary(output: string | undefined): string | null {
  const clean = sanitizePayloadText(output ?? '');
  const rows = clean.split('\n');
  const first = rows[0]?.trim() ?? '';
  const done = SHELL_DONE_RE.exec(first);
  if (done) return `exit ${done[1]}${done[1] === '0' ? '' : '（失败）'} · ${done[2]}s`;
  const running = SHELL_RUNNING_RE.exec(first);
  if (running) return `运行中 ${running[1]}s`;
  // 前台 run：正文行数就是「这次命令说了多少」（cwd 回显行不算内容）
  const trimmed = [...rows];
  while (trimmed.length > 0 && !(trimmed[trimmed.length - 1] ?? '').trim()) trimmed.pop();
  const last = trimmed[trimmed.length - 1]?.trim() ?? '';
  const body = CWD_FOOT_RE.test(last) ? trimmed.slice(0, -1).join('\n') : trimmed.join('\n');
  const n = countLines(body);
  return n > 0 ? `${n} 行` : null;
}

/* ── fs 域 ── */

const FS_READ_KNOWN = ['action', 'path', 'filePath', 'offset', 'limit', 'lineNumbers', 'raw'];
const FS_WRITE_KNOWN = ['action', 'path', 'filePath', 'content'];
const FS_EDIT_KNOWN = ['action', 'path', 'filePath', 'oldString', 'newString', 'replaceAll'];
const FS_LIST_KNOWN = ['action', 'path', 'filePath', 'filterIgnored', 'filter_ignored'];
const FS_GLOB_KNOWN = ['action', 'pattern', 'path', 'dir', 'directory', 'filterIgnored'];
const FILE_FOOT_RE = /^\[file: (.+)\]$/;

/** 只有目标路径值得看的动作（list/move/delete 一类）：一行路径，残留键兜底。 */
function pathArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const path = str(a, 'path', 'filePath');
  if (!path) return null;
  const lines = [handleLine(path, [])];
  const rest = residualSpans(a, FS_LIST_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

/** glob 的参数面（`<pattern> · in <dir>`）：pattern 是判别字段，dir 是范围。 */
function globArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const pattern = str(a, 'pattern');
  if (!pattern) return null;
  const parts: ToolSpan[] = [sp(pattern, 'str')];
  const dir = str(a, 'dir', 'path', 'directory');
  if (dir) parts.push(sp(` · in ${tidyPath(dir)}`, 'note'));
  const lines = [tl(0, parts)];
  const rest = residualSpans(a, FS_GLOB_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

/** 读：`<路径> · 第 86–165 行`（offset 是跳过行数，0 基——confined_fs::format_lines）。 */
function readArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const path = str(a, 'path', 'filePath');
  if (!path) return null;
  const notes: string[] = [];
  const offset = num(a, 'offset');
  const limit = num(a, 'limit');
  if (offset !== undefined || limit !== undefined) {
    const start = (offset ?? 0) + 1;
    const end = limit !== undefined ? start + limit - 1 : undefined;
    notes.push(end !== undefined ? `第 ${start}–${end} 行` : `从第 ${start} 行起`);
  }
  if (a?.lineNumbers === true) notes.push('带行号');
  const lines = [handleLine(path, notes)];
  const rest = residualSpans(a, FS_READ_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

/** 读的结果：文件正文。文末 `[file: X]` 是模型面的落点回显——参数面已给路径时收掉
 *  （同一路径两遍是噪音）；参数面没给路径时（焦点回填）它是唯一落点，保留成读数行。 */
function readResult(output: string | undefined, a: Record<string, unknown> | null): PresentedSection[] | null {
  if (!hasPayloadToShow(output)) return null;
  const lines = sanitizePayloadText(output ?? '').split('\n');
  let landed: string | null = null;
  const last = lines[lines.length - 1];
  const foot = last ? FILE_FOOT_RE.exec(last.trim()) : null;
  if (foot) {
    landed = foot[1];
    lines.pop();
  }
  const body = trimTailBlank(lines.map((l) => tl(0, l ? [sp(l)] : [])));
  if (landed && !str(a, 'path', 'filePath')) {
    body.push(tl(0, [sp('落点 ', 'key'), sp(tidyPath(landed), 'note')], true));
  }
  if (body.length === 0) return null;
  return [{ label: '内容', display: toolDisplayFromLines(body) }];
}

function readSummary(output: string | undefined): string | null {
  const n = countLines(sanitizePayloadText(output ?? '').replace(/\n\[file: [^\]]*\]\s*$/, ''));
  return n > 0 ? `${n} 行` : null;
}

/** 写：`<路径> · 96 行 / 5865 字符`——**不再倾出 content 全文**
 *  （真机 5865 字符的转义 JSON 串是这张卡此前的主体）。 */
function writeArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const path = str(a, 'path', 'filePath');
  if (!path) return null;
  const content = typeof a?.content === 'string' ? a.content : '';
  const notes: string[] = [];
  if (content) notes.push(`${countLines(content)} 行 / ${content.length} 字符`);
  const lines = [handleLine(path, notes)];
  const rest = residualSpans(a, FS_WRITE_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

const FS_WRITE_ECHO_RE = /^\[fs\] 本次入参 (\d+) 行 \/ (\d+) 字符/;

/** 写的回执：`已写入 <路径>`（+ 入参读数，仅当参数面没带内容时——带了就在参数面
 *  那一行，不重打一遍）。原文是 `{"path":"…"}` + 一句给模型的嘱咐
 *  （「要确认盘上内容用 fs(read)」）——嘱咐是模型面契约，不是给人看的读数。 */
function writeResult(output: string | undefined, a: Record<string, unknown> | null): PresentedSection[] | null {
  if (!hasPayloadToShow(output)) return null;
  let path: string | null = null;
  let reading: string | null = null;
  for (const line of sanitizePayloadText(output ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('{')) {
      const parsed = rec(tryJson(t));
      const p = parsed?.path;
      if (typeof p === 'string') path = p;
      continue;
    }
    const echo = FS_WRITE_ECHO_RE.exec(t);
    if (echo) reading = `${echo[1]} 行 / ${echo[2]} 字符（入参读数）`;
  }
  if (!path) return null;
  const parts: ToolSpan[] = [sp('已写入 ', 'note'), sp(tidyPath(path), 'str')];
  const argsHadContent = typeof a?.content === 'string' && a.content.length > 0;
  if (reading && !argsHadContent) parts.push(sp(` · ${reading}`, 'note'));
  return [{ label: '回执', display: toolDisplayFromLines([tl(0, parts)]), variant: 'result' }];
}

function writeSummary(_output: string | undefined, a: Record<string, unknown> | null): string | null {
  const content = typeof a?.content === 'string' ? a.content : '';
  return content ? `${countLines(content)} 行` : null;
}

/** 改：`<路径> · 12 行 → 20 行`——**不再倾出 oldString/newString 全文**
 *  （正文的 diff 段已把同一份内容再打一遍）。 */
function editArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const path = str(a, 'path', 'filePath');
  if (!path) return null;
  const notes: string[] = [];
  if (a?.replaceAll === true) notes.push('替换全部匹配');
  const oldS = typeof a?.oldString === 'string' ? a.oldString : '';
  const newS = typeof a?.newString === 'string' ? a.newString : '';
  if (oldS || newS) notes.push(`${countLines(oldS)} 行 → ${countLines(newS)} 行`);
  const lines = [handleLine(path, notes)];
  const rest = residualSpans(a, FS_EDIT_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

const FS_EDIT_HEAD_RE = /^已替换 (\d+) 处匹配\s*[—-]\s*(.+?)(?:\s*\(第 (\d+) 行附近\))?$/;

/** 改的结果：一句结论（`已替换 1 处 · index.rs:31`）+ 差分正文（着色）。
 *  原文是结论行 + **字面 ```diff 围栏**（工具卡不走 markdown → 围栏当正文读，
 *  三个反引号就挂在纸上）+ 文末 `[file: X]`。 */
function editResult(output: string | undefined, a: Record<string, unknown> | null): PresentedSection[] | null {
  if (!hasPayloadToShow(output)) return null;
  const lines = sanitizePayloadText(output ?? '').split('\n');
  const head: ToolSpan[] = [];
  const diff: ToolLine[] = [];
  let inFence = false;
  let matched = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith('```')) {
      inFence = !inFence;
      matched = true;
      continue;
    }
    if (inFence) {
      diff.push(diffLine(raw));
      continue;
    }
    const foot = FILE_FOOT_RE.exec(t);
    if (foot) continue; // 落点已在参数面
    const m = FS_EDIT_HEAD_RE.exec(t);
    if (m) {
      // 路径：参数面已有 → 只留文件名（同一路径不再打两遍），并压成 `文件:行`
      const target = str(a, 'path', 'filePath') ? tidyPath(m[2]).split('/').pop() : tidyPath(m[2]);
      const where = m[3] ? `${target ?? ''}:${m[3]}` : (target ?? '');
      head.push(sp(`已替换 ${m[1]} 处`, 'str'));
      if (where) head.push(sp(` · ${where}`, 'note'));
      matched = true;
      continue;
    }
    if (t) head.push(sp(t, 'note'));
  }
  const out: ToolLine[] = [];
  if (head.length) out.push(tl(0, head));
  out.push(...diff);
  if (!matched && diff.length === 0) return null;
  return [{ label: '改动', display: toolDisplayFromLines(out), variant: 'result' }];
}

function editSummary(output: string | undefined): string | null {
  const clean = sanitizePayloadText(output ?? '');
  let add = 0;
  let del = 0;
  for (const raw of clean.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) add += 1;
    else if (raw.startsWith('-')) del += 1;
  }
  if (add === 0 && del === 0) return null;
  return `+${add} −${del}`;
}

/** 目录树：`dir/`（N 项）+ 缩进子项。名字来自 entry.name（不秀 `\\?\` 全路径）。 */
function listResult(output: string | undefined): PresentedSection[] | null {
  const parsed = rec(tryJson(output));
  const entries = arrOf(parsed?.entries);
  if (!entries) return null;
  const lines: ToolLine[] = [];
  const walk = (items: unknown[], level: number, depth: number): void => {
    if (depth > 12) return; // 深链防御（渲染与测高都按行，不炸栈）
    for (const item of items) {
      const e = rec(item);
      if (!e) continue;
      const name = typeof e.name === 'string' ? e.name : '';
      const children = arrOf(e.children);
      if (e.is_dir === true) {
        const parts: ToolSpan[] = [sp(`${name}/`, 'key')];
        if (children?.length) parts.push(sp(` ${children.length} 项`, 'note'));
        lines.push(tl(level, parts));
        if (children?.length) walk(children, level + 1, depth + 1);
      } else {
        lines.push(tl(level, [sp(name)]));
      }
    }
  };
  walk(entries, 0, 0);
  if (lines.length === 0) return null;
  return [{ label: '结构', display: toolDisplayFromLines(lines) }];
}

/** 目录读数：条目总数（顶层目录 + 其下文件各算一项——「这棵树有多大」）。 */
function listSummary(output: string | undefined): string | null {
  const entries = arrOf(rec(tryJson(output))?.entries);
  if (!entries) return null;
  let n = 0;
  const walk = (items: unknown[], depth: number): void => {
    if (depth > 12) return;
    for (const item of items) {
      n += 1;
      const children = arrOf(rec(item)?.children);
      if (children?.length) walk(children, depth + 1);
    }
  };
  walk(entries, 0);
  return n > 0 ? `${n} 项` : null;
}

/** glob：`共 N 个文件` + 一行一文件（按公共根显示相对路径）。 */
function globResult(output: string | undefined): PresentedSection[] | null {
  const parsed = rec(tryJson(output));
  const results = arrOf(parsed?.results);
  if (!results) return null;
  const paths = results.filter((x): x is string => typeof x === 'string');
  const rel = relativizer(paths);
  const count = typeof parsed?.count === 'number' ? parsed.count : paths.length;
  const head: ToolSpan[] = [sp(`共 ${count} 个文件`, 'note')];
  if (parsed?.truncated === true) head.push(sp(' · 已截断', 'note'));
  const lines: ToolLine[] = [tl(0, head)];
  for (const p of paths) lines.push(tl(0, [sp(rel(p), 'str')]));
  return [{ label: '文件', display: toolDisplayFromLines(lines) }];
}

function globSummary(output: string | undefined): string | null {
  const parsed = rec(tryJson(output));
  return typeof parsed?.count === 'number' ? `${parsed.count} 个文件` : null;
}

/* ── search 域 ── */

const SEARCH_KNOWN = [
  'action',
  'pattern',
  'path',
  'directory',
  'useRegex',
  'caseSensitive',
  'contextLines',
  'headLimit',
  'maxResults',
  'outputMode',
  'fileTypes',
  'globFilter',
];

/** 检索面：`/pattern/ · 范围 · regex · 上下文 3 行`——检索的「条件」，
 *  而不是把 pattern 塞回 JSON。 */
function searchArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const pattern = str(a, 'pattern');
  if (!pattern) return null;
  const parts: ToolSpan[] = [sp(`/${pattern}/`, 'str')];
  const scope = str(a, 'path', 'directory');
  if (scope) parts.push(sp(` · ${tidyPath(scope)}`, 'note'));
  const glob = str(a, 'globFilter');
  if (glob) parts.push(sp(` · ${glob}`, 'note'));
  if (a?.useRegex === true) parts.push(sp(' · 正则', 'note'));
  if (a?.caseSensitive === true) parts.push(sp(' · 区分大小写', 'note'));
  const context = num(a, 'contextLines');
  if (context) parts.push(sp(` · 上下文 ${context} 行`, 'note'));
  const head = num(a, 'headLimit');
  if (head) parts.push(sp(` · 上限 ${head}`, 'note'));
  const lines = [tl(0, parts)];
  const rest = residualSpans(a, SEARCH_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

/** 检索结果：ripgrep 形态——`9 处匹配 · 1 文件`，逐文件分组，
 *  命中行 `<行号>: <内容>`、上下文行 `<行号>· <内容>`（注记墨）。
 *  原文是 {results:[{file,match_line,match_content,context_block:[{line,content,is_match}]}]}。 */
function searchResult(output: string | undefined): PresentedSection[] | null {
  const parsed = rec(tryJson(output));
  const results = arrOf(parsed?.results);
  if (!results) return null;
  const files = results.map((r) => rec(r)).filter((r): r is Record<string, unknown> => r !== null);
  if (files.length === 0) {
    const count = typeof parsed?.count === 'number' ? parsed.count : 0;
    return [{ label: '命中', display: toolDisplayFromLines([tl(0, [sp(`无匹配（${count} 处）`, 'note')])]) }];
  }
  const count = typeof parsed?.count === 'number' ? parsed.count : files.length;
  const paths = files.map((f) => (typeof f.file === 'string' ? f.file : '')).filter(Boolean);
  const distinct = [...new Set(paths.map((p) => tidyPath(p)))];
  // 单文件命中不缩成文件名（缩到只剩 basename 会丢掉「在哪」）；多文件才按公共根缩写
  const fileCount = distinct.length;
  const rel = fileCount >= 2 ? relativizer(distinct) : tidyPath;
  const head: ToolSpan[] = [sp(`${count} 处匹配 · ${fileCount} 文件`, 'note')];
  if (parsed?.truncated === true) head.push(sp(' · 已截断', 'note'));
  if (parsed?.budget_truncated === true) head.push(sp(' · 预算截断', 'note'));
  const lines: ToolLine[] = [tl(0, head)];
  let lastFile = '';
  for (const f of files) {
    const file = typeof f.file === 'string' ? rel(f.file) : '';
    if (file !== lastFile) {
      lines.push(tl(0, [sp(file, 'str')]));
      lastFile = file;
    }
    const block = arrOf(f.context_block);
    if (block?.length) {
      for (const raw of block) {
        const b = rec(raw);
        if (!b) continue;
        const lineNo = typeof b.line === 'number' ? b.line : undefined;
        const content = typeof b.content === 'string' ? b.content : '';
        const isMatch = b.is_match === true;
        const parts: ToolSpan[] = [sp(lineNo !== undefined ? `${lineNo}${isMatch ? ':' : '·'} ` : '', 'note')];
        parts.push(sp(content, isMatch ? 'plain' : 'note'));
        lines.push(tl(1, parts));
      }
      continue;
    }
    // 无 context_block：单行命中
    const lineNo = typeof f.match_line === 'number' ? f.match_line : undefined;
    const content = typeof f.match_content === 'string' ? f.match_content : '';
    lines.push(tl(1, [sp(lineNo !== undefined ? `${lineNo}: ` : '', 'note'), sp(content)]));
  }
  return [{ label: '命中', display: toolDisplayFromLines(lines) }];
}

function searchSummary(output: string | undefined): string | null {
  const parsed = rec(tryJson(output));
  const results = arrOf(parsed?.results);
  if (!results) return null;
  const count = typeof parsed?.count === 'number' ? parsed.count : results.length;
  const files = new Set(
    results.map((r) => {
      const f = rec(r)?.file;
      return typeof f === 'string' ? tidyPath(f) : '';
    }),
  ).size;
  return `${count} 处 · ${files} 文件`;
}

/* ── git 域 ── */

const GIT_COMMIT_KNOWN = ['action', 'message', 'files', 'all', 'amend'];

/** git 状态字母（porcelain 读法：X=暂存区、Y=工作区）。 */
const GIT_STATUS_LETTER: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflict: 'U',
  unmerged: 'U',
  typechange: 'T',
};

/** `main · 领先 2 · 17 个改动（2 已暂存）` + porcelain 行 ` M path`。
 *  原文 `{branch:"main",ahead:2,behind:0,files:[{path,status,staged}]}` 是给程序的。 */
function gitStatusResult(output: string | undefined): PresentedSection[] | null {
  const parsed = rec(tryJson(output));
  if (!parsed) return null;
  const files = arrOf(parsed.files) ?? [];
  const head: ToolSpan[] = [];
  const branch = typeof parsed.branch === 'string' ? parsed.branch : '';
  if (branch) head.push(sp(branch, 'str'));
  const ahead = typeof parsed.ahead === 'number' ? parsed.ahead : 0;
  const behind = typeof parsed.behind === 'number' ? parsed.behind : 0;
  if (ahead > 0) head.push(sp(` · 领先 ${ahead}`, 'note'));
  if (behind > 0) head.push(sp(` · 落后 ${behind}`, 'note'));
  const rows: Array<{ xy: string; path: string }> = [];
  let stagedCount = 0;
  for (const raw of files) {
    const f = rec(raw);
    if (!f) continue;
    const p = typeof f.path === 'string' ? tidyPath(f.path) : '';
    if (!p) continue;
    const st = typeof f.status === 'string' ? f.status.toLowerCase() : '';
    const staged = f.staged === true;
    if (staged) stagedCount += 1;
    const letter = GIT_STATUS_LETTER[st] ?? (st ? st.slice(0, 1).toUpperCase() : '?');
    const xy = st === 'untracked' ? '??' : `${staged ? letter : ' '}${staged ? ' ' : letter}`;
    const oldPath = typeof f.old_path === 'string' ? ` ← ${tidyPath(f.old_path)}` : '';
    rows.push({ xy, path: `${p}${oldPath}` });
  }
  const change =
    rows.length === 0 ? '无改动' : `${rows.length} 个改动${stagedCount > 0 ? `（${stagedCount} 已暂存）` : ''}`;
  head.push(sp(branch ? ` · ${change}` : change, 'note'));
  const lines: ToolLine[] = [tl(0, head)];
  for (const r of rows) lines.push(tl(0, [sp(`${r.xy} `, 'num'), sp(r.path, 'str')]));
  return [{ label: '工作区', display: toolDisplayFromLines(lines) }];
}

function gitStatusSummary(output: string | undefined): string | null {
  const parsed = rec(tryJson(output));
  const files = arrOf(parsed?.files);
  if (!files) return null;
  return files.length === 0 ? '无改动' : `${files.length} 个改动`;
}

/** 提交记录：`abc1234 · 2026-10-28 · <subject>`。形状不认识 → 交回兜底（原样文本）。 */
function gitLogResult(output: string | undefined): PresentedSection[] | null {
  const parsed = tryJson(output);
  const commits = arrOf(parsed) ?? arrOf(rec(parsed)?.commits);
  if (!commits?.length) return null;
  const lines: ToolLine[] = [];
  for (const raw of commits) {
    const c = rec(raw);
    if (!c) return null;
    const hash = str(c, 'hash', 'sha', 'id', 'commit');
    if (!hash) return null;
    const subject = str(c, 'subject', 'message', 'title') ?? '';
    const date = str(c, 'date', 'timestamp', 'time');
    const parts: ToolSpan[] = [sp(hash.slice(0, 8), 'num')];
    if (date) parts.push(sp(` · ${date.replace(/T.*$/, '')}`, 'note'));
    const one = subject.replace(/\s+/g, ' ').trim();
    if (one) parts.push(sp(` · ${one}`));
    lines.push(tl(0, parts));
  }
  return [{ label: '提交', display: toolDisplayFromLines(lines) }];
}

/** 差分正文（统一 diff）：着色 + 块头。JSON 包了一层 `{diff:"…"}` 时解出来。 */
function gitDiffResult(output: string | undefined): PresentedSection[] | null {
  if (!hasPayloadToShow(output)) return null;
  let text = sanitizePayloadText(output ?? '');
  const wrapped = rec(tryJson(text))?.diff;
  if (typeof wrapped === 'string') text = sanitizePayloadText(wrapped);
  if (!/(^|\n)[+-]/.test(text)) return null;
  const lines = text.split('\n').map((l) => diffLine(l));
  return [{ label: '差异', display: toolDisplayFromLines(lines) }];
}

const GIT_COMMIT_HEAD_RE = /^\[([^\s\]]+)\s+([0-9a-fA-F]+)\]\s+(.+)$/;
const GIT_COMMIT_STAT_RE = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/** 提交回执：`main · a824d1ca · <subject>` + `9 个文件 · +14 −14`。
 *  原文是 git 原话（`[main a824d1ca] …` / `9 files changed, 14 insertions(+)…`）——
 *  英文机器句式，读一眼要翻译一次。 */
function gitCommitResult(output: string | undefined): PresentedSection[] | null {
  if (!hasPayloadToShow(output)) return null;
  const clean = sanitizePayloadText(output ?? '').trim();
  const lines = clean.split('\n');
  const head = GIT_COMMIT_HEAD_RE.exec(lines[0]?.trim() ?? '');
  if (!head) return null;
  const parts: ToolSpan[] = [sp(head[1], 'str'), sp(` · ${head[2].slice(0, 8)}`, 'num')];
  const subject = head[3].replace(/\s+/g, ' ').trim();
  if (subject) parts.push(sp(` · ${subject}`));
  const out: ToolLine[] = [tl(0, parts)];
  const stat = GIT_COMMIT_STAT_RE.exec(clean);
  if (stat) {
    // 读数行只用注记墨：add/del 档带删除线（那是差分正文的语义），一行统计里用会画成擦改
    const statParts: ToolSpan[] = [sp(`${stat[1]} 个文件`, 'note')];
    if (stat[2]) statParts.push(sp(` · +${stat[2]}`, 'note'));
    if (stat[3]) statParts.push(sp(` · −${stat[3]}`, 'note'));
    out.push(tl(0, statParts, true));
  }
  return [{ label: '提交', display: toolDisplayFromLines(out), variant: 'result' }];
}

function gitCommitArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const message = str(a, 'message');
  const files = str(a, 'files');
  if (!message && !files) return null;
  const lines: ToolLine[] = [];
  if (message) {
    const first = message.split('\n')[0]?.trim() ?? '';
    lines.push(tl(0, [sp(first, 'str')]));
    const restCount = message.split('\n').length - 1;
    if (restCount > 0) lines.push(tl(1, [sp(`（正文 ${restCount} 行）`, 'note')]));
  }
  const notes: string[] = [];
  if (files) notes.push(`${files.split(',').filter((f) => f.trim()).length} 个文件`);
  if (a?.amend === true) notes.push('amend');
  if (notes.length) lines.push(tl(0, [sp(notes.join(' · '), 'note')]));
  const rest = residualSpans(a, GIT_COMMIT_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

/* ── web 域 ── */

const WEB_KNOWN = ['action', 'url', 'method', 'headers', 'body', 'maxTokens', 'timeoutMs'];

function webArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const url = str(a, 'url');
  if (!url) return null;
  const notes: string[] = [];
  const method = str(a, 'method');
  if (method && method.toUpperCase() !== 'GET') notes.push(method.toUpperCase());
  const lines = [handleLine(url, notes)];
  const rest = residualSpans(a, WEB_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

const WEB_SEARCH_KNOWN = ['query', 'maxResults', 'max_results', 'engine', 'backend'];

/** 网页检索面：`/query/`（检索词是判别字段，不是 JSON 的一个键）。 */
function webSearchArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const query = str(a, 'query');
  if (!query) return null;
  const parts: ToolSpan[] = [sp(`/${query}/`, 'str')];
  const max = num(a, 'maxResults', 'max_results');
  if (max) parts.push(sp(` · 上限 ${max}`, 'note'));
  const engine = str(a, 'engine', 'backend');
  if (engine) parts.push(sp(` · ${engine}`, 'note'));
  const lines = [tl(0, parts)];
  const rest = residualSpans(a, WEB_SEARCH_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

/** 检索结果：`3 条结果` + 逐条 `title` / `url` / `snippet`（缩进一段）。
 *  原文 `{query, results:[{title,url,snippet}]}`——url 与前缀键都不是人读的顺序。 */
function webSearchResult(output: string | undefined): PresentedSection[] | null {
  const parsed = rec(tryJson(output));
  const results = arrOf(parsed?.results);
  if (!results) return null;
  const n = results.length;
  if (n === 0) {
    const why = typeof parsed?.error === 'string' && parsed.error ? ` · ${parsed.error}` : '';
    return [{ label: '结果', display: toolDisplayFromLines([tl(0, [sp(`没有找到结果${why}`, 'note')])]) }];
  }
  const lines: ToolLine[] = [tl(0, [sp(`${n} 条结果`, 'note')])];
  results.forEach((raw, i) => {
    const r = rec(raw);
    if (!r) return;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    const snippet = typeof r.snippet === 'string' ? r.snippet.replace(/\s+/g, ' ').trim() : '';
    lines.push(tl(0, [sp(`${i + 1}. `, 'punct'), sp(title || url, 'str')]));
    if (title && url) lines.push(tl(1, [sp(url, 'note')]));
    if (snippet) lines.push(tl(1, [sp(snippet)]));
  });
  return [{ label: '结果', display: toolDisplayFromLines(lines) }];
}

function webSearchSummary(output: string | undefined): string | null {
  const results = arrOf(rec(tryJson(output))?.results);
  return results ? `${results.length} 条结果` : null;
}

/* ── 任务板域 ── */

/** 任务状态 → 人话（四个状态是 task-domain 的封闭枚举）。 */
const TASK_STATUS_ZH: Record<string, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
};

/** 一条任务的读法：`#3 已完成 · 标题` + 说明行（说明是给人看的，不缩成 JSON 值）。 */
function taskRow(t: Record<string, unknown>): ToolLine[] {
  const id = typeof t.id === 'number' || typeof t.id === 'string' ? String(t.id) : '';
  const status = typeof t.status === 'string' ? (TASK_STATUS_ZH[t.status] ?? t.status) : '';
  const title = typeof t.title === 'string' ? t.title.replace(/\s+/g, ' ').trim() : '';
  const parts: ToolSpan[] = [];
  if (id) parts.push(sp(`#${id} `, 'num'));
  if (status) parts.push(sp(status, 'key'), sp(' · ', 'punct'));
  parts.push(sp(title || '(无标题)', 'str'));
  const out: ToolLine[] = [tl(0, parts)];
  const detail = typeof t.detail === 'string' ? t.detail.replace(/\s+/g, ' ').trim() : '';
  if (detail) out.push(tl(1, [sp(detail, 'note')]));
  return out;
}

const TASK_KNOWN = ['action', 'id', 'status', 'title', 'detail'];

/** 任务参数面：`改 #3 → 进行中` 一类（动作本身在文类签上，不必再抄一遍）。 */
function taskArgs(a: Record<string, unknown> | null): ToolDisplay | null {
  const id = typeof a?.id === 'number' || typeof a?.id === 'string' ? String(a?.id) : '';
  const status = typeof a?.status === 'string' ? (TASK_STATUS_ZH[a.status] ?? a.status) : '';
  const title = str(a, 'title');
  const detail = str(a, 'detail');
  const parts: ToolSpan[] = [];
  if (id) parts.push(sp(`#${id}`, 'num'));
  if (status) parts.push(parts.length ? sp(' · ', 'punct') : sp(''), sp(status, 'key'));
  if (title) parts.push(parts.length ? sp(' · ', 'punct') : sp(''), sp(title, 'str'));
  if (detail) parts.push(parts.length ? sp(' · ', 'punct') : sp(''), sp(detail, 'note'));
  if (parts.length === 0) return null;
  const lines = [tl(0, parts)];
  const rest = residualSpans(a, TASK_KNOWN);
  if (rest) lines.push(tl(0, rest));
  return toolDisplayFromLines(lines);
}

/** 任务结果：单条 / 列表 / 板（数组）三形态（task.ts 的返回形状）。 */
function taskResult(output: string | undefined): PresentedSection[] | null {
  const parsed = tryJson(output);
  const asArray = arrOf(parsed);
  if (asArray) {
    if (asArray.length === 0)
      return [{ label: '任务', display: toolDisplayFromLines([tl(0, [sp('无任务', 'note')])]) }];
    const lines: ToolLine[] = [];
    for (const raw of asArray) {
      const t = rec(raw);
      if (!t) return null;
      lines.push(...taskRow(t));
    }
    return [{ label: '任务', display: toolDisplayFromLines(lines) }];
  }
  const obj = rec(parsed);
  if (!obj) return null;
  if (typeof obj.error === 'string')
    return [{ label: '任务', display: toolDisplayFromLines([tl(0, [sp(obj.error, 'note')])]) }];
  const tasks = arrOf(obj.tasks);
  if (tasks) {
    const head: ToolSpan[] = [sp(`${tasks.length} 个任务`, 'note')];
    if (typeof obj.count === 'number' && obj.count !== tasks.length) head.push(sp(` · 共 ${obj.count}`, 'note'));
    const lines: ToolLine[] = [tl(0, head)];
    for (const raw of tasks) {
      const t = rec(raw);
      if (!t) return null;
      lines.push(...taskRow(t));
    }
    return [{ label: '任务', display: toolDisplayFromLines(lines) }];
  }
  if (obj.id === undefined && obj.title === undefined) return null;
  return [{ label: '任务', display: toolDisplayFromLines(taskRow(obj)), variant: 'result' }];
}

function taskSummary(output: string | undefined): string | null {
  const parsed = tryJson(output);
  const asArray = arrOf(parsed);
  if (asArray) return `${asArray.length} 个任务`;
  const obj = rec(parsed);
  if (!obj) return null;
  const tasks = arrOf(obj.tasks);
  if (tasks) return `${tasks.length} 个任务`;
  if (typeof obj.count === 'number') return `共 ${obj.count} 个任务`;
  return null;
}

/* ── browser 域（目标页/会话清单：一次调用就是一张小表） ── */

/** browser(targets)：`9223 · 2 个页面` + 逐页 `标题 — url`。
 *  原文 `{port, targets:[{id,title,url}]}`——id 长 32 位十六进制，人读的是标题与地址。 */
function browserTargetsResult(output: string | undefined): PresentedSection[] | null {
  const parsed = rec(tryJson(output));
  const targets = arrOf(parsed?.targets);
  if (!targets) return null;
  const port = typeof parsed?.port === 'number' ? String(parsed.port) : '';
  const head: ToolSpan[] = [];
  if (port) head.push(sp(port, 'num'), sp(' · ', 'punct'));
  head.push(sp(`${targets.length} 个页面`, 'note'));
  const lines: ToolLine[] = [tl(0, head)];
  for (const raw of targets) {
    const t = rec(raw);
    if (!t) continue;
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    const url = typeof t.url === 'string' ? t.url.trim() : '';
    const parts: ToolSpan[] = [sp(title || '(无标题)', 'str')];
    if (url) parts.push(sp(` — ${url}`, 'note'));
    lines.push(tl(0, parts));
  }
  return [{ label: '页面', display: toolDisplayFromLines(lines) }];
}

function browserTargetsSummary(output: string | undefined): string | null {
  const targets = arrOf(rec(tryJson(output))?.targets);
  return targets ? `${targets.length} 个页面` : null;
}

/* ── 表 ── */

/** 语义名 → presenter（语义名真源 = agent/tools/domains.ts 的 DOMAIN_SPECS 反查）。
 *  未登记的名字一律走兜底（通用结构化打印）——远端 MCP / 插件动态名面零风险。 */
const PRESENTERS: Record<string, Presenter> = {
  // shell
  run_shell: { args: shellArgs, argsLabel: '命令', result: shellResult, summary: shellSummary },
  bash_output: { args: shellArgs, argsLabel: '轮询', result: shellResult, summary: shellSummary },
  bash_wait: { args: shellArgs, argsLabel: '等待', result: shellResult, summary: shellSummary },
  bash_kill: { args: shellArgs, argsLabel: '终止' },
  // fs
  read_file_content: { args: readArgs, argsLabel: '读取', result: readResult, summary: readSummary },
  write_file: { args: writeArgs, argsLabel: '写入', result: writeResult, summary: writeSummary },
  edit_file: { args: editArgs, argsLabel: '改动', result: editResult, summary: editSummary },
  list_directory: { args: pathArgs, argsLabel: '目录', result: listResult, summary: listSummary },
  glob: { args: globArgs, argsLabel: '匹配', result: globResult, summary: globSummary },
  // search
  search_content: { args: searchArgs, argsLabel: '检索', result: searchResult, summary: searchSummary },
  search_files: { args: searchArgs, argsLabel: '检索' },
  // git
  git_status: { args: false, result: gitStatusResult, summary: gitStatusSummary },
  git_log: { args: false, result: gitLogResult },
  git_diff: { args: false, result: gitDiffResult },
  git_commit: { args: gitCommitArgs, argsLabel: '提交', result: gitCommitResult },
  // web
  web_fetch: { args: webArgs, argsLabel: '取件' },
  web_search: { args: webSearchArgs, argsLabel: '检索', result: webSearchResult, summary: webSearchSummary },
  // 任务板（task-domain 的四种返回形态：单条 / 列表 / 板数组 / {error}）
  task_create: { args: taskArgs, argsLabel: '新建', result: taskResult, summary: taskSummary },
  task_update: { args: taskArgs, argsLabel: '修改', result: taskResult, summary: taskSummary },
  task_stop: { args: taskArgs, argsLabel: '停止', result: taskResult, summary: taskSummary },
  task_get: { args: taskArgs, argsLabel: '查看', result: taskResult },
  task_list: { args: taskArgs, argsLabel: '筛选', result: taskResult, summary: taskSummary },
  task_board: { args: false, result: taskResult, summary: taskSummary },
  // browser：目标页清单（id 是 32 位十六进制，人读标题与地址）
  browser_targets: { args: false, result: browserTargetsResult, summary: browserTargetsSummary },
};

/* ── 入口 ── */

/** 兜底段（presenter 缺项 / 形状不认识时）——与改造前的行为逐字一致。 */
function fallbackArgs(argsJson: string | undefined): ToolSection[] {
  if (!hasArgsToShow(argsJson)) return [];
  return [{ kind: 'args', label: '参数', display: toolDisplay(argsJson), variant: 'args' }];
}

function fallbackOut(output: string | undefined): ToolSection[] {
  if (!hasPayloadToShow(output)) return [];
  return [{ kind: 'out', label: '输出', display: toolDisplay(output), variant: 'out' }];
}

/** presenter 一律包在 try 里：投影写错只让这一段落回兜底，不许炸整块
 *  （渲染端有 PluginBoundary，但 measure 没有——测高抛错 = 整卷布局崩）。 */
function attempt<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** 载荷 → 展示模型（渲染 / 测高 / 墨迹的唯一入口）。 */
export function presentTool(p: ToolPayload): ToolPresentation {
  const argsObj = parseArgsObj(p.args);
  const semantic = p.name ? resolveSemanticToolName(p.name, p.args) : '';
  const pres = semantic ? PRESENTERS[semantic] : undefined;
  const sections: ToolSection[] = [];

  // 参数面：`args === false` = 明确不展示（protocol-only 动作：`{"action":"status"}` 是骨架）。
  // 有专属投影就投影，投影不出形状 / 无专属 ⇒ 兜底（与改造前逐字一致）。
  const argsFn = pres?.args;
  if (argsFn === false) {
    // 无参数面
  } else if (argsFn) {
    const d = attempt(() => argsFn(argsObj));
    if (d && hasPayloadToShow(d.text)) {
      sections.push({ kind: 'args', label: pres?.argsLabel ?? '参数', display: d, variant: 'args' });
    } else {
      sections.push(...fallbackArgs(p.args));
    }
  } else {
    sections.push(...fallbackArgs(p.args));
  }

  // 结果面：presenter 可给多段（结论 + 差分）；形状不认识 ⇒ 兜底
  const resultFn = pres?.result;
  const presented = resultFn ? attempt(() => resultFn(p.output, argsObj)) : null;
  if (presented?.length) {
    for (const sec of presented) {
      if (!hasPayloadToShow(sec.display.text)) continue;
      sections.push({ kind: 'out', label: sec.label, display: sec.display, variant: sec.variant ?? 'out' });
    }
  } else {
    sections.push(...fallbackOut(p.output));
  }
  if (hasPayloadToShow(p.err)) {
    sections.push({ kind: 'err', label: '错误', display: toolDisplay(p.err), variant: 'err' });
  }

  const summaryFn = pres?.summary;
  const summary = summaryFn ? attempt(() => summaryFn(p.output, argsObj)) : null;
  return summary ? { sections, summary } : { sections };
}
