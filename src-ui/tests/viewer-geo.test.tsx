// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-geo — 地理数据查看器（渲染面补全 P1 · B12 之一，2026-09-23）：
//   ① 认领面：geojson/kml 路由到 'geo'，且认领表**就是**宿主层分类表（同一常量）；
//   ② 文本读取形态：宿主走 `fs_cap read` 的**行窗口**（limit = readLines + 1 = 6001）；
//   ③ GeoJSON 归一化：FeatureCollection / 单 Feature / 裸 Geometry 都接；
//      点 = 圆、线 = 折线、面 = 闭合轮廓（Multi* 与洞一并画）；
//   ④ 读数行：N 个要素 + 边界 bbox 四位小数（等距圆柱投影下的经纬包围盒）；
//   ⑤ KML：原生 DOMParser → Placemark 的 Point/Polygon（`lon,lat[,alt]` 空格分隔）；
//   ⑥ 失败面：坏 JSON / 坏 XML ⇒ 可读错误行 + 原文照显（不空白、不 JSON 兜底）；
//   ⑦ 坐标非法（非数字）⇒ 「N 个要素坐标无法解析」计数提示，不静默略过。
//
// 注册纪律：出厂注册行由 `viewers/index.ts` 持有（本批不抢占该文件）；本文件自己
// 注册一次并在收尾 dispose——若 index.ts 的注册行已落地（同一 def 实例已注册），
// 本次注册自动跳过（重名会装载期 throw，那是注册面的防双跑纪律）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_GEO_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { geoViewer } from '../src/plugins/builtin/renderers/viewers/geo';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/** 读口成功响应（`fs_cap read` 的文本结局：{path, content}）。 */
function readOk(content: string): string {
  return JSON.stringify({ path: 'D:/a.geojson', content: content });
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  await fn();
  await f3.dispose();
  await f2.dispose();
  await f1.dispose();
}

function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

/* ── fixture：GeoJSON ── */

/** FeatureCollection：1 个 Point + 1 条 LineString（包围盒 lon 116.30–116.50 / lat 39.85–39.9093）。 */
const GEOJSON_FC = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: '点' },
      geometry: { type: 'Point', coordinates: [116.3974, 39.9093] },
    },
    {
      type: 'Feature',
      properties: { name: '线' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [116.3, 39.85],
          [116.5, 40.0],
        ],
      },
    },
  ],
});

/** 面族：Polygon（外环 + 洞，2 环）+ MultiPolygon（2 个单环面）。 */
const GEOJSON_POLY = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
            [0, 0],
          ],
          [
            [0.5, 0.5],
            [1, 0.5],
            [1, 1],
            [0.5, 1],
            [0.5, 0.5],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [10, 10],
              [11, 10],
              [11, 11],
              [10, 10],
            ],
          ],
          [
            [
              [20, 20],
              [21, 20],
              [21, 21],
              [20, 20],
            ],
          ],
        ],
      },
    },
  ],
});

/** 非法坐标：一条 Point 的 lon 不是数字（必须计入提示，不静默丢掉）。 */
const GEOJSON_BAD_COORD = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: ['abc', 39.9] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 'def'] } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] } },
  ],
});

/* ── fixture：KML（`lon,lat[,alt]` 空格分隔）── */

const KML_OK = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<kml xmlns="http://www.opengis.net/kml/2.2">',
  '  <Document>',
  '    <Placemark><name>点</name>',
  '      <Point><coordinates>116.3974,39.9093,0</coordinates></Point>',
  '    </Placemark>',
  '    <Placemark><name>面</name>',
  '      <Polygon><outerBoundaryIs><LinearRing><coordinates>',
  '        116.30,39.85,0 116.50,39.85,0 116.50,40.00,0 116.30,40.00,0 116.30,39.85,0',
  '      </coordinates></LinearRing></outerBoundaryIs></Polygon>',
  '    </Placemark>',
  '  </Document>',
  '</kml>',
].join('\n');

const KML_BAD_COORD = [
  '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
  '  <Placemark><Point><coordinates>abc,39.9 116.4,39.9</coordinates></Point></Placemark>',
  '</Document></kml>',
].join('\n');

/** 本文件全程持有注册（**文件级**——挂在某个 describe 上会随该块收尾被 dispose，
 *  后面的渲染用例就落到兜底查看器上去了）。 */
let disposeGeo: (() => void) | null = null;

beforeAll(() => {
  if (!viewerRegistry.get(geoViewer.id)) disposeGeo = viewerRegistry.register(geoViewer);
});

afterAll(() => {
  disposeGeo?.();
  disposeGeo = null;
});

describe('地理查看器 · 认领面（B12）', () => {
  it('认领表就是宿主层分类表（同一常量引用，两侧不可能漂）', () => {
    expect(geoViewer.exts).toBe(VIEWER_GEO_EXTS);
    expect([...VIEWER_GEO_EXTS]).toEqual(['geojson', 'kml']);
    for (const ext of ['geojson', 'kml']) {
      expect(viewerClassOf(ext), ext).toBe('geo');
      expect(viewerRegistry.resolve(ext)?.id, ext).toBe('geo');
    }
  });

  it('文本形态 + 行窗口 + 体积闸（与 code 查看器同一条纪律）', () => {
    expect(geoViewer.bytesKind).toBe('text');
    expect(geoViewer.readLines).toBe(6000);
    expect(geoViewer.maxBytes).toBe(2 * 1024 * 1024);
    expect(geoViewer.mimes).toBeUndefined(); // 文本形态不拼 data URI
  });
});

describe('地理查看器 · GeoJSON 出图与失败面（B12）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function renderGeo(payload: unknown): Promise<void> {
    const Comp = resolveAssetBlock('file', 'media')!;
    root?.unmount();
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('文本读取走 fs_cap read 的**行窗口**（limit = readLines + 1 = 6001），题名行在', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(GEOJSON_FC));
    await withRenderers(async () => {
      await renderGeo({ filePath: 'D:/a.geojson', ext: 'geojson', label: 'a.geojson' });
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/a.geojson',
        limit: 6001,
        is_agent: false,
      });
      expect(container.querySelector('.pp-viewer-label')?.textContent).toBe('a.geojson');
    });
  });

  it('⑤ FeatureCollection 出 SVG：Point 画圆、LineString 画折线 + 读数行（要素数 + bbox 四位小数）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(GEOJSON_FC));
    await withRenderers(async () => {
      await renderGeo({ filePath: 'D:/a.geojson', ext: 'geojson', label: 'a.geojson' });
      expect(container.querySelector('.pp-viewer-geo-svg')).not.toBeNull();
      expect(container.querySelectorAll('.pp-viewer-geo-point').length).toBe(1);
      expect(container.querySelectorAll('.pp-viewer-geo-line').length).toBe(1);
      const meta = container.querySelector('.pp-viewer-geo-meta')?.textContent ?? '';
      expect(meta).toContain('2 个要素');
      expect(meta).toContain('1 点 / 1 线 / 0 面');
      expect(meta).toContain('lon 116.3000–116.5000');
      expect(meta).toContain('lat 39.8500–40.0000'); // bbox = 全体坐标（点落在线围出的框内）
      // viewBox 按全体坐标包围盒自适应（不是写死的方盒）
      const vb = container.querySelector('.pp-viewer-geo-svg')?.getAttribute('viewBox') ?? '';
      expect(vb.split(' ').length).toBe(4);
      expect(Number.parseFloat(vb.split(' ')[0])).toBeLessThan(116.3);
    });
  });

  it('归一化：FeatureCollection / 单 Feature / 裸 Geometry 三形态都出图', async () => {
    await withRenderers(async () => {
      vi.mocked(typedRpc).mockResolvedValue(readOk(JSON.stringify({ type: 'Point', coordinates: [1, 2] })));
      await renderGeo({ filePath: 'D:/p.geojson', ext: 'geojson', label: 'p.geojson' });
      expect(container.querySelectorAll('.pp-viewer-geo-point').length).toBe(1);
      expect(container.querySelector('.pp-viewer-geo-meta')?.textContent).toContain('1 个要素');

      vi.mocked(typedRpc).mockResolvedValue(
        readOk(
          JSON.stringify({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          }),
        ),
      );
      await renderGeo({ filePath: 'D:/l.geojson', ext: 'geojson', label: 'l.geojson' });
      expect(container.querySelectorAll('.pp-viewer-geo-line').length).toBe(1);
      expect(container.querySelector('.pp-viewer-geo-meta')?.textContent).toContain('1 个要素');

      vi.mocked(typedRpc).mockResolvedValue(
        readOk(
          JSON.stringify({
            type: 'GeometryCollection',
            geometries: [
              {
                type: 'MultiPoint',
                coordinates: [
                  [1, 1],
                  [2, 2],
                ],
              },
              {
                type: 'LineString',
                coordinates: [
                  [0, 0],
                  [3, 3],
                ],
              },
            ],
          }),
        ),
      );
      await renderGeo({ filePath: 'D:/g.geojson', ext: 'geojson', label: 'g.geojson' });
      expect(container.querySelectorAll('.pp-viewer-geo-point').length).toBe(2);
      expect(container.querySelectorAll('.pp-viewer-geo-line').length).toBe(1);
      expect(container.querySelector('.pp-viewer-geo-meta')?.textContent).toContain('1 个要素');
    });
  });

  it('面族：Polygon（含洞）与 MultiPolygon 都画闭合轮廓（环足数出，读数「面」按形状计）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(GEOJSON_POLY));
    await withRenderers(async () => {
      await renderGeo({ filePath: 'D:/poly.geojson', ext: 'geojson', label: 'poly.geojson' });
      expect(container.querySelectorAll('.pp-viewer-geo-poly').length).toBe(4); // 2 环（外环 + 洞）+ 2 个单环面
      const meta = container.querySelector('.pp-viewer-geo-meta')?.textContent ?? '';
      expect(meta).toContain('2 个要素');
      expect(meta).toContain('0 点 / 0 线 / 3 面'); // 面 = 形状数（Polygon 1 + MultiPolygon 2 部分）
      expect(container.querySelector('.pp-viewer-geo-warn')).toBeNull(); // 合法数据不出提示行
    });
  });

  it('⑦ 非法坐标（非数字）→ 计数提示行，不静默略过', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(GEOJSON_BAD_COORD));
    await withRenderers(async () => {
      await renderGeo({ filePath: 'D:/bad.geojson', ext: 'geojson', label: 'bad.geojson' });
      const warn = container.querySelector('.pp-viewer-geo-warn')?.textContent ?? '';
      expect(warn).toContain('2 个要素坐标无法解析');
      expect(warn).toContain('非数字');
      // 合法的那条照画（坏的不连累好的）
      expect(container.querySelectorAll('.pp-viewer-geo-point').length).toBe(1);
      expect(container.querySelector('.pp-viewer-geo-meta')?.textContent).toContain('3 个要素');
    });
  });

  it('⑥ 坏 JSON → 可读错误行 + 原文照显（不空白、不 JSON 兜底）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('{不是 json'));
    await withRenderers(async () => {
      await renderGeo({ filePath: 'D:/bad.geojson', ext: 'geojson', label: 'bad.geojson' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('GeoJSON 解析失败');
      expect(err).toContain('不是有效的 JSON');
      expect(container.querySelector('.pp-viewer-geo-pre')?.textContent).toContain('{不是 json');
      expect(container.querySelector('.pp-viewer-geo-svg')).toBeNull();
    });
  });

  it('合法 JSON 但没有坐标（空 FeatureCollection）→ 错误行 + 原文，不出空图', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(JSON.stringify({ type: 'FeatureCollection', features: [] })));
    await withRenderers(async () => {
      await renderGeo({ filePath: 'D:/empty.geojson', ext: 'geojson', label: 'empty.geojson' });
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('没有解析出任何坐标');
      expect(container.querySelector('.pp-viewer-geo-svg')).toBeNull();
    });
  });
});

describe('地理查看器 · KML 出图与失败面（B12）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function renderKml(payload: unknown): Promise<void> {
    const Comp = resolveAssetBlock('file', 'media')!;
    root?.unmount();
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('⑥ KML：Placemark 的 Point 出圆、Polygon 出闭合轮廓（lon,lat 空格分隔）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(KML_OK));
    await withRenderers(async () => {
      await renderKml({ filePath: 'D:/a.kml', ext: 'kml', label: 'a.kml' });
      expect(container.querySelectorAll('.pp-viewer-geo-point').length).toBe(1);
      expect(container.querySelectorAll('.pp-viewer-geo-poly').length).toBe(1);
      const poly = container.querySelector('.pp-viewer-geo-poly');
      expect(poly?.getAttribute('points')?.split(' ').length).toBe(5); // 外环 5 个顶点（含闭合点）
      const meta = container.querySelector('.pp-viewer-geo-meta')?.textContent ?? '';
      expect(meta).toContain('2 个要素');
      expect(meta).toContain('1 点 / 0 线 / 1 面');
      expect(meta).toContain('lon 116.3000–116.5000');
    });
  });

  it('KML 坐标非法 → 计数提示行（同上一条纪律，两种格式同一套判据）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(KML_BAD_COORD));
    await withRenderers(async () => {
      await renderKml({ filePath: 'D:/bad.kml', ext: 'kml', label: 'bad.kml' });
      expect(container.querySelector('.pp-viewer-geo-warn')?.textContent).toContain('1 个要素坐标无法解析');
      expect(container.querySelectorAll('.pp-viewer-geo-point').length).toBe(1);
    });
  });

  it('坏 XML → 可读错误行 + 原文照显（DOMParser 的 parsererror 不当成「空图」）', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk('<kml><Placemark><Point>'));
    await withRenderers(async () => {
      await renderKml({ filePath: 'D:/bad.kml', ext: 'kml', label: 'bad.kml' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('KML 解析失败');
      expect(err).toContain('不是有效的 KML/XML');
      expect(container.querySelector('.pp-viewer-geo-pre')?.textContent).toContain('<kml><Placemark><Point>');
      expect(container.querySelector('.pp-viewer-geo-svg')).toBeNull();
    });
  });

  it('KML 没有坐标（只有样式/描述）→ 错误行，不静默出空图', async () => {
    const noCoords = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>空</name></Document></kml>';
    vi.mocked(typedRpc).mockResolvedValue(readOk(noCoords));
    await withRenderers(async () => {
      await renderKml({ filePath: 'D:/none.kml', ext: 'kml', label: 'none.kml' });
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('没有读到坐标');
      expect(container.querySelector('.pp-viewer-geo-svg')).toBeNull();
    });
  });

  it('空文件 → 明说「文件为空（0 行）」，不留空白盒', async () => {
    vi.mocked(typedRpc).mockResolvedValue(readOk(''));
    await withRenderers(async () => {
      await renderKml({ filePath: 'D:/a.kml', ext: 'kml', label: 'a.kml' });
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('文件为空');
      expect(container.querySelector('.pp-viewer-geo')).toBeNull();
    });
  });
});
