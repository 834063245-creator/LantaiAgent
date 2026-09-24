// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 3D 模型查看器（渲染面补全 P2 · B9，2026-09-23）——**重依赖**查看器本体（three.js）：
// 随**应用 bundle** 编译（vite 真分片，见 vite.config.ts 的 manualChunks.three）。产物侧只登记
// 认领与读取形态（`plugins/builtin/renderers/viewers/model3d.ts` 的 `heavy: 'model3d'`），
// 宿主经宿主桥 `loadViewer('model3d')` 取本件（`app/paper/viewers/index.ts` 的目录即白名单：
// 文件名 = 取件键 + **default 导出**）。
//
// 形态：glb / gltf（GLTFLoader）· obj（OBJLoader）· stl（STLLoader）。字节是宿主给的
// data URI（`fs_cap read_base64` 拼出）——`atob` → ArrayBuffer 后交给各 loader 的
// `parse` / `parseAsync`，**绝不走 `loader.load(url)`**（Tauri WebView 拦裸本地路径，
// 宿主改给 data URI 正是这个原因）。
//
// 两态（D2 载体契约）：
//   · `mode='stream'`（流内）＝**静态首帧**（渲染一帧即停，不挂 rAF）+ 读数行
//     （文件名 / 格式 / 字节数 / 三角面数 / 顶点数 / 包围盒尺寸）+ 点一下 → `onOpenOverlay()`；
//     版心 / 窗口尺寸变化时补渲一帧（仍不是动画循环）。
//   · `mode='overlay'`（浮层）＝可交互：OrbitControls（左键轨道 / 滚轮缩放 / 右键平移）
//     + 线框切换；挂 rAF 循环（阻尼需要连续帧）。
//   · `pinned` / `panel` 容器本批不落地（D2）⇒ 按静态态渲染（读数 + 首帧）。
//
// 边界（如实标注，一条都不静默）：
//   · **DRACO / KTX2 / meshopt 不接**：three 的解码器是随包的 wasm/js 资产（DRACOLoader 要
//     `setDecoderPath` 指到 wasm 目录、KTX2Loader 要 `detectSupport(renderer)`、meshopt 要 wasm），
//     接进来的成本高于本查看器的收益 ⇒ **不接**。命中 `KHR_draco_mesh_compression` /
//     `KHR_texture_basisu` / `EXT_meshopt_compression` 时**明确报错**（「该模型使用了
//     DRACO/KTX2 压缩…本查看器未启用解码器」），**不静默显示空场景**。
//   · **无 WebGL 环境**（jsdom / 老机器 / 无 GPU）：`new WebGLRenderer` 构造即抛——接住并出
//     一行「当前环境不支持 WebGL，无法预览 3D」，**读数行照显**（读数来自解析，与 GPU 无关），
//     盒高不变（同一 `.pp-viewer-3d-stage` 盒里出提示）——不空白、不崩、不塌。
//   · glTF 的**外部资源**（buffer / image 按 URI 引用而非内嵌）取不到：本件只有单文件字节、
//     没有 base path ⇒ 解析如实失败（不假装加载成功）。
//   · OBJ 的 `.mtl` / 贴图不解析（同因：只有单文件字节）⇒ 中性材质渲染，几何正确、表面无色。
//   · glTF 动画不播放（静态首帧 + 交互仍是静态姿态）；不做单位归一（包围盒就是文件里
//     的原始数值，不假设米/毫米）；不做环境贴图以外的光照编辑。
//
// 内存纪律（three 资源不 dispose 必泄漏，成对释放写在一个 effect 的清理函数里）：
// 解析出的对象树 → geometry / material / texture；渲染侧 → renderer（含 PMREM 环境贴图）/
// OrbitControls / rAF / ResizeObserver。
//
// 模块级归属（CONVENTIONS §1.10）：本件模块级只有冻结常量表（上限字节数 / 压缩扩展名表），
// 无跨实例可变态。

import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Box3,
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  type Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { normalizeExt, type ViewerProps } from '../../../paper/viewer-contract';
import { VIEWER_MODEL_EXTS } from '../../../paper/viewer-exts';
import './model3d.css';

/** 与产物侧 def 的 `maxBytes` 同值（32 MiB）——宿主已按此预检，这里兜第二道（防御式）。 */
const MAX_BYTES = 32 * 1024 * 1024;

/** 相机取景留边系数（1.6 ⇒ 模型最长轴约占视口 2/3）。 */
const FRAME_MARGIN = 1.6;

/** 压缩扩展：three 需另接 wasm/js 解码器 ⇒ 本查看器**不接**，命中即具名报错。 */
const COMPRESSED_EXTENSIONS: readonly string[] = [
  'KHR_draco_mesh_compression',
  'KHR_texture_basisu',
  'EXT_meshopt_compression',
];

interface ModelStats {
  triangles: number;
  vertices: number;
  /** 包围盒三轴尺寸（各 2 位小数；空树 = 「未知」，不印 Infinity） */
  size: string;
}

interface ParsedModel {
  object: Object3D;
  stats: ModelStats;
}

type LoadState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'ready'; model: ParsedModel }
  | { status: 'error'; message: string };

/** 失败原因成句（Error / 非 Error 都要；空消息不落成空白）。 */
function reasonOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const text = String(e);
  return text === '[object Object]' ? '未知原因' : text;
}

/** 字节 → 读数（B / KB / MB，一位小数——同壳件降级文案口径）。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** data URI → 原始字节数（base64 形态；解不出 = null → 文案说「未知」，不假装 0）。 */
function dataUriByteSize(uri: string): number | null {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const payload = uri.slice(comma + 1);
  if (!/;base64/i.test(uri.slice(0, comma))) return payload.length;
  const pad = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - pad);
}

/** data URI（base64）→ 原始字节。宿主给的就是这个形态；`atob` 抛 = 可读错误（不静默）。 */
function decodeDataUri(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('不是合法的 data URI（缺逗号分隔的元信息段）');
  const meta = uri.slice(0, comma);
  if (!/;base64/i.test(meta)) throw new Error(`只支持 base64 形态的 data URI（收到「${meta}」）`);
  const binary = atob(uri.slice(comma + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/** glb 容器的 JSON 块（12 字节头 + 块头 length/type；第一块即 JSON）。读不出 = null。 */
function glbJsonText(buf: ArrayBuffer): string | null {
  if (buf.byteLength < 20) return null;
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
  if (view.getUint32(16, true) !== 0x4e4f534a) return null; // 'JSON'
  const chunkLength = view.getUint32(12, true);
  const end = Math.min(buf.byteLength, 20 + chunkLength);
  return new TextDecoder().decode(new Uint8Array(buf, 20, end - 20));
}

/** 字符串数组字段（extensionsUsed / extensionsRequired 都是可选字段）。 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** glTF 的压缩扩展名（**解析前**拦：GLTFLoader 自己抛的是内部文案
 *  「No DRACOLoader instance provided」，对用户不可读）。读不出来 = 空表（坏文件交给
 *  loader 报它自己的错，这里不掩盖真因）。 */
function compressedExtensions(ext: string, buf: ArrayBuffer): string[] {
  try {
    const text = ext === 'gltf' ? new TextDecoder().decode(buf) : glbJsonText(buf);
    if (text === null) return [];
    const json = JSON.parse(text) as { extensionsUsed?: unknown; extensionsRequired?: unknown };
    const names = [...stringList(json.extensionsUsed), ...stringList(json.extensionsRequired)];
    return [...new Set(names)].filter((name) => COMPRESSED_EXTENSIONS.includes(name));
  } catch {
    return [];
  }
}

/** 材质归一（Mesh 的 material 可能是数组）。 */
function materialList(material: Material | Material[]): Material[] {
  return Array.isArray(material) ? material : [material];
}

/** 读数：三角面数（`index.count/3` 或 `position.count/3`）/ 顶点数 / 包围盒三轴尺寸。 */
function modelStats(root: Object3D): ModelStats {
  let triangles = 0;
  let vertices = 0;
  root.traverse((child) => {
    if ((child as Mesh).isMesh !== true) return;
    const geometry = (child as Mesh).geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    vertices += position.count;
    triangles += (geometry.index ? geometry.index.count : position.count) / 3;
  });
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  return {
    triangles: Math.floor(triangles),
    vertices,
    size: box.isEmpty() ? '未知' : `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`,
  };
}

/** 释放解析出的对象树：几何体 → 材质（可能是数组）→ 材质上挂的贴图。 */
function disposeObject(root: Object3D): void {
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((child) => {
    const holder = child as Partial<Mesh>;
    if (holder.geometry) holder.geometry.dispose();
    if (holder.material) for (const material of materialList(holder.material)) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && (value as Texture).isTexture === true) {
        textures.add(value as Texture);
      }
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}

/** 线框切换：逐个翻 `wireframe`（材质可能是数组）；bump `needsUpdate` 让 program 缓存失效。 */
function applyWireframe(root: Object3D, on: boolean): void {
  root.traverse((child) => {
    if ((child as Mesh).isMesh !== true) return;
    for (const material of materialList((child as Mesh).material)) {
      const toggleable = material as Material & { wireframe?: boolean };
      if (typeof toggleable.wireframe !== 'boolean') continue;
      toggleable.wireframe = on;
      material.needsUpdate = true;
    }
  });
}

/** 场景配色取自纸面 token（`--paper` / `--paper-deep`）——JS 里不写死色值；
 *  取不到（非浏览器 / token 未注入）时退回 CSS 关键字（中性，不带品牌色偏移）。 */
function tokenColor(el: HTMLElement, name: string, fallback: string): Color {
  const raw = typeof getComputedStyle === 'function' ? getComputedStyle(el).getPropertyValue(name).trim() : '';
  return new Color(/^#[0-9a-f]{3,8}$/i.test(raw) ? raw : fallback);
}

/** 相机取景（按包围盒摆位），返回轨道中心（`controls.target`）。
 *  空 / 退化模型兜 span=1——不把相机摆到 NaN 上。 */
function frameCamera(camera: PerspectiveCamera, root: Object3D): Vector3 {
  const box = new Box3().setFromObject(root);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  const span = Number.isFinite(longest) && longest > 0 ? longest : 1;
  const distance = (span / 2 / Math.tan(((camera.fov / 2) * Math.PI) / 180)) * FRAME_MARGIN;
  camera.position.copy(center).addScaledVector(new Vector3(1, 0.75, 1).normalize(), distance);
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance * 1000;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  return center;
}

/** 解析：glb/gltf → GLTFLoader · obj → OBJLoader · stl → STLLoader（全是纯计算，与 GPU 无关）。 */
async function parseModel(ext: string, buf: ArrayBuffer): Promise<ParsedModel> {
  if (!VIEWER_MODEL_EXTS.includes(ext)) {
    throw new Error(`未认领的扩展名「${ext}」（本查看器只认 ${VIEWER_MODEL_EXTS.join(' / ')}）`);
  }
  if (ext === 'glb' || ext === 'gltf') {
    const compressed = compressedExtensions(ext, buf);
    if (compressed.length > 0) {
      throw new Error(`该模型使用了 DRACO/KTX2 压缩（${compressed.join(' / ')}），本查看器未启用解码器`);
    }
  }
  let object: Object3D;
  if (ext === 'stl') {
    // STL 无材质信息 ⇒ 中性白石膏质感（光照带纸色）；双面渲染（STL 绕序常年不统一）
    object = new Mesh(new STLLoader().parse(buf), new MeshStandardMaterial({ side: DoubleSide }));
  } else if (ext === 'obj') {
    object = new OBJLoader().parse(new TextDecoder().decode(buf));
  } else {
    const data: ArrayBuffer | string = ext === 'gltf' ? new TextDecoder().decode(buf) : buf;
    object = (await new GLTFLoader().parseAsync(data, '')).scene;
  }
  return { object, stats: modelStats(object) };
}

export default function Model3dViewer({ label, ext, filePath, bytes, mode, onOpenOverlay }: ViewerProps) {
  const interactive = mode === 'overlay';
  const normalizedExt = normalizeExt(ext);
  const dataUri = bytes?.kind === 'data-uri' ? bytes.value : undefined;
  // 依赖面只收**基元**（bytes 是宿主每次渲染新建的对象——收它会让解析 effect 无谓重跑）
  const bytesKind = bytes?.kind ?? null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [webglError, setWebglError] = useState<string | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const model = state.status === 'ready' ? state.model : null;

  // ① 解析（纯计算：jsdom / 无 WebGL 也能跑；读数就来自这一步，与 GPU 无关）
  useEffect(() => {
    setWebglError(null);
    if (bytesKind === null) {
      setState({ status: 'empty' });
      return;
    }
    if (dataUri === undefined) {
      setState({ status: 'error', message: `字节形态不是 data URI（收到「${bytesKind}」）——3D 查看器只收二进制` });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const buf = decodeDataUri(dataUri);
        if (buf.byteLength === 0) throw new Error('文件为空（0 字节）——没有可解析的模型数据');
        if (buf.byteLength > MAX_BYTES) {
          throw new Error(
            `约 ${formatBytes(buf.byteLength)} 超过 ${formatBytes(MAX_BYTES)} 上限——不做截断解析（截断的模型不是模型）`,
          );
        }
        const parsed = await parseModel(normalizedExt, buf);
        if (cancelled) {
          disposeObject(parsed.object); // 在途结果：本组件已不再需要，就地释放（不留给 GC 猜）
          return;
        }
        setState({ status: 'ready', model: parsed });
      } catch (e) {
        if (!cancelled) setState({ status: 'error', message: reasonOf(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytesKind, dataUri, normalizedExt]);

  // ② 线框态跟随（浮层工具条切换；新装载的模型也跟上当前态）
  useEffect(() => {
    if (!model) return;
    applyWireframe(model.object, wireframe);
  }, [model, wireframe]);

  // ③ 渲染：流内 = 静态首帧（一帧即停）；浮层 = rAF 循环 + OrbitControls
  useEffect(() => {
    if (!model) return;
    const canvas = canvasRef.current;
    const host = canvas?.parentElement ?? null;
    if (!canvas || !host) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (e) {
      // 无 WebGL（jsdom / 老机器 / 无 GPU）：构造即抛——出可读提示，读数行照显（不空白、不崩）
      setWebglError(reasonOf(e));
      return;
    }
    setWebglError(null);

    const scene = new Scene();
    const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
    const center = frameCamera(camera, model.object);
    scene.add(model.object);

    // 灯光（纸色主光 + 纸底环境光；PBR 材质无明显环境光会发闷）
    const key = tokenColor(host, '--paper', 'white');
    const ground = tokenColor(host, '--paper-deep', 'gainsboro');
    scene.add(new HemisphereLight(key, ground, 2.2));
    const sun = new DirectionalLight(key, 2.4);
    sun.position.set(1, 1.6, 1);
    scene.add(sun);

    // 环境贴图（金属 / 粗糙度材质需要；RoomEnvironment 是随包的中性室内光）
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04);
    scene.environment = env.texture;
    room.dispose();
    pmrem.dispose();

    const controls = interactive ? new OrbitControls(camera, canvas) : null;
    if (controls) {
      controls.target.copy(center);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.update();
    }

    const draw = (): void => {
      renderer.render(scene, camera);
    };
    const applySize = (): void => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false); // 画布 CSS 尺寸由 .pp-viewer-3d-canvas 定
    };
    if (typeof window !== 'undefined' && window.devicePixelRatio > 0) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }
    applySize();

    let raf: number | null = null;
    if (controls) {
      const tick = (): void => {
        controls.update();
        draw();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick); // 浮层才挂循环（阻尼需要连续帧）
    } else {
      draw(); // 流内静态首帧：一帧即停，不挂 rAF
    }

    // 版心 / 窗口尺寸变化：静态态补渲一帧，交互态由循环自续
    const resize = (): void => {
      applySize();
      if (!controls) draw();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(host);
    if (!observer && typeof window !== 'undefined') window.addEventListener('resize', resize);

    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      observer?.disconnect();
      if (!observer && typeof window !== 'undefined') window.removeEventListener('resize', resize);
      controls?.dispose();
      scene.remove(model.object); // 对象树本体由 ④ 的清理释放（disposeObject）
      scene.environment = null;
      env.dispose();
      renderer.dispose();
      try {
        renderer.forceContextLoss(); // WebView 里及时还回 GL 上下文
      } catch (e) {
        void e; // 无 WEBGL_lose_context 的宿主：忽略（上下文随 canvas 回收）
      }
    };
  }, [model, interactive]);

  // ④ 对象树释放（创建在 ①、只在这里成对释放——换文件 / 卸载都不漏）
  useEffect(() => {
    if (!model) return;
    return () => {
      disposeObject(model.object);
    };
  }, [model]);

  const name = label || filePath || '3D 模型';
  const sizeBytes = dataUri === undefined ? null : dataUriByteSize(dataUri);
  // stage 与提示行用 `<span>`（CSS display:block）：流内整块被包在 `<button>` 里（点一下进
  // 浮层），而 button 的内容模型只收 **phrasing content**——div 落在 button 内是非法 HTML。
  const stage =
    model === null ? null : (
      <span className="pp-viewer-3d-stage">
        <canvas ref={canvasRef} className="pp-viewer-3d-canvas" aria-label={`3D 模型：${name}`} />
        {webglError !== null && (
          <span className="pp-viewer-note">当前环境不支持 WebGL，无法预览 3D（{webglError}）</span>
        )}
      </span>
    );

  let body: ReactNode;
  if (state.status === 'empty') {
    body = (
      <div className="pp-viewer-empty">
        未提供模型内容（宿主未给文件字节{filePath ? `：${filePath}` : ''}）——无法预览
      </div>
    );
  } else if (state.status === 'error') {
    body = <div className="pp-viewer-error">3D 模型不可预览：{state.message}</div>;
  } else if (state.status === 'loading') {
    body = <div className="pp-media-loading">正在解析 3D 模型…</div>;
  } else if (mode === 'stream') {
    // 流内：静态首帧在一张图上，点一下进浮层看可交互的那一版
    body = (
      <button
        type="button"
        className="pp-media-open pp-viewer-3d-open"
        aria-label={`放大查看 3D 模型：${name}`}
        onClick={() => onOpenOverlay?.()}
      >
        {stage}
      </button>
    );
  } else {
    // 浮层（可交互）/ 未落地容器（pinned / panel：静态态）
    body = (
      <>
        {stage}
        {interactive && (
          <div className="pp-viewer-3d-tools">
            <button
              type="button"
              className="pp-viewer-3d-tool"
              aria-pressed={wireframe}
              onClick={() => setWireframe((on) => !on)}
            >
              线框
            </button>
            <span className="pp-viewer-3d-hint">拖动旋转 · 滚轮缩放 · 右键平移</span>
          </div>
        )}
      </>
    );
  }

  return (
    <div className={interactive ? 'pp-viewer-3d pp-viewer-3d-overlay' : 'pp-viewer-3d'}>
      <div className="pp-viewer-3d-meta">
        <span className="pp-viewer-3d-meta-name">{name}</span>
        {normalizedExt !== '' && <span className="pp-viewer-3d-meta-ext">{normalizedExt}</span>}
        <span className="pp-viewer-3d-meta-size">{sizeBytes === null ? '字节数未知' : formatBytes(sizeBytes)}</span>
      </div>
      {body}
      {model !== null && (
        <div className="pp-viewer-3d-stats">
          <span className="pp-viewer-3d-stat">三角面 {model.stats.triangles}</span>
          <span className="pp-viewer-3d-stat">顶点 {model.stats.vertices}</span>
          <span className="pp-viewer-3d-stat">包围盒 {model.stats.size}</span>
        </div>
      )}
    </div>
  );
}
