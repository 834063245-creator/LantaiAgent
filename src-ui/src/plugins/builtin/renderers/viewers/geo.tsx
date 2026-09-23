// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 地理数据查看器（渲染面补全 P1 · B12 之一，2026-09-23）——geojson / kml。
//
// 形态：**简图**（施工单 §4.1 B12 口径：外边界 + 要素点，不做投影完整实现）——
//   投影 = 等距圆柱（lon/lat → x/y 线性映射，y 轴翻转；不做墨卡托/大地基准/重投影）；
//   viewBox 按全体坐标包围盒自适应（留边距），点 = 圆、线 = 折线、面 = 闭合轮廓。
//   度量失真如实说明：这不是地图，是「坐标长什么样」的简图。
//
// 归一化（三形态都接）：`FeatureCollection` / 单个 `Feature` / 裸 `Geometry`
// （含 GeometryCollection / Multi* 族）；KML 走 WebView2 原生 `DOMParser`
// （`DOMParser` 是 API 调用，不建游离 DOM），取 `Placemark` 下的
// `Point` / `LineString` / `Polygon`（含 `MultiGeometry` 里的）的 `coordinates`。
// **KML 的坐标是 `lon,lat[,alt]` 空格分隔**（与 GeoJSON 的嵌套数组不是一种写法），
// 故两条解析器分开写、共用同一套投影与绘制。
//
// 失败面（错误不静默）：
//   解析失败（JSON/XML 坏）/ 全程无坐标 ⇒ 可读错误行 + 原文（窗口内）照显；
//   坐标非法（非数字）/ 要素缺坐标 / 几何类型不支持 ⇒ 计数提示行，不静默略过。
//
// 认领表真源 = `paper/viewer-exts.ts` 的 `VIEWER_GEO_EXTS`（宿主层单一真源）；
// 行窗口与体积闸与注册面同值（宿主多读 1 行 ⇒ 本件能如实标注截断）。

import { VIEWER_GEO_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './geo.css';

const { useMemo } = rendererHooks;

/** 行窗口（与注册面 `readLines` **同值**：宿主读 6001 行，本件只显示前 6000 行）。 */
const GEO_LINE_CAP = 6000;

/** 体积闸（近似：按窗口文本**字符数**判，宿主文案里如实说「约」）。 */
const GEO_MAX_CHARS = 2 * 1024 * 1024;

/** 错误态原文照显的行上限（截断如实标注）。 */
const RAW_LINE_CAP = 200;

/** 退化（单点 / 单线）时的参照尺度：0.01° 作包围盒留边与点半径的基准。 */
const DEGENERATE_SPAN = 0.01;

interface GeoPoint {
  lon: number;
  lat: number;
}

type GeoShape =
  | { kind: 'point'; p: GeoPoint }
  | { kind: 'line'; pts: GeoPoint[] }
  | { kind: 'polygon'; rings: GeoPoint[][] };

/** 解析累积器（两个解析器共用形状；`error` 有值 = 不画图，出错误行 + 原文）。 */
interface GeoAcc {
  shapes: GeoShape[];
  /** 要素数（Feature 节点；裸 Geometry 记一个） */
  features: number;
  /** 没有可解析坐标的要素数（提示行，不静默） */
  emptyFeatures: number;
  /** 非数字坐标分量个数（提示行，不静默） */
  badCoords: number;
  /** 不支持的几何类型（去重后提示） */
  unsupported: string[];
  error?: string;
}

interface GeoView extends GeoAcc {
  /** 窗口里还有第 `GEO_LINE_CAP + 1` 行 ⇒ 文件更长 */
  truncated: boolean;
}

function emptyAcc(): GeoAcc {
  return { shapes: [], features: 0, emptyFeatures: 0, badCoords: 0, unsupported: [] };
}

/** 数值宽容读法（GeoJSON 的数字 / KML 的字符串都吃）；读不出 = NaN（计入 badCoords）。 */
function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

function readPair(v: unknown, acc: GeoAcc): GeoPoint | null {
  if (!Array.isArray(v) || v.length < 2) {
    acc.badCoords++;
    return null;
  }
  const lon = toNum(v[0]);
  const lat = toNum(v[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    acc.badCoords++;
    return null;
  }
  return { lon, lat };
}

function readPairs(v: unknown, acc: GeoAcc): GeoPoint[] {
  if (!Array.isArray(v)) {
    acc.badCoords++;
    return [];
  }
  const out: GeoPoint[] = [];
  for (const item of v) {
    const p = readPair(item, acc);
    if (p) out.push(p);
  }
  return out;
}

/** 面 = 环数组（首环为外边界，其余为洞）；每个环是坐标对数组。 */
function readRings(v: unknown, acc: GeoAcc): GeoPoint[][] {
  if (!Array.isArray(v)) {
    acc.badCoords++;
    return [];
  }
  const rings: GeoPoint[][] = [];
  for (const ring of v) {
    const pts = readPairs(ring, acc);
    if (pts.length > 0) rings.push(pts);
  }
  return rings;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** GeoJSON 递归（FeatureCollection / Feature / 裸 Geometry / GeometryCollection / Multi*）。 */
function walkGeojson(node: unknown, acc: GeoAcc, underFeature: boolean): void {
  if (acc.error) return;
  if (!isObject(node)) {
    acc.error = '不是 GeoJSON 对象（顶层既不是 Feature/FeatureCollection 也不是 Geometry）';
    return;
  }
  const type = typeof node.type === 'string' ? node.type : '';
  if (type === 'FeatureCollection') {
    if (!Array.isArray(node.features)) {
      acc.error = 'FeatureCollection 缺 features 数组';
      return;
    }
    for (const f of node.features) walkGeojson(f, acc, false);
    return;
  }
  if (type === 'Feature') {
    acc.features++;
    const before = acc.shapes.length;
    walkGeojson(node.geometry, acc, true);
    if (acc.shapes.length === before) acc.emptyFeatures++;
    return;
  }
  if (type === 'GeometryCollection') {
    if (!Array.isArray(node.geometries)) {
      acc.error = 'GeometryCollection 缺 geometries 数组';
      return;
    }
    if (!underFeature) acc.features++;
    for (const g of node.geometries) walkGeojson(g, acc, true);
    return;
  }
  if (!underFeature) acc.features++;
  switch (type) {
    case 'Point': {
      const p = readPair(node.coordinates, acc);
      if (p) acc.shapes.push({ kind: 'point', p });
      return;
    }
    case 'MultiPoint': {
      for (const p of readPairs(node.coordinates, acc)) acc.shapes.push({ kind: 'point', p });
      return;
    }
    case 'LineString': {
      const pts = readPairs(node.coordinates, acc);
      if (pts.length >= 2) acc.shapes.push({ kind: 'line', pts });
      return;
    }
    case 'MultiLineString': {
      if (!Array.isArray(node.coordinates)) {
        acc.badCoords++;
        return;
      }
      for (const ls of node.coordinates) {
        const pts = readPairs(ls, acc);
        if (pts.length >= 2) acc.shapes.push({ kind: 'line', pts });
      }
      return;
    }
    case 'Polygon': {
      const rings = readRings(node.coordinates, acc);
      if (rings.length > 0) acc.shapes.push({ kind: 'polygon', rings });
      return;
    }
    case 'MultiPolygon': {
      if (!Array.isArray(node.coordinates)) {
        acc.badCoords++;
        return;
      }
      for (const poly of node.coordinates) {
        const rings = readRings(poly, acc);
        if (rings.length > 0) acc.shapes.push({ kind: 'polygon', rings });
      }
      return;
    }
    default: {
      if (type === '') acc.error = 'GeoJSON 对象缺 type 字段';
      else acc.unsupported.push(type);
      return;
    }
  }
}

function parseGeoJson(text: string): GeoAcc {
  const acc = emptyAcc();
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    acc.error = `不是有效的 JSON：${e instanceof Error ? e.message : String(e)}`;
    return acc;
  }
  walkGeojson(root, acc, false);
  if (!acc.error && acc.shapes.length === 0) {
    acc.error = '没有解析出任何坐标（要素的 coordinates 为空或全非法）';
  }
  return acc;
}

/* ── KML（WebView2 原生 DOMParser；坐标是 `lon,lat[,alt]` 空格分隔）── */

function elementsNamed(root: Element, localName: string): Element[] {
  return [...root.getElementsByTagName('*')].filter((el) => el.localName === localName);
}

/** 取该几何元素下的第一个 `coordinates`（直接子优先，退化形态再下探）。 */
function firstCoordinates(el: Element): string | null {
  const direct = [...el.children].find((c) => c.localName === 'coordinates');
  if (direct) return direct.textContent;
  const deep = [...el.getElementsByTagName('*')].find((c) => c.localName === 'coordinates');
  return deep?.textContent ?? null;
}

function readKmlCoordinates(text: string | null, acc: GeoAcc): GeoPoint[] {
  if (!text || text.trim().length === 0) {
    acc.badCoords++;
    return [];
  }
  const out: GeoPoint[] = [];
  for (const tuple of text.trim().split(/\s+/)) {
    const parts = tuple.split(',');
    const lon = toNum(parts[0]);
    const lat = toNum(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      acc.badCoords++;
      continue;
    }
    out.push({ lon, lat });
  }
  return out;
}

/** 该元素的祖先里（到 stop 为止）有没有 `localName`——独立 LinearRing 与 Polygon 内的区分。 */
function hasAncestor(el: Element, localName: string, stop: Element): boolean {
  let p = el.parentElement;
  while (p && p !== stop) {
    if (p.localName === localName) return true;
    p = p.parentElement;
  }
  return false;
}

function parseKml(text: string): GeoAcc {
  const acc = emptyAcc();
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) {
    acc.error = `KML/XML 解析抛错：${e instanceof Error ? e.message : String(e)}`;
    return acc;
  }
  if (!doc.documentElement) {
    acc.error = 'KML/XML 解析没有产出根元素（空文档？）';
    return acc;
  }
  const parseErr = [...doc.getElementsByTagName('*')].find((el) => el.localName === 'parsererror');
  if (parseErr) {
    acc.error = `不是有效的 KML/XML：${(parseErr.textContent ?? '').trim().slice(0, 160)}`;
    return acc;
  }
  const placemarks = elementsNamed(doc.documentElement, 'Placemark');
  // 合法 KML 的几何可以不在 Placemark 里（裸几何）⇒ 没有 Placemark 时按整份文档扫
  const scopes = placemarks.length > 0 ? placemarks : [doc.documentElement];
  for (const pm of scopes) {
    const before = acc.shapes.length;
    for (const el of elementsNamed(pm, 'Point')) {
      const pts = readKmlCoordinates(firstCoordinates(el), acc);
      if (pts.length > 0) acc.shapes.push({ kind: 'point', p: pts[0] });
    }
    for (const el of elementsNamed(pm, 'LineString')) {
      const pts = readKmlCoordinates(firstCoordinates(el), acc);
      if (pts.length >= 2) acc.shapes.push({ kind: 'line', pts });
    }
    for (const el of elementsNamed(pm, 'Polygon')) {
      const rings = elementsNamed(el, 'LinearRing')
        .map((ring) => readKmlCoordinates(firstCoordinates(ring), acc))
        .filter((ring) => ring.length > 0);
      if (rings.length > 0) acc.shapes.push({ kind: 'polygon', rings });
    }
    for (const el of elementsNamed(pm, 'LinearRing')) {
      if (hasAncestor(el, 'Polygon', pm)) continue; // 已随所属 Polygon 成面
      const pts = readKmlCoordinates(firstCoordinates(el), acc);
      if (pts.length > 0) acc.shapes.push({ kind: 'polygon', rings: [pts] });
    }
    acc.features++;
    if (acc.shapes.length === before) acc.emptyFeatures++;
  }
  if (acc.shapes.length === 0) {
    acc.error = 'KML 里没有读到坐标（Point / LineString / Polygon 都没有可用的 coordinates）';
  }
  return acc;
}

/* ── 视图模型 ── */

function buildGeoView(text: string, ext: string): GeoView {
  const lines = text.length > 0 ? text.split('\n') : [];
  const truncated = lines.length > GEO_LINE_CAP;
  const window = (truncated ? lines.slice(0, GEO_LINE_CAP) : lines).join('\n');
  if (window.trim().length === 0) return { ...emptyAcc(), truncated };
  return { ...(ext === 'kml' ? parseKml(window) : parseGeoJson(window)), truncated };
}

/* ── 投影与绘制（等距圆柱；y 轴翻转——纬度向北为增，屏幕 y 向下）── */

interface GeoBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

interface GeoScene {
  viewBox: string;
  radius: number;
  stroke: number;
  bounds: GeoBounds;
}

/** 小数位收敛（度制给 6 位 ≈ 0.1 m，DOM 里不留浮点尾巴）。 */
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function buildGeoScene(shapes: GeoShape[]): GeoScene {
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  const visit = (p: GeoPoint): void => {
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  };
  for (const s of shapes) {
    if (s.kind === 'point') visit(s.p);
    else if (s.kind === 'line') for (const p of s.pts) visit(p);
    else for (const ring of s.rings) for (const p of ring) visit(p);
  }
  const w = maxLon - minLon;
  const h = maxLat - minLat;
  const extent = Math.max(w, h);
  // 退化（单点 / 单线 / 同一坐标）：取 0.01° 作参照尺度，盒不至于塌成 0 宽
  const scale = extent > 0 ? extent : DEGENERATE_SPAN;
  const pad = scale * 0.08;
  // 投影后的 y = −lat ⇒ bbox 在 y 上镜像
  const minY = -maxLat;
  return {
    viewBox: `${round(minLon - pad, 6)} ${round(minY - pad, 6)} ${round(w + 2 * pad, 6)} ${round(h + 2 * pad, 6)}`,
    radius: scale * 0.02,
    stroke: scale * 0.006,
    bounds: { minLon, maxLon, minLat, maxLat },
  };
}

/** 坐标 → SVG 用户单位（等距圆柱：x = lon，y = −lat）。 */
function project(p: GeoPoint): { x: number; y: number } {
  return { x: p.lon, y: -p.lat };
}

function pointsAttr(pts: GeoPoint[]): string {
  return pts.map((p) => `${round(p.lon, 6)},${round(-p.lat, 6)}`).join(' ');
}

/* ── 组件 ── */

function GeoViewer({ label, ext, bytes }: ViewerProps) {
  const text = bytes?.kind === 'text' ? bytes.value : '';
  const view = useMemo(() => buildGeoView(text, ext), [text, ext]);
  const format = ext === 'kml' ? 'KML' : 'GeoJSON';
  if (text.trim().length === 0) return <div className="pp-viewer-empty">文件为空（0 行）</div>;
  const truncNote = view.truncated ? `已截断：只读前 ${GEO_LINE_CAP} 行（文件更长）——要素可能不完整` : null;

  if (view.error || view.shapes.length === 0) {
    const rawLines = text.split('\n');
    const shown = rawLines.slice(0, RAW_LINE_CAP);
    const rawNote =
      rawLines.length > RAW_LINE_CAP
        ? `原文照显（只显示前 ${RAW_LINE_CAP} 行 / 共 ${rawLines.length} 行）——不猜几何`
        : `原文照显（${rawLines.length} 行）——不猜几何`;
    return (
      <div className="pp-viewer-geo">
        <div className="pp-viewer-error">
          {format} 解析失败：{view.error ?? '没有可绘制的要素'}
        </div>
        <div className="pp-viewer-box pp-viewer-geo-raw">
          <div className="pp-viewer-note">
            {rawNote}
            {truncNote ? ` · ${truncNote}` : ''}
          </div>
          <pre className="pp-viewer-geo-pre">{shown.join('\n')}</pre>
        </div>
      </div>
    );
  }

  const scene = buildGeoScene(view.shapes);
  const counts = { point: 0, line: 0, polygon: 0 };
  for (const s of view.shapes) counts[s.kind]++;
  const { bounds } = scene;
  const warns: string[] = [];
  if (view.badCoords > 0) warns.push(`${view.badCoords} 个要素坐标无法解析（非数字，已跳过）`);
  if (view.emptyFeatures > 0) warns.push(`${view.emptyFeatures} 个要素没有可解析的坐标`);
  if (view.unsupported.length > 0) {
    warns.push(`不支持的几何类型：${[...new Set(view.unsupported)].join('、')}（未绘制）`);
  }
  const readout = [
    `${view.features} 个要素`,
    `${counts.point} 点 / ${counts.line} 线 / ${counts.polygon} 面`,
    `边界 lon ${round(bounds.minLon, 4).toFixed(4)}–${round(bounds.maxLon, 4).toFixed(4)} · lat ${round(bounds.minLat, 4).toFixed(4)}–${round(bounds.maxLat, 4).toFixed(4)}`,
    '等距圆柱简图（非地图投影）',
  ].join(' · ');
  return (
    <div className="pp-viewer-box pp-viewer-geo">
      {truncNote && <div className="pp-viewer-note">{truncNote}</div>}
      <div className="pp-viewer-geo-meta">{readout}</div>
      {warns.map((w) => (
        <div className="pp-viewer-geo-warn" key={w}>
          {w}
        </div>
      ))}
      <div className="pp-viewer-geo-stage">
        <svg
          className="pp-viewer-geo-svg"
          viewBox={scene.viewBox}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`${label || format} · ${view.features} 个要素简图`}
        >
          {view.shapes.map((s, i) => {
            if (s.kind === 'point') {
              const p = project(s.p);
              return (
                <circle
                  // biome-ignore lint/suspicious/noArrayIndexKey: 要素按文件序渲染（无自然 id）
                  key={`point-${i}`}
                  className="pp-viewer-geo-point"
                  cx={round(p.x, 6)}
                  cy={round(p.y, 6)}
                  r={round(scene.radius, 6)}
                />
              );
            }
            if (s.kind === 'line') {
              return (
                <polyline
                  // biome-ignore lint/suspicious/noArrayIndexKey: 要素按文件序渲染（无自然 id）
                  key={`line-${i}`}
                  className="pp-viewer-geo-line"
                  points={pointsAttr(s.pts)}
                  strokeWidth={round(scene.stroke, 6)}
                />
              );
            }
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: 要素按文件序渲染（无自然 id）
              <g className="pp-viewer-geo-ring" key={`poly-${i}`}>
                {s.rings.map((ring, j) => (
                  <polygon
                    // biome-ignore lint/suspicious/noArrayIndexKey: 环按 KML/GeoJSON 环序渲染（外环在前）
                    key={`ring-${j}`}
                    className="pp-viewer-geo-poly"
                    points={pointsAttr(ring)}
                    strokeWidth={round(scene.stroke, 6)}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export const geoViewer: ViewerDef = {
  id: 'geo',
  exts: VIEWER_GEO_EXTS,
  needsBytes: true,
  bytesKind: 'text',
  readLines: GEO_LINE_CAP,
  maxBytes: GEO_MAX_CHARS,
  component: GeoViewer,
};
