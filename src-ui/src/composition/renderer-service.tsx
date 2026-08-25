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

import type { ComponentType } from 'react';
import { Fragment, useState } from 'react';
import type { PlanApprovalResponse, PlanOptionOutcome } from '../agent/plan/plan-tools';
import { type Context, Service } from '../cordis';
import { type BlockKind, parsePlanItems, type SourcedBlock } from '../paper/block-model';
import { parseCircledSegments } from '../paper/marks';

/** 渲染器组件入参——渲染器拿到块本体 + 纸壳递下的服务性回调。 */
export interface BlockRendererProps {
  block: SourcedBlock;
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

// ── 内置注疏渲染器（默认行）──
// 体渲染从 PaperPanel BlockView 的 kind 分支迁出（V3b）；兰台换装（2026-08-22）：
// 视觉由 PaperPanel.css 的分体字体/墨色承载（.pp-body 钩子 + kind 作用域选择器），
// 渲染器只补结构语义（diff 行着色 / 拟策条目化）。壳件（文类签/手柄/收回）留在
// PaperPanel（结构件不进注册表）。

/** 正文段落拆分（B1）：双换行分段，段间 10px（原型 .block.agent .body p 语义）。
 *  只在正文（markdown）用——夹注/贴黄保持单段流。 */
function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).filter((s) => s.trim().length > 0);
}

function TextBody({ block }: BlockRendererProps) {
  const text = (block.payload as { text: string }).text;
  if (block.kind !== 'markdown') return <div className="pp-body">{text}</div>;
  const paras = splitParagraphs(text);
  if (paras.length <= 1) return <div className="pp-body">{text}</div>;
  return (
    <div className="pp-body">
      {paras.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 段落按位置渲染，静态内容无重排身份
        <p key={i} className="pp-para">
          {p}
        </p>
      ))}
    </div>
  );
}

/** 来文体：圈点解析（C7）——【词】→ 朱砂圈，其余字面。
 *  圈永不拆行由 .pp-circled 的 inline-block 保证（CSS 侧纪律）。
 *  附件行（C10）：payload.files 独立渲染——石青 mono 小行，不混楷书正文。 */
function UserBody({ block }: BlockRendererProps) {
  const text = (block.payload as { text: string }).text;
  const files = (block.payload as { files?: Array<{ path: string; name: string }> }).files;
  const segs = parseCircledSegments(text);
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

function ToolBody({ block }: BlockRendererProps) {
  const p = block.payload as { args: string; output?: string; err?: string };
  return (
    <>
      <pre>{p.args}</pre>
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
 *  与 ToolBody 的分离点：code 是程序语义（体/出）而非调用语义（参/果）。 */
function CodeBody({ block }: BlockRendererProps) {
  const p = block.payload as { code: string; output?: string; err?: string };
  return (
    <>
      <pre className="pp-code-src">{p.code}</pre>
      {p.output && <div className="pp-out">{p.output}</div>}
      {p.err && (
        <div className="pp-out" style={{ color: 'var(--fail)' }}>
          {p.err}
        </div>
      )}
    </>
  );
}

/** 内置渲染器行（默认行——视觉由纸壳 CSS 承载，渲染器只管体结构）。 */
export function builtinRendererDefs(): BlockRendererContribution[] {
  return [
    { id: 'builtin/user', kind: 'user', component: UserBody },
    { id: 'builtin/markdown', kind: 'markdown', component: TextBody },
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
