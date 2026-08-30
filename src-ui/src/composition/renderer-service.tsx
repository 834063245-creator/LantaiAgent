// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 组合层第五 service —— 块渲染器注册表（paper-shell V3b）。
//
// 缘起：paper-shell 计划 V3b「块渲染器 = ctx service——组合层第五贡献通道」
// （docs/plans/paper-shell/README.md V3b 节；组合层 README D0 收敛注记：
// 块协议的语义声明 + 可插拔渲染器本身就是一个插件面）。
//
// 契约对齐四 service（composition/services.ts，S1-1）：
//   - register(def) → Disposer：调用方挂 ctx.effect（所有权登记是调用方纪律）；
//   - 重名 id 装载期拒绝（throw，不静默覆盖）；
//   - disposer 幂等 + 陈旧性守卫（同 def 重注册后旧 disposer 不误删新行）；
//   - 即时生效语义（渲染期消费——纸壳渲染每帧重取有效清单，与 panels 的
//     bump 信号不同：渲染器没有常驻 React 清单缓存，不需要信号 store）。
//
// 渲染器职责边界（灰框纪律的结构化）：
//   - 渲染器只渲染块**体**（kind 特定内容）；块壳（头部/拖拽手柄/钉住收回/
//     占位符）是纸壳结构件，不进注册表——插件换的是「这个 kind 长什么样」，
//     不是「纸怎么交互」。
//   - 内置灰框渲染器 = 默认行（本文件 registerBuiltinRenderers，装载期注册）；
//     贡献与内置同 id → 内置胜（对齐 panelDefs() 合流纪律）。

import type { ComponentType, ReactNode } from 'react';
import { Fragment, useMemo, useRef, useState } from 'react';
import { assetKinds } from '../agent/asset-kinds';
import type { PlanApprovalResponse, PlanOptionOutcome } from '../agent/plan/plan-tools';
import { type Context, Service } from '../cordis';
import { type BlockKind, parsePlanItems, type SourcedBlock } from '../paper/block-model';
import { foldPreviewLine } from '../paper/fold';
import { type MdBlock, type MdInline, parseMarkdown } from '../paper/markdown';
import { parseCircledSegments } from '../paper/marks';
import { prettyToolArgs } from '../paper/tool-text';
import { assetPresentationDefs } from './asset-renderers';

/** 渲染器组件入参——渲染器拿到块本体 + 纸壳递下的服务性回调。
 *  folded（2026-08-30 折叠机制）：壳层算好的有效折叠态（用户覆盖 ?? 默认规则，
 *  规则在 paper/fold.ts）——渲染器只按态收敛渲染面，不自持折叠状态。 */
export interface BlockRendererProps {
  block: SourcedBlock;
  folded?: boolean;
}

/* ── 流式增量渐显（streaming-fade-render-plan 2026-08-30）──
 * 把「新长出来的文本」与「旧文本」分开：旧文本零动画（流式重渲染不闪），
 * 增量段做一次极轻淡入（0.2s，Claude Code 桌面端同款观感）。
 *
 * 识别原理（零数据层侵入）：流式 = 文本在尾部追加。渲染器用 ref 记上一帧
 * 文本，本帧文本以它为前缀 → 尾部就是增量；非追加（编辑/回填）→ 整块稳定。
 * 分隔点取「旧文本最后一个换行」：旧部分以完整行收尾，增量段从行首开始，
 * markdown 结构在边界两侧都不会被腰斩。
 *
 * 折叠态（reasoning 收折/展开）会整体重渲染：folded 变化时重置 ref，
 * 不把已经展示过的内容误判成增量。 */

interface StreamDelta {
  /** 稳定段文本 = 旧文本全部（已展示内容，零动画、零重复） */
  stable: string;
  /** 增量段文本 = 真正新到达的部分（只有它淡入） */
  delta: string;
}

/**
 * 流式增量识别：文本尾部追加 → 增量；否则整块稳定。
 * 稳定段永远 = 旧文本全部（渲染层镜像：markdown 走 parseMarkdown、纯文本原样）——
 * 已展示内容不重复、不重淡。增量段 = 新字符（markdown 里作为独立块从行边界开始，
 * 流式半成型可接受；纯文本里行内接续）。
 */
function useStreamDelta(text: string, resetKey: unknown): StreamDelta {
  const prevRef = useRef<string | null>(null);
  const lastKeyRef = useRef<unknown>(undefined);

  // resetKey（folded 等）变化 → 重置：整块稳定，不留增量尾巴
  if (lastKeyRef.current !== resetKey) {
    lastKeyRef.current = resetKey;
    prevRef.current = text;
    return { stable: text, delta: '' };
  }

  const prev = prevRef.current;
  if (prev === null || text === prev) {
    prevRef.current = text;
    return { stable: text, delta: '' };
  }
  if (text.startsWith(prev)) {
    prevRef.current = text;
    return { stable: prev, delta: text.slice(prev.length) };
  }
  // 非追加（编辑/重置）：整块稳定
  prevRef.current = text;
  return { stable: text, delta: '' };
}

/** 增量段：持久容器不重建（旧文本在 stable，永不重淡），只让 fresh（新到达）淡入。
 *  block=true：块级 div（markdown——新内容从行边界开始，保结构）；
 *  block=false：行内 span（纯文本接续——不换行不跳）。
 *  delta 为空时不渲染（稳定段独占）。 */
function DeltaZone({ delta, className, block }: { delta: string; className?: string; block?: boolean }) {
  if (!delta) return null;
  const inner = (
    // key 驱动：每次新内容重挂载 → 动画重新触发（旧内容在 stable 不受影响）
    <span className="pp-ink-delta" key={delta}>
      {delta}
    </span>
  );
  // 容器只带布局 class（无动画——不重淡）；动画只挂在 fresh span 上
  if (block) return <div className={className}>{inner}</div>;
  return <span className={className}>{inner}</span>;
}

/** 渲染器贡献：一个 kind 一个渲染器（body 渲染组件）。 */
export interface BlockRendererContribution {
  /** 贡献 id——惯例 '<源>/<kind>'（如 'builtin/markdown'）；与内置同 id 内置胜。 */
  id: string;
  /** 渲染目标块类型（'*' = 兜底渲染器：无专渲染器的 kind 落这里）。 */
  kind: BlockKind | '*';
  component: ComponentType<BlockRendererProps>;
}

// ── 注册表内核（services.ts ContributionRegistry 同构；不导出公共类，
//    第五 service 单文件自持——四 service 的通用内核是内核线内部复用，
//    再抽公共会跨文件耦合两处内核，简单复制 40 行更诚实）──

class RendererRegistry {
  private entries = new Map<string, { def: BlockRendererContribution; dispose: () => void }>();

  register(def: BlockRendererContribution): () => void {
    if (this.entries.has(def.id)) {
      throw new Error('[renderers] duplicate contribution id "' + def.id + '" —— 装载期拒绝，不静默覆盖');
    }
    let done = false;
    const entry = {
      def,
      dispose: () => {
        if (done) return;
        done = true;
        if (this.entries.get(def.id)?.def === def) {
          this.entries.delete(def.id);
        }
      },
    };
    this.entries.set(def.id, entry);
    return entry.dispose;
  }

  list(): BlockRendererContribution[] {
    return [...this.entries.values()].map((e) => e.def);
  }
}

// ── service 本体 ──

export class RenderersService extends Service {
  private registry = new RendererRegistry();

  constructor(ctx: Context) {
    super(ctx, 'renderers');
    _activeRenderers = this; // 消费闭环读取面（纸壳渲染每帧重取）
    // 内置灰框渲染器装载期注册（默认行——插件可贡献新 kind 渲染器或
    // 经不同 id 提供替代渲染器；同 id 内置胜由 resolveRenderer 仲裁）。
    for (const def of builtinRendererDefs()) {
      this.registry.register(def);
    }
    // '*' 兜底行：未知/资产 kind 未接表现原语时显示漂亮 JSON（WO-4）。
    // 不并入 builtinRendererDefs()，保持「八 kind 全谱」的既有契约面。
    this.registry.register({ id: 'builtin/*', kind: '*', component: JsonBody });
    // 资产表现原语（WO-6）：grid/chart/metric/media/graph/tree/html/form。
    for (const def of assetPresentationDefs()) {
      this.registry.register(def);
    }
  }

  register(def: BlockRendererContribution): () => void {
    return this.registry.register(def);
  }

  list(): BlockRendererContribution[] {
    return this.registry.list();
  }
}

// ── 消费闭环读取面（模块级活动服务——services.ts 同款第 3 类可变态）──

let _activeRenderers: RenderersService | null = null;

/** 有效渲染器清单（无服务 = 空集 + 内置兜底——纸壳灰框永不裸奔）。 */
export function activeRendererContributions(): BlockRendererContribution[] {
  return _activeRenderers?.list() ?? [];
}

/**
 * 按 kind 解析渲染器：贡献清单里找该 kind 的行；同 kind 多行时
 * 后注册胜（显式覆盖语义：插件晚于内置装载，覆盖即生效）；
 * 无专渲染器 → '*' 兜底行；全无 → undefined（纸壳用内置灰框直渲）。
 */
export function resolveRenderer(kind: BlockKind): BlockRendererContribution | undefined {
  let fallback: BlockRendererContribution | undefined;
  let found: BlockRendererContribution | undefined;
  for (const r of activeRendererContributions()) {
    if (r.kind === '*') fallback = r;
    else if (r.kind === kind) found = r; // 后写胜（list 保注册序）
  }
  return found ?? fallback;
}

/**
 * 资产块解析（协议 §2.11）：kind → 白名单回落 → presentation → 表现原语组件。
 * kind 未注册 / presentation 脏数据（不在白名单）→ 回落 kind 的 defaultPresentation；
 * 仍无表现组件 → undefined（纸壳走 '*' 兜底 JSON 视图，WO-4）。
 */
export function resolveAssetBlock(
  kind: string,
  presentation: string | undefined,
): ComponentType<BlockRendererProps> | undefined {
  const def = assetKinds.get(kind);
  if (!def) return resolveRenderer('*')?.component;
  const resolved = presentation && def.presentations.includes(presentation) ? presentation : def.defaultPresentation;
  return resolveRenderer(resolved as BlockKind)?.component;
}

// ── 内置注疏渲染器（默认行）──
// 体渲染从 PaperPanel BlockView 的 kind 分支迁出（V3b）；兰台换装（2026-08-22）：
// 视觉由 PaperPanel.css 的分体字体/墨色承载（.pp-body 钩子 + kind 作用域选择器），
// 渲染器只补结构语义（diff 行着色 / 拟策条目化）。壳件（文类签/手柄/收回）留在
// PaperPanel（结构件不进注册表）。

/* ── 正文 markdown 渲染（2026-08-30 会话流渲染专项）──
 * 消费 paper/markdown.ts 的结构模型（与 measure.ts 测高同一解析——镜像纪律：
 * 两边结构必须同源）。视觉版式常量在 PaperPanel.css .pp-md-*，测量镜像在
 * measure.ts MD_* 常量——改版式三处同步（CSS/measure/此处类名契约）。 */

/** 行内片段 → 节点（标志位解析期已打平，无嵌套结构）。 */
function InlineRuns({ inl }: { inl: MdInline[] }) {
  return (
    <>
      {inl.map((seg, i) => {
        let node: ReactNode = seg.text;
        if (seg.c) node = <code className="pp-md-ci">{seg.text}</code>;
        else if (seg.href) {
          node = (
            <a className="pp-md-a" href={seg.href} target="_blank" rel="noreferrer">
              {seg.text}
            </a>
          );
        }
        if (seg.s) node = <del>{node}</del>;
        if (seg.i) node = <em>{node}</em>;
        if (seg.b) node = <strong>{node}</strong>;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 解析段按位置渲染，静态内容无重排身份
          <Fragment key={i}>{node}</Fragment>
        );
      })}
    </>
  );
}

/** 块序列渲染（quote 内层 / 列表项嵌套递归复用；top = .pp-body 直排面）。
 *  tail：流式行内增量（无换行部分）——只落在最后一个块上（字符级接续）。 */
function MdBlocksView({ blocks, tail }: { blocks: MdBlock[]; tail?: ReactNode }) {
  return (
    <>
      {blocks.map((el, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态解析结果按位渲染
        <Fragment key={i}>{renderMdBlock(el, i === blocks.length - 1 ? tail : undefined)}</Fragment>
      ))}
    </>
  );
}

function renderMdBlock(el: MdBlock, tail?: ReactNode): ReactNode {
  switch (el.t) {
    case 'p':
      return (
        <p className="pp-md-p">
          <InlineRuns inl={el.inl} />
          {tail}
        </p>
      );
    case 'h': {
      const Tag = `h${el.lv}` as 'h1' | 'h2' | 'h3' | 'h4';
      return (
        <Tag className={`pp-md-h pp-md-h${el.lv}`}>
          <InlineRuns inl={el.inl} />
          {tail}
        </Tag>
      );
    }
    case 'list': {
      const Tag = el.ord ? 'ol' : 'ul';
      return (
        <Tag className="pp-md-list">
          {el.items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表项按位渲染，序号即身份
            <li key={i} className="pp-md-li">
              <span className="pp-md-mark" aria-hidden="true">
                {el.ord ? `${el.start + i}.` : '·'}
              </span>
              <InlineRuns inl={it.inl} />
              {it.sub && (
                <div className="pp-md-sub">
                  <MdBlocksView blocks={it.sub} />
                </div>
              )}
            </li>
          ))}
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote className="pp-md-quote">
          <MdBlocksView blocks={el.blocks} tail={tail} />
        </blockquote>
      );
    case 'code':
      return (
        <pre className="pp-md-code">
          {el.text}
          {tail}
        </pre>
      );
    case 'hr':
      return <hr className="pp-md-hr" />;
    case 'table':
      return (
        <table className="pp-md-table">
          <thead>
            <tr>
              {el.head.map((cell, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 表头按位渲染
                <th key={i}>
                  <InlineRuns inl={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {el.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 表行按位渲染
              <tr key={r}>
                {row.map((cell, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 表格按位渲染
                  <td key={c}>
                    <InlineRuns inl={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

/** 正文（markdown）：结构化渲染——标题/段落/列表/引用/图码/表格 + 行内强调。
 *  流式友好：parseMarkdown 对未闭合围栏/未配对标记按已闭合/字面量处理。
 *  增量渐显（streaming-fade，方案 B 三级切分）：
 *    - 旧文本（stable）零动画，走完整 parseMarkdown；
 *    - 增量按首个换行切：换行前 = 行内续写（tail 接进最后一个块，字符级淡入）；
 *    - 换行后 = 新块（块级 DeltaZone，从行首开始不腰斩 markdown 结构）。
 *    - stable 为空（首 token）时行内尾也兜底渲染，不丢字。 */
function MarkdownBody({ block }: BlockRendererProps) {
  const text = (block.payload as { text?: string }).text ?? '';
  // P5 眉批化：配对吸附的夹注全文 → 右侧眉批栏（.pp-marginalia，绝对定位
  // 锚 .pp-block——世界层块是唯一定位祖先，侧栏在块宽之外不挤正文列）
  const sidecar = (block.payload as { sidecar?: { text: string } }).sidecar;
  const { stable, delta } = useStreamDelta(text, null);
  const blocks = useMemo(() => parseMarkdown(stable), [stable]);
  // 三级切分：换行前行内尾 / 换行后新块（剥掉分块换行——它属于块边界非内容）
  const nl = delta.indexOf('\n');
  const inlineTail = nl < 0 ? delta : delta.slice(0, nl);
  const blockDelta = nl < 0 ? '' : delta.slice(nl + 1);
  const tailNode = inlineTail && <span className="pp-ink-delta">{inlineTail}</span>;
  return (
    <div className="pp-body pp-md">
      {sidecar?.text ? <aside className="pp-marginalia">{sidecar.text}</aside> : null}
      {blocks.map((el, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同上
        <Fragment key={i}>{renderMdBlock(el, i === blocks.length - 1 ? tailNode : undefined)}</Fragment>
      ))}
      {/* stable 为空（首 token / 全空追加）：行内尾直接落体（不丢字） */}
      {blocks.length === 0 && inlineTail && (
        <span className="pp-ink-delta" key={inlineTail}>
          {inlineTail}
        </span>
      )}
      <DeltaZone delta={blockDelta} block />
    </div>
  );
}

/** 夹注/贴黄体：纯文本单段流（夹注折叠态 = 一行预览，folded 由壳层递下）。 */
function TextBody({ block, folded }: BlockRendererProps) {
  const text = (block.payload as { text: string }).text ?? '';
  const { stable, delta } = useStreamDelta(text, folded ?? null);
  if (block.kind === 'reasoning') {
    if (folded) {
      const preview = foldPreviewLine(text);
      return <div className="pp-body">{preview ? <div className="pp-fold-preview">{preview}</div> : null}</div>;
    }
  }
  return (
    <div className="pp-body">
      {stable}
      <DeltaZone delta={delta} />
    </div>
  );
}

/** 来文体：圈点解析（C7）——【词】→ 朱砂圈，其余字面。
 *  圈永不拆行由 .pp-circled 的 inline-block 保证（CSS 侧纪律）。
 *  增量渐显：稳定段走圈点，增量段纯文本淡入（稳定化后并入圈点）。
 *  附件行（C10）：payload.files 独立渲染——石青 mono 小行，不混楷书正文。 */
function UserBody({ block }: BlockRendererProps) {
  const text = (block.payload as { text: string }).text;
  const files = (block.payload as { files?: Array<{ path: string; name: string }> }).files;
  const { stable, delta } = useStreamDelta(text ?? '', null);
  const segs = parseCircledSegments(stable);
  return (
    <div className="pp-body">
      {segs.map((s, i) =>
        s.circled ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 解析段按位置渲染，静态内容无重排身份
          <span key={i} className="pp-circled">
            {s.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同上
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
      <DeltaZone delta={delta} />
      {files && files.length > 0 && (
        <div className="pp-user-files">
          {files.map((f) => (
            <div key={f.path} className="pp-user-file" title={f.path}>
              附 · {f.name}
            </div>
          ))}
        </div>
      )}
      {/* asterism（B1）：来文收尾三星——古代卷子每卷末的花押句号。
       * 视觉尾距 30px 在 .pp-user-asterism（margin-top），测量镜像 measure.ts。 */}
      <span className="pp-user-asterism" aria-hidden="true">
        ⁂
      </span>
    </div>
  );
}

/** 统一 diff 行分类：+ 新增（松绿 --pass）/ - 删除（朱砂深 --seal-deep 删除线）/ @@ hunk 头（注记）。
 *  B5 环2 红绿墨色化定稿——颜色落点在 PaperPanel.css .pp-add/.pp-del。 */
function diffLineClass(line: string): string | undefined {
  if (line.startsWith('+')) return 'pp-add';
  if (line.startsWith('-')) return 'pp-del';
  if (line.startsWith('@@')) return 'pp-hunk';
  return undefined;
}

function DiffBody({ block }: BlockRendererProps) {
  const p = block.payload as { lang?: string; text: string };
  const lines = p.text.split('\n');
  return (
    <>
      {p.lang && <div className="pp-lang">{p.lang}</div>}
      <pre>
        {lines.map((line, i) => {
          const cls = diffLineClass(line);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff 行按位置渲染，行序即身份
            <Fragment key={i}>
              {i > 0 && '\n'}
              {cls ? <span className={cls}>{line}</span> : line}
            </Fragment>
          );
        })}
      </pre>
    </>
  );
}

function PlanBody({ block }: BlockRendererProps) {
  const p = block.payload as {
    title: string;
    content: string;
    options?: { label: string; description: string; outcome?: PlanOptionOutcome }[];
    _callback?: (response: PlanApprovalResponse) => void;
  };
  const items = parsePlanItems(p.content ?? '');
  const cb = p._callback;
  const [selected, setSelected] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [done, setDone] = useState(false);

  if (!cb) {
    // 只读态（历史块 / 无审批回调）：维持拟策展示
    return (
      <div className="pp-pc">
        <div className="pp-pc-head">
          <span className="pp-pc-t">{p.title || '拟策'}</span>
        </div>
        {items.length > 0 && (
          <ol>
            {items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态列表逐行渲染，序号即身份
              <li key={i}>{item}</li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  const hasOptions = (p.options?.length ?? 0) >= 2;
  const canApprove = !hasOptions || selected !== null;
  const canRevise = feedback.trim().length > 0;
  const settle = (response: PlanApprovalResponse) => {
    cb(response);
    setDone(true);
  };

  return (
    <div className="pp-pc">
      <div className="pp-pc-head">
        <span className="pp-pc-t">{p.title || '拟策'}</span>
      </div>
      {items.length > 0 && (
        <ol>
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态列表逐行渲染，序号即身份
            <li key={i}>{item}</li>
          ))}
        </ol>
      )}
      {hasOptions && (
        <div className="pp-pc-options">
          {(p.options ?? []).map((o) => (
            <button
              key={o.label}
              type="button"
              className={`pp-pc-option${selected === o.label ? ' pp-pc-option--on' : ''}`}
              onClick={() => setSelected(o.label)}
            >
              <span className="pp-pc-option-label">{o.label}</span>
              <span className="pp-pc-option-desc">{o.description}</span>
            </button>
          ))}
        </div>
      )}
      {done ? (
        <div className="pp-pc-done">已处理</div>
      ) : (
        <>
          {feedbackOpen && (
            <div className="pp-pc-feedback">
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="修改意见…" />
            </div>
          )}
          <div className="pp-pc-actions">
            <button
              type="button"
              className="pp-pc-btn pp-pc-btn--primary"
              disabled={!canApprove}
              onClick={() => settle({ decision: 'approved', selectedLabel: selected ?? undefined })}
            >
              批准
            </button>
            <button type="button" className="pp-pc-btn" onClick={() => setFeedbackOpen((v) => !v)}>
              修改
            </button>
            {feedbackOpen && (
              <button
                type="button"
                className="pp-pc-btn pp-pc-btn--primary"
                disabled={!canRevise}
                onClick={() => settle({ decision: 'revise', feedback: feedback.trim() })}
              >
                提交
              </button>
            )}
            <button
              type="button"
              className="pp-pc-btn pp-pc-btn--reject"
              onClick={() => settle({ decision: 'rejected' })}
            >
              拒绝
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ToolBody({ block, folded }: BlockRendererProps) {
  const p = block.payload as { args: string; output?: string; err?: string };
  if (folded) return null; // 折叠态只留壳层折叠行（paper/fold.ts 规则）——参数/输出全收
  return (
    <>
      {p.args ? <pre>{prettyToolArgs(p.args)}</pre> : null}
      {p.output && <div className="pp-out">{p.output}</div>}
      {p.err && (
        <div className="pp-out" style={{ color: 'var(--fail)' }}>
          {p.err}
        </div>
      )}
    </>
  );
}

/** 程序执行卡（P2-A）：三段式——程序体（等宽）→ 日志/完成值（终态写入）。
 *  与 ToolBody 的分离点：code 是程序语义（体/出）而非调用语义（参/果）。
 *  折叠态收程序体、留输出/错误（执行结果一眼可见——测量端同款镜像）。 */
function CodeBody({ block, folded }: BlockRendererProps) {
  const p = block.payload as { code: string; output?: string; err?: string };
  return (
    <>
      {!folded && <pre className="pp-code-src">{p.code}</pre>}
      {p.output && <div className="pp-out">{p.output}</div>}
      {p.err && (
        <div className="pp-out" style={{ color: 'var(--fail)' }}>
          {p.err}
        </div>
      )}
    </>
  );
}

/** 兜底 JSON 视图（WO-4）：未知/资产 kind 未接表现原语时，不崩且保信息保真。
 *  只渲染块体；kind/presentation/title 作为文类签补充，payload 以漂亮 JSON 展示。 */
function JsonBody({ block }: BlockRendererProps) {
  const p = block.payload;
  const pretty = (() => {
    try {
      return JSON.stringify(p, null, 2);
    } catch {
      return String(p);
    }
  })();
  return (
    <div className="pp-json">
      <div className="pp-json-head">
        <span className="pp-json-kind">{block.kind}</span>
        {block.asset?.presentation && <span className="pp-json-pres">{block.asset.presentation}</span>}
        {block.asset?.title && <span className="pp-json-title">{block.asset.title}</span>}
      </div>
      <pre className="pp-json-pre">{pretty}</pre>
    </div>
  );
}

/** 内置渲染器行（默认行——视觉由纸壳 CSS 承载，渲染器只管体结构）。 */
export function builtinRendererDefs(): BlockRendererContribution[] {
  return [
    { id: 'builtin/user', kind: 'user', component: UserBody },
    { id: 'builtin/markdown', kind: 'markdown', component: MarkdownBody },
    { id: 'builtin/reasoning', kind: 'reasoning', component: TextBody },
    { id: 'builtin/notice', kind: 'notice', component: TextBody },
    { id: 'builtin/diff', kind: 'diff', component: DiffBody },
    { id: 'builtin/plan', kind: 'plan', component: PlanBody },
    { id: 'builtin/tool', kind: 'tool', component: ToolBody },
    { id: 'builtin/code', kind: 'code', component: CodeBody },
  ];
}

// ── 挂载插件（对齐 compositionServicesPlugin；装载期在四 service 之后，
//    同批 loadBuiltinPlugins 引导——块渲染器依赖 cordis Context 即可）──

declare module '../cordis/context' {
  interface Context {
    /** 块渲染器注册表（V3b 第五贡献通道）——def 注册 → disposer；即时生效。 */
    renderers: RenderersService;
  }
}

export const rendererServicePlugin = {
  name: 'hologram/renderer-service',
  apply(ctx: Context) {
    new RenderersService(ctx);
  },
};
