// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 字体查看器（渲染面补全 B10，2026-09-23）——`@font-face` 动态装载（CSS Font Loading
// API：`new FontFace(...)` → `.load()` → `document.fonts.add(...)`）+ 一行常用字样本 +
// 受控输入行（输入的字用该字体显示）+ 字号阶梯（14/18/24/32px）。
//
// 认领表真源 = `paper/viewer-exts.ts` 的 `VIEWER_FONT_EXTS`（宿主层单一真源：认领与
// 静态测高同一张表）；字节形态 = `data-uri`（宿主走 `fs_cap read_base64` 拼
// `data:font/ttf;base64,...`，可直接喂 `FontFace` 的 `url()`）。
//
// 失败面**逐条可读**（不空白、不 JSON 兜底）：
//   宿主缺 CSS Font Loading API（`document.fonts` 缺席——jsdom 就是这种）⇒ 一行
//   「当前环境不支持字体预览」，**文件身份照旧出**（文件名 / 扩展名 / 字节数）；
//   `.load()` 失败 ⇒ 带原因的装载错误行；字节没取到 ⇒ 可读错误 + 路径。
//   预览不可用的两个分支都不画样本（拿回退字体冒充「该字体的字形」是误导，不是降级）。
//
// 归属（CONVENTIONS §1.10）：本件模块级只有冻结常量表（家族名 / 样本字表 / 字号阶梯）；
// 装载的 FontFace 在 effect 清理里 `document.fonts.delete` 对称摘除（同族反复注册会累积，
// 而纸上换一个字体文件就是一次注册）。

import { VIEWER_FONT_EXTS } from '../../../../paper/viewer-exts';
import { rendererHooks } from '../renderer-host';
import type { ViewerDef, ViewerProps } from '../viewer-registry';
import './font.css';

const { useEffect, useState } = rendererHooks;

/** 装载家族名（清理时按这个引用对称摘除）。 */
const FONT_FAMILY = 'pp-viewer-font-sample';

/** 常用字样本（《兰亭集序》开篇：常用汉字覆盖；西文/数字见阶梯行）。 */
const SAMPLE_TEXT = '永和九年，岁在癸丑，暮春之初，会于会稽山阴之兰亭';
const LADDER_TEXT = '永和九年 Aa 123';
const SAMPLE_PX = 24;
/** 字号阶梯（施工单 B10 点名 14/18/24/32；内联 px，不进 token 面）。 */
const LADDER_PX = [14, 18, 24, 32] as const;

/** 字节上限：base64 走 IPC 与 DOM 字符串（4/3 膨胀），超大字体宁可退回文件壳。 */
const FONT_MAX_BYTES = 8 * 1024 * 1024;

type FontLoad =
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'ready' }
  | { status: 'error'; reason: string };

/** 失败原因（Error / 非 Error 都成句；空消息不落成空白）。 */
function reasonOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const text = String(e);
  return text === '[object Object]' ? '未知原因' : text;
}

/** data URI → 原始字节数（非 base64 形态按字符数近似；解不出 = null → 文案说「未知」）。 */
function dataUriByteSize(uri: string): number | null {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const payload = uri.slice(comma + 1);
  if (!/;base64/i.test(uri.slice(0, comma))) return payload.length;
  const pad = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - pad);
}

/** 字节 → 读数（上限 MB 级；一位小数，与壳件降级文案同款）。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FontViewer({ label, ext, filePath, bytes, mode }: ViewerProps) {
  const src = bytes?.kind === 'data-uri' ? bytes.value : undefined;
  const [load, setLoad] = useState<FontLoad>({ status: 'loading' });
  const [sample, setSample] = useState('');

  useEffect(() => {
    if (!src) return;
    // 环境判据（施工单钉死）：无 `document.fonts` 的宿主做不了动态装载——预览不可用，
    // 但文件身份照显（渲染分支里 meta 恒在，不是空白）。
    if (typeof document === 'undefined' || !('fonts' in document)) {
      setLoad({ status: 'unsupported' });
      return;
    }
    let cancelled = false;
    let added: FontFace | null = null;
    setLoad({ status: 'loading' });
    let face: FontFace;
    try {
      face = new FontFace(FONT_FAMILY, `url(${src})`);
    } catch (e) {
      setLoad({ status: 'error', reason: reasonOf(e) });
      return;
    }
    face
      .load()
      .then((loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        added = loaded;
        setLoad({ status: 'ready' });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoad({ status: 'error', reason: reasonOf(e) });
      });
    return () => {
      cancelled = true;
      // 宿主在卸载前后撤掉 Font Loading API 也要活（判据与装载分支同源）
      if (added && typeof document !== 'undefined' && 'fonts' in document) document.fonts.delete(added);
    };
  }, [src]);

  // 字体没有放大形态（浮层由宿主渲染，但「点击看大图」语义对字体无意义）
  if (mode === 'overlay') return null;

  const size = src ? dataUriByteSize(src) : null;
  const meta = (
    <div className="pp-viewer-font-meta">
      <span className="pp-viewer-font-meta-name">{label || filePath || '字体文件'}</span>
      {ext && <span className="pp-viewer-font-meta-ext">{ext}</span>}
      <span className="pp-viewer-font-meta-size">{size == null ? '字节数未知' : `约 ${formatBytes(size)}`}</span>
    </div>
  );

  if (!src) {
    return (
      <div className="pp-viewer-font">
        {meta}
        <div className="pp-viewer-error">字体字节不可读：宿主未提供文件内容{filePath ? `（${filePath}）` : ''}</div>
      </div>
    );
  }

  if (load.status !== 'ready') {
    return (
      <div className="pp-viewer-font">
        {meta}
        <div className="pp-viewer-box">
          {load.status === 'error' ? (
            <div className="pp-viewer-error">字体装载失败：{load.reason}</div>
          ) : (
            <div className="pp-viewer-note">
              {load.status === 'unsupported'
                ? '当前环境不支持字体预览（宿主缺 CSS Font Loading API）——只列文件信息'
                : '正在装载字体…'}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pp-viewer-font">
      {meta}
      <div className="pp-viewer-box">
        <div className="pp-viewer-note">
          已装载：{FONT_FAMILY}（{ext ? ext.toUpperCase() : '未知格式'}）
        </div>
        <div className="pp-viewer-font-sample" style={{ fontSize: `${SAMPLE_PX}px` }}>
          {SAMPLE_TEXT}
        </div>
        <div className="pp-viewer-font-custom">
          <input
            className="pp-viewer-font-input"
            type="text"
            value={sample}
            aria-label="字形样张输入"
            placeholder="在此输入几个字，用该字体显示"
            onChange={(e) => setSample(e.target.value)}
          />
          <div className="pp-viewer-font-custom-line" style={{ fontSize: `${SAMPLE_PX}px` }}>
            {sample.length > 0 ? sample : SAMPLE_TEXT}
          </div>
        </div>
        <div className="pp-viewer-font-ladder">
          {LADDER_PX.map((px) => (
            <div key={px} className="pp-viewer-font-ladder-item" style={{ fontSize: `${px}px` }}>
              {LADDER_TEXT}
              <span className="pp-viewer-font-ladder-px">{px}px</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const fontViewer: ViewerDef = {
  id: 'font',
  exts: VIEWER_FONT_EXTS,
  needsBytes: true,
  bytesKind: 'data-uri',
  mimes: { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' },
  maxBytes: FONT_MAX_BYTES,
  component: FontViewer,
};
