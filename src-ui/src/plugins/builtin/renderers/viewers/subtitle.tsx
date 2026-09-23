// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 字幕查看器（渲染面补全 B13，2026-09-23）——srt / vtt 解析成时间轴表
// （序号 + 起止 + 文本）+ 一行读数（N 条 + 总时长 = 末条结束时间）。
//
// 认领表真源 = `paper/viewer-exts.ts` 的 `VIEWER_SUBTITLE_EXTS`；读取形态 = 文本行窗口
// （`bytesKind:'text'` + `readLines`，宿主按 `readLines + 1` 开窗——不整份进 IPC）。
//
// 解析纪律（失败面一律可读，不静默）：
//   - 两种时间戳形态都收：srt 的 `00:00:01,000` 与 vtt 的 `00:00:01.000`（vtt 时位可省，
//     行尾 cue settings 丢弃）；
//   - `WEBVTT` 头行与 `NOTE` / `STYLE` / `REGION` 块**跳过且不报错**（它们是 vtt 的合法
//     结构，不是坏数据）；
//   - **坏块不静默**：无时间轴行的块计数并在表头出「N 块无法解析（已跳过）」，其余照常显示；
//   - 行窗口截断：窗口里有第 N+1 行 ⇒ 吸顶横幅说清「只显示前 N 行」；被切断的尾块不参与
//     解析（截断不是坏块——把残块算成坏块是冤枉数据）。

import { VIEWER_SUBTITLE_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './subtitle.css';

const { useMemo } = rendererHooks;

/** 行窗口（与注册面 `readLines` **同值**——宿主多读 1 行作「文件更长」判据）。 */
const SUB_LINE_CAP = 4000;

/** 体积闸（近似：按窗口文本字符数判，与宿主同一口径）。 */
const SUB_MAX_BYTES = 2 * 1024 * 1024;

interface SubCue {
  /** 渲染键（序号构造，唯一——不用数组下标当键） */
  key: string;
  /** 表内序号：块里的标识行（srt 序号 / vtt cue id）优先，缺省用解析序 */
  index: string;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  text: string;
}

interface SubView {
  cues: SubCue[];
  /** 无时间轴行的块数（**计数不吞**——表头出提示） */
  badBlocks: number;
  truncated: boolean;
  /** 总时长 = 末条结束时间（无块 = null） */
  totalMs: number | null;
}

/** 时间戳：`[时:]分:秒[.,]毫秒`（srt 逗号 / vtt 点号；分秒越界 = 非法）。 */
const TC = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/;

function parseTc(raw: string): number | null {
  const m = TC.exec(raw.trim());
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(m[4].padEnd(3, '0'));
}

/** 时间轴行 → 起止毫秒（不是时间轴行 = null；vtt 行尾 cue settings 丢弃）。 */
function parseTimingLine(line: string): { startMs: number; endMs: number } | null {
  const at = line.indexOf('-->');
  if (at < 0) return null;
  const startMs = parseTc(line.slice(0, at));
  const endMs = parseTc(
    line
      .slice(at + 3)
      .trim()
      .split(/\s+/)[0],
  );
  if (startMs == null || endMs == null) return null;
  return { startMs, endMs };
}

/** 毫秒 → `时:分:秒.毫秒`（表内起止与总时长读数共用一份格式）。时位恒出（与 srt/vtt 源
 *  同宽）：起止列宽度恒定才好逐行对读，不按「小时为 0 就省一段」变宽窄。 */
function formatTc(ms: number): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  const millis = ms % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/** 字幕文本 → 视图（纯函数：块扫描 + 时间轴行定位 + 坏块计数）。 */
function parseSubtitles(raw: string): SubView {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.length > 0 ? text.split('\n') : [];
  const truncated = lines.length > SUB_LINE_CAP;
  let shown = truncated ? lines.slice(0, SUB_LINE_CAP) : lines;
  if (truncated) {
    // 窗口切断处的尾块是残块：按最后一个空行截齐（截断由吸顶横幅说话，不算坏块）
    const lastBlank = shown.lastIndexOf('');
    shown = lastBlank >= 0 ? shown.slice(0, lastBlank + 1) : [];
  }

  const cues: SubCue[] = [];
  let badBlocks = 0;
  let seq = 0;
  let block: string[] = [];

  const flush = (): void => {
    if (block.length === 0) return;
    let body = block;
    // vtt 头行可与首块同块（缺空行时）——只剔头行，其余照常解析
    while (body.length > 0 && /^WEBVTT(\s|$)/.test(body[0].trim())) body = body.slice(1);
    if (body.length === 0) return;
    // NOTE / STYLE / REGION 块：vtt 的合法结构（注释 / 样式 / 区域声明），整块跳过
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(body[0].trim())) return;
    let timingAt = -1;
    let startMs = 0;
    let endMs = 0;
    for (let i = 0; i < body.length; i++) {
      const timing = parseTimingLine(body[i]);
      if (timing) {
        timingAt = i;
        startMs = timing.startMs;
        endMs = timing.endMs;
        break;
      }
    }
    if (timingAt < 0) {
      badBlocks++;
      return;
    }
    seq++;
    const ident = body
      .slice(0, timingAt)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(' ');
    cues.push({
      key: `cue-${seq}`,
      index: ident.length > 0 ? ident : String(seq),
      start: formatTc(startMs),
      end: formatTc(endMs),
      startMs,
      endMs,
      text: body.slice(timingAt + 1).join('\n'),
    });
  };

  for (const line of shown) {
    if (line.trim() === '') {
      flush();
      block = [];
      continue;
    }
    block.push(line);
  }
  flush();

  const last = cues.length > 0 ? cues[cues.length - 1] : null;
  return { cues, badBlocks, truncated, totalMs: last ? last.endMs : null };
}

function SubtitleViewer({ bytes, mode }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const view = useMemo(() => parseSubtitles(text), [text]);
  // 字幕没有放大形态（浮层由宿主渲染，但「点击看大图」语义对时间轴表无意义）
  if (mode === 'overlay') return null;
  if (text.trim().length === 0) return <div className="pp-viewer-empty">字幕为空（文件无内容）</div>;
  if (view.cues.length === 0) {
    return (
      <div className="pp-viewer-empty">
        {view.truncated
          ? `窗口内没有完整的时间轴块（已截断：只显示前 ${SUB_LINE_CAP} 行）`
          : view.badBlocks > 0
            ? `未解析到时间轴块（${view.badBlocks} 块无法解析）`
            : '字幕里没有时间轴块'}
      </div>
    );
  }
  return (
    <div className="pp-viewer-sub">
      <div className="pp-viewer-box">
        {view.truncated && <div className="pp-viewer-note">已截断：只显示前 {SUB_LINE_CAP} 行（文件更长）</div>}
        {view.badBlocks > 0 && <div className="pp-viewer-note">{view.badBlocks} 块无法解析（已跳过）</div>}
        <table className="pp-viewer-sub-table">
          <thead>
            <tr>
              <th className="pp-viewer-sub-idx">#</th>
              <th className="pp-viewer-sub-tc">起</th>
              <th className="pp-viewer-sub-tc">止</th>
              <th className="pp-viewer-sub-text">文本</th>
            </tr>
          </thead>
          <tbody>
            {view.cues.map((cue) => (
              <tr key={cue.key}>
                <td className="pp-viewer-sub-idx">{cue.index}</td>
                <td className="pp-viewer-sub-tc">{cue.start}</td>
                <td className="pp-viewer-sub-tc">{cue.end}</td>
                <td className="pp-viewer-sub-text">{cue.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pp-viewer-sub-meta">
        共 {view.cues.length} 条 · 总时长 {view.totalMs == null ? '未知' : formatTc(view.totalMs)}
      </div>
    </div>
  );
}

export const subtitleViewer: ViewerDef = {
  id: 'subtitle',
  exts: VIEWER_SUBTITLE_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: SUB_LINE_CAP,
  maxBytes: SUB_MAX_BYTES,
  component: SubtitleViewer,
};
