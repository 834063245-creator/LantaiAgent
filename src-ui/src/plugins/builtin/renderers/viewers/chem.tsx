// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 化学结构查看器（渲染面补全 P1 · B12 之一，2026-09-23）——mol / sdf / pdb。
//
// **为什么自绘而不是复用 smiles-drawer（开工前已核实）**：smiles-drawer 2.4.1 的
// `SmilesDrawer.parse(smiles, ok, err)` 入参语义是 **SMILES 字符串**（`app.ts` →
// `Parser.parse` → peg/smiles.pegjs 文法）；全包（`src/` · `dist/` · `README.md` ·
// `app.ts`）grep `molfile|V2000|M  END|fromMol` **零命中** —— 它没有连接表
// （connection table）读取器。实测喂一段 V2000 molfile：`Expected "%", "(", "*",
// "B", "C", "[", [0-9], [NOPSFI], [\-=#$:/\\.], [bcnops], or end of input but "e"
// found`（它在 `benzene` 这个标题词上就断了）。故本查看器**自绘 SVG**：molfile 自带
// 2D 坐标，照坐标画即可，不需要化学感知（键级照画、不补氢、不做布局）。
// `chem` 原语（components.tsx 的 ChemBody）走的是 SMILES 面——与本件不是一回事，
// 两者互不替代。
//
// 认领表真源 = `paper/viewer-exts.ts` 的 `VIEWER_CHEM_EXTS`（宿主层单一真源）。
//
// 格式覆盖（**不做化学感知**，只画文件里有的东西）：
//   mol / sdf：V2000 连接表 = 3 行头部 + counts 行（原子数 键数）+ 原子块
//              （x y z 元素）+ 键块（a1 a2 键级）；SDF = `$$$$` 分隔的多条记录，
//              出「第 N / 共 M 条」受控切换。V3000 不在解析范围（明确报错，不猜）。
//   pdb：`ATOM`/`HETATM` 行（x/y/z + 元素列）+ `CONECT` 行（成键表）；
//        **按文件坐标投影（x/y 平面）绘制，非化学感知布局**（z 未参与，如实标注）；
//        多 `MODEL`（NMR 构象）复用同一套「第 N / 共 M 条」切换。
//
// 失败面（错误不静默）：坏记录 / 空记录 / 字段不足 ⇒ 可读错误行 + 原文（窗口内）
// 照显 —— 不空白、不 JSON 兜底。
//
// 行窗口与体积闸与注册面同值（宿主多读 1 行作「文件更长」判据，故本件能如实
// 标注截断：结构可能在窗口之外被切断）。

import { VIEWER_CHEM_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './chem.css';

const { useMemo, useState } = rendererHooks;

/** 行窗口（与注册面 `readLines` **同值**：宿主读 6001 行，本件只显示前 6000 行）。 */
const CHEM_LINE_CAP = 6000;

/** 体积闸（近似：按窗口文本**字符数**判，宿主文案里如实说「约」）。 */
const CHEM_MAX_CHARS = 2 * 1024 * 1024;

/** 错误态原文照显的行上限（防一条巨型记录把 DOM 撑爆；截断如实标注）。 */
const RAW_LINE_CAP = 200;

interface ChemAtom {
  x: number;
  y: number;
  /** 元素符号（读不出 = ''，不猜） */
  symbol: string;
}

interface ChemBond {
  /** 1-based 原子序号（molfile 语义） */
  a: number;
  b: number;
  /** 键级（1 单 / 2 双 / 3 三 / 4 芳香） */
  order: number;
}

interface ChemRecord {
  title: string;
  source: 'molfile' | 'pdb';
  atoms: ChemAtom[];
  bonds: ChemBond[];
  /** 非致命提示（键级异常 / CONECT 悬空 / 元素列缺失…）——照显，不静默 */
  notes: string[];
  /** 记录级失败（有它 = 不画图：出错误行 + 原文） */
  error?: string;
  /** 本记录的原文（错误态照显用） */
  raw: string;
}

interface ChemView {
  records: ChemRecord[];
  /** 窗口里还有第 `CHEM_LINE_CAP + 1` 行 ⇒ 文件更长（结构可能被切断） */
  truncated: boolean;
}

/* ── 定宽字段读取（molfile / PDB 都是列位契约；读不出 = NaN，不猜 0）── */

function fieldInt(line: string, from: number, to: number): number {
  const n = Number.parseInt(line.slice(from, to).trim(), 10);
  return Number.isInteger(n) ? n : Number.NaN;
}

function fieldNum(line: string, from: number, to: number): number {
  const n = Number.parseFloat(line.slice(from, to).trim());
  return Number.isFinite(n) ? n : Number.NaN;
}

/** 元素符号归一（`CL`→`Cl`，`c`→`C`）；读不出 = ''（**不猜**，图上就不标）。 */
function normalizeSymbol(raw: string): string {
  const m = /^([A-Za-z]{1,2})/.exec(raw.trim());
  if (!m) return '';
  const s = m[1];
  return s.length === 1 ? s.toUpperCase() : s[0].toUpperCase() + s[1].toLowerCase();
}

/* ── molfile / SDF（V2000 连接表）── */

/** 原子行：x[0,10) y[10,20) 元素[31,34)；列宽不严格的手写件退回空白切分（仍读不出 = 报错）。 */
function readAtomLine(line: string): ChemAtom | string {
  const x = fieldNum(line, 0, 10);
  const y = fieldNum(line, 10, 20);
  const symbol = normalizeSymbol(line.slice(31, 34));
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, symbol };
  const parts = line.trim().split(/\s+/);
  const fx = Number.parseFloat(parts[0] ?? '');
  const fy = Number.parseFloat(parts[1] ?? '');
  if (Number.isFinite(fx) && Number.isFinite(fy)) return { x: fx, y: fy, symbol: normalizeSymbol(parts[3] ?? '') };
  return line.trim().slice(0, 60);
}

/** 键行：a1[0,3) a2[3,6) 键级[6,9)；列宽退化时退回空白切分。 */
function readBondLine(line: string): ChemBond | null {
  let a = fieldInt(line, 0, 3);
  let b = fieldInt(line, 3, 6);
  let order = fieldInt(line, 6, 9);
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    const parts = line.trim().split(/\s+/);
    a = Number.parseInt(parts[0] ?? '', 10);
    b = Number.parseInt(parts[1] ?? '', 10);
    order = Number.parseInt(parts[2] ?? '', 10);
  }
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  return { a, b, order: Number.isInteger(order) ? order : 1 };
}

/** `$$$$` 分隔的 SDF → 逐条原文（尾随空块丢弃；无 `$$$$` 的单 molfile = 一条记录）。 */
function splitSdf(text: string): string[] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '$$$$') {
      chunks.push(cur);
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.some((l) => l.trim().length > 0)) chunks.push(cur);
  return chunks.filter((c) => c.some((l) => l.trim().length > 0)).map((c) => c.join('\n'));
}

function parseMolRecord(raw: string, index: number): ChemRecord {
  const lines = raw.split('\n');
  const base: ChemRecord = {
    title: (lines[0] ?? '').trim() || `第 ${index + 1} 条记录`,
    source: 'molfile',
    atoms: [],
    bonds: [],
    notes: [],
    raw,
  };
  if (/V3000/i.test(raw) && !/V2000/i.test(raw)) {
    return { ...base, error: 'V3000 连接表不在本查看器解析范围（只解析 V2000）' };
  }
  if (lines.length < 4) {
    return { ...base, error: `molfile 记录不足 4 行（3 行头部 + counts 行），只读到 ${lines.length} 行` };
  }
  const counts = lines[3].trim().split(/\s+/);
  const declaredAtoms = Number.parseInt(counts[0] ?? '', 10);
  const declaredBonds = Number.parseInt(counts[1] ?? '', 10);
  if (!Number.isInteger(declaredAtoms) || !Number.isInteger(declaredBonds)) {
    return { ...base, error: `counts 行（第 4 行）读不出原子/键数：${lines[3].trim().slice(0, 60)}` };
  }
  if (declaredAtoms <= 0) {
    return { ...base, error: `counts 行声明 ${declaredAtoms} 个原子（空记录画不出结构）` };
  }
  const atomLines = lines.slice(4, 4 + declaredAtoms);
  if (atomLines.length < declaredAtoms) {
    return {
      ...base,
      error: `原子块不完整：counts 声明 ${declaredAtoms} 个原子，只读到 ${atomLines.length} 行`,
    };
  }
  const atoms: ChemAtom[] = [];
  for (let i = 0; i < atomLines.length; i++) {
    const atom = readAtomLine(atomLines[i]);
    if (typeof atom === 'string') {
      return { ...base, error: `第 ${i + 1} 个原子行读不出坐标：${atom}` };
    }
    atoms.push(atom);
  }
  const notes: string[] = [];
  const bonds: ChemBond[] = [];
  const bondLines = lines.slice(4 + declaredAtoms, 4 + declaredAtoms + declaredBonds);
  if (bondLines.length < declaredBonds) {
    notes.push(`键块不完整：counts 声明 ${declaredBonds} 条键，只读到 ${bondLines.length} 行`);
  }
  let skipped = 0;
  let oddOrder = 0;
  for (const line of bondLines) {
    const bond = readBondLine(line);
    if (!bond || bond.a < 1 || bond.b < 1 || bond.a > atoms.length || bond.b > atoms.length || bond.a === bond.b) {
      skipped++;
      continue;
    }
    if (!(bond.order >= 1 && bond.order <= 4)) {
      oddOrder++;
      bonds.push({ ...bond, order: 1 });
      continue;
    }
    bonds.push(bond);
  }
  if (skipped > 0) notes.push(`${skipped} 条键行读不出或引用了不存在的原子序号（已跳过）`);
  if (oddOrder > 0) notes.push(`${oddOrder} 条键的键级不在 1–4（按单线绘制）`);
  if (!lines.some((l) => /^M\s+END\s*$/.test(l))) notes.push('记录里没有 M  END 结束标记（文件可能被截断）');
  return { ...base, atoms, bonds, notes };
}

/* ── PDB（ATOM/HETATM 坐标 + CONECT 成键表）── */

interface PdbAtomLine {
  serial: number;
  x: number;
  y: number;
  symbol: string;
}

/** ATOM/HETATM 行：serial[6,11) name[12,16) x[30,38) y[38,46) 元素[76,78)。 */
function readPdbAtomLine(line: string): PdbAtomLine | null {
  const serial = fieldInt(line, 6, 11);
  let x = fieldNum(line, 30, 38);
  let y = fieldNum(line, 38, 46);
  let name = line.slice(12, 16).trim();
  let element = line.slice(76, 78).trim();
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    // 列宽退化的手写件：ATOM serial name resName chain resSeq x y z …
    const parts = line.trim().split(/\s+/);
    x = Number.parseFloat(parts[6] ?? '');
    y = Number.parseFloat(parts[7] ?? '');
    name = parts[2] ?? name;
    element = parts[11] ?? element;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // 元素列缺席时按原子名**首字母**推断（不按两字母——`CA` 是 α 碳不是钙）
  const symbol = normalizeSymbol(element) || normalizeSymbol((name.match(/[A-Za-z]/) ?? [''])[0]);
  return { serial: Number.isInteger(serial) ? serial : -1, x, y, symbol };
}

/** `CONECT` 行：首个序号为源，其余为成键对象（5 字符字段）。 */
function readConectLine(line: string): number[] {
  const out: number[] = [];
  for (let at = 6; at + 5 <= line.length; at += 5) {
    const n = fieldInt(line, at, at + 5);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  if (out.length === 0) {
    const parts = line.trim().split(/\s+/).slice(1);
    for (const p of parts) {
      const n = Number.parseInt(p, 10);
      if (Number.isInteger(n) && n > 0) out.push(n);
    }
  }
  return out;
}

/** `MODEL`/`ENDMDL` 多构象 → 逐帧原文；无 MODEL 行（常规单帧）= 整份一份。 */
function splitPdbModels(text: string): string[] {
  const lines = text.split('\n');
  if (!lines.some((l) => /^MODEL\b/.test(l))) return [text];
  const models: string[][] = [];
  let cur: string[] = [];
  let inModel = false;
  for (const line of lines) {
    if (/^MODEL\b/.test(line)) {
      cur = [];
      inModel = true;
      continue;
    }
    if (/^ENDMDL\b/.test(line)) {
      if (inModel) models.push(cur);
      cur = [];
      inModel = false;
      continue;
    }
    if (inModel) cur.push(line);
  }
  if (inModel && cur.length > 0) models.push(cur);
  return models.filter((m) => m.some((l) => /^(ATOM|HETATM)\b/.test(l))).map((m) => m.join('\n'));
}

function parsePdbRecord(raw: string, index: number): ChemRecord {
  const lines = raw.split('\n');
  const base: ChemRecord = {
    title: (/^TITLE\s+(.*)$/m.exec(raw)?.[1] ?? '').trim() || `第 ${index + 1} 条记录`,
    source: 'pdb',
    atoms: [],
    bonds: [],
    notes: [],
    raw,
  };
  const atoms: ChemAtom[] = [];
  const serialToIndex = new Map<number, number>();
  const conectPairs: Array<[number, number]> = [];
  const notes: string[] = [];
  let badAtomLines = 0;
  let noElement = 0;
  let unknownSerial = 0;
  for (const line of lines) {
    const record = line.slice(0, 6).trim().toUpperCase();
    if (record === 'ATOM' || record === 'HETATM') {
      const atom = readPdbAtomLine(line);
      if (!atom) {
        badAtomLines++;
        continue;
      }
      if (atom.symbol === '') noElement++;
      const idx = atoms.length;
      atoms.push({ x: atom.x, y: atom.y, symbol: atom.symbol });
      if (atom.serial > 0) serialToIndex.set(atom.serial, idx);
      continue;
    }
    if (record === 'CONECT') {
      const serials = readConectLine(line);
      const from = serials[0];
      if (from == null) continue;
      for (const to of serials.slice(1)) conectPairs.push([from, to]);
    }
  }
  if (atoms.length === 0) {
    return {
      ...base,
      notes,
      error: `没有读到可用的 ATOM/HETATM 行（${badAtomLines} 行坐标读不出）——不是 PDB 坐标文件？`,
    };
  }
  // CONECT 两侧都列（1→2 与 2→1）⇒ 去重；自环与悬空序号跳过（计数可见，不静默）
  const seen = new Set<string>();
  const bonds: ChemBond[] = [];
  for (const [from, to] of conectPairs) {
    if (from === to) continue;
    const key = from < to ? `${from}-${to}` : `${to}-${from}`;
    if (seen.has(key)) continue;
    const ia = serialToIndex.get(from);
    const ib = serialToIndex.get(to);
    if (ia == null || ib == null) {
      unknownSerial++;
      continue;
    }
    seen.add(key);
    bonds.push({ a: ia + 1, b: ib + 1, order: 1 });
  }
  // 诚实标注（PDB 只有坐标，没有「布局」这回事）：恒定出现在读数行
  notes.push('按文件坐标投影（x/y 平面）绘制，非化学感知布局（z 未参与绘制）');
  if (bonds.length === 0) notes.push('文件里没有可用的 CONECT 成键行（只画原子）');
  if (unknownSerial > 0) notes.push(`${unknownSerial} 个 CONECT 序号在 ATOM 里不存在（已跳过）`);
  if (badAtomLines > 0) notes.push(`${badAtomLines} 行 ATOM/HETATM 坐标读不出（已跳过）`);
  if (noElement > 0) notes.push(`${noElement} 个原子没有元素列（按原子名首字母推断）`);
  return { ...base, atoms, bonds, notes };
}

/* ── 视图模型 ── */

function buildChemView(text: string, ext: string): ChemView {
  const lines = text.length > 0 ? text.split('\n') : [];
  const truncated = lines.length > CHEM_LINE_CAP;
  const window = (truncated ? lines.slice(0, CHEM_LINE_CAP) : lines).join('\n');
  if (window.trim().length === 0) return { records: [], truncated };
  const records =
    ext === 'pdb'
      ? splitPdbModels(window).map((raw, i) => parsePdbRecord(raw, i))
      : splitSdf(window).map((raw, i) => parseMolRecord(raw, i));
  if (records.length === 0) {
    // 非空文本却一条记录都没有（空行 / MODEL 里没有坐标行）：仍是**错误态**——
    // 出可读错误行 + 原文，不落空盒、不静默
    records.push({
      title: '（无记录）',
      source: ext === 'pdb' ? 'pdb' : 'molfile',
      atoms: [],
      bonds: [],
      notes: [],
      error: ext === 'pdb' ? '没有读到 ATOM/HETATM 行（MODEL 块里也没有坐标）' : '窗口里没有可解析的记录（只有空行）',
      raw: window,
    });
  }
  return { records, truncated };
}

/* ── 自绘 SVG（molfile 2D 坐标 / PDB 文件坐标投影；y 轴翻转——文件 y 向上，屏幕 y 向下）── */

interface ChemSceneLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed?: boolean;
}

interface ChemScene {
  viewBox: string;
  stroke: number;
  dash: string;
  radius: number;
  font: number;
  atoms: Array<{ x: number; y: number; symbol: string }>;
  bonds: ChemSceneLine[][];
}

/** 小数位收敛（DOM 里不留 15 位浮点尾巴）。 */
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 键 → 线段组：order 2 平行双线、3 三线、4 芳香（单线 + 内侧虚线）；其余按单线。 */
function bondSegments(p1: { x: number; y: number }, p2: { x: number; y: number }, order: number, offset: number) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [{ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }];
  const nx = -dy / len;
  const ny = dx / len;
  const at = (o: number): ChemSceneLine => ({
    x1: p1.x + nx * o,
    y1: p1.y + ny * o,
    x2: p2.x + nx * o,
    y2: p2.y + ny * o,
  });
  if (order === 2) return [at(-offset / 2), at(offset / 2)];
  if (order === 3) return [at(-offset), at(0), at(offset)];
  if (order === 4) return [at(0), { ...at(offset / 2), dashed: true }];
  return [at(0)];
}

function buildChemScene(atoms: ChemAtom[], bonds: ChemBond[]): ChemScene {
  // 投影：y 翻转到屏幕坐标系
  const pts = atoms.map((a) => ({ x: a.x, y: -a.y, symbol: a.symbol }));
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  // 退化（单原子 / 全部重合）：取 1 单位作参照尺度，盒不至于塌成 0 宽
  const span = Math.max(w, h) > 0 ? Math.max(w, h) : 1;
  const pad = span * 0.12;
  const offset = span * 0.032;
  const segments = bonds.map((b) => {
    const p1 = pts[b.a - 1];
    const p2 = pts[b.b - 1];
    return bondSegments(p1, p2, b.order, offset);
  });
  return {
    viewBox: `${round(minX - pad, 4)} ${round(minY - pad, 4)} ${round(w + 2 * pad, 4)} ${round(h + 2 * pad, 4)}`,
    stroke: span * 0.02,
    dash: `${span * 0.05} ${span * 0.04}`,
    radius: span * 0.055,
    font: span * 0.13,
    atoms: pts,
    bonds: segments,
  };
}

/* ── 组件 ── */

function ChemViewer({ label, ext, bytes }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const view = useMemo(() => buildChemView(text, ext), [text, ext]);
  const [index, setIndex] = useState(0);
  if (text.trim().length === 0) return <div className="pp-viewer-empty">文件为空（0 行）</div>;
  // 非空文本必有记录（空记录在 buildChemView 里合成错误态）——这行是不变量守卫，不是常规路径
  if (view.records.length === 0) return <div className="pp-viewer-empty">窗口里没有可解析的记录（只有空行）</div>;
  const cur = Math.min(index, view.records.length - 1);
  const rec = view.records[cur];
  const truncNote = view.truncated ? `已截断：只读前 ${CHEM_LINE_CAP} 行（文件更长）——结构/记录可能不完整` : null;
  const total = view.records.length;
  const nav = (
    <div className="pp-viewer-chem-nav">
      {total > 1 && (
        <button type="button" onClick={() => setIndex(Math.max(0, cur - 1))} disabled={cur === 0}>
          上一条
        </button>
      )}
      <span className="pp-viewer-chem-pos">
        第 {cur + 1} / 共 {total} 条
      </span>
      {total > 1 && (
        <button type="button" onClick={() => setIndex(Math.min(total - 1, cur + 1))} disabled={cur >= total - 1}>
          下一条
        </button>
      )}
    </div>
  );

  if (rec.error) {
    const rawLines = rec.raw.split('\n');
    const shown = rawLines.slice(0, RAW_LINE_CAP);
    const rawNote =
      rawLines.length > RAW_LINE_CAP
        ? `原文照显（只显示前 ${RAW_LINE_CAP} 行 / 本条共 ${rawLines.length} 行）——不猜结构`
        : `原文照显（本条 ${rawLines.length} 行）——不猜结构`;
    return (
      <div className="pp-viewer-chem">
        {nav}
        <div className="pp-viewer-error">
          无法绘制第 {cur + 1} 条记录（{rec.title}）：{rec.error}
        </div>
        <div className="pp-viewer-box pp-viewer-chem-raw">
          <div className="pp-viewer-note">
            {rawNote}
            {truncNote ? ` · ${truncNote}` : ''}
          </div>
          <pre className="pp-viewer-chem-pre">{shown.join('\n')}</pre>
        </div>
      </div>
    );
  }

  const scene = buildChemScene(rec.atoms, rec.bonds);
  const kind = rec.source === 'pdb' ? 'PDB' : 'molfile（V2000）';
  const readout = [kind, rec.title, `${rec.atoms.length} 原子`, `${rec.bonds.length} 键`, ...rec.notes].join(' · ');
  return (
    <div className="pp-viewer-box pp-viewer-chem">
      {truncNote && <div className="pp-viewer-note">{truncNote}</div>}
      {nav}
      <div className="pp-viewer-chem-meta">{readout}</div>
      <div className="pp-viewer-chem-stage">
        <svg
          className="pp-viewer-chem-svg"
          viewBox={scene.viewBox}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`${label || '化学结构'} · ${rec.title} · ${rec.atoms.length} 原子 ${rec.bonds.length} 键`}
        >
          {scene.bonds.map((segments, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 键按 molfile 键块序渲染（无自然 id）
            <g className="pp-viewer-chem-bond" key={`bond-${i}`}>
              {segments.map((s, j) => (
                <line
                  // biome-ignore lint/suspicious/noArrayIndexKey: 同一键的多条平行线按偏移序渲染
                  key={`seg-${j}`}
                  className="pp-viewer-chem-bond-line"
                  x1={round(s.x1, 4)}
                  y1={round(s.y1, 4)}
                  x2={round(s.x2, 4)}
                  y2={round(s.y2, 4)}
                  strokeWidth={round(scene.stroke, 4)}
                  strokeDasharray={s.dashed ? scene.dash : undefined}
                />
              ))}
            </g>
          ))}
          {scene.atoms.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 原子按连接表序渲染（无自然 id）
            <g className="pp-viewer-chem-atom-node" key={`atom-${i}`}>
              <circle
                className="pp-viewer-chem-atom"
                cx={round(a.x, 4)}
                cy={round(a.y, 4)}
                r={round(scene.radius, 4)}
              />
              {/* 碳不标符号（有机化学惯例）；其余元素标——符号读出不出就不标，不猜 */}
              {a.symbol !== '' && a.symbol !== 'C' && (
                <text
                  className="pp-viewer-chem-symbol"
                  x={round(a.x, 4)}
                  y={round(a.y, 4)}
                  fontSize={round(scene.font, 4)}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {a.symbol}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

export const chemViewer: ViewerDef = {
  id: 'chem',
  exts: VIEWER_CHEM_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: CHEM_LINE_CAP,
  maxBytes: CHEM_MAX_CHARS,
  component: ChemViewer,
};
