// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-kinds — Agent 资产块 kind 注册表（协议 docs/plans/agent-asset-blocks.md §2.10/§2.11）。
//
// 纯数据层（agent 层，零 UI 依赖）：
//   - kind = 语义维度（数据意味着什么，无限）——每种 kind 一行注册：
//     { schema, presentations[], defaultPresentation, streamable }
//   - presentation = 表现维度（怎么画，有限）——组件注册面在 composition/
//     renderer-service.tsx（UI 层）；本文件只声明 kind 允许哪些表现名。
//   - 校验辅助的报错一律「带窗」：未知 kind 报可用清单，presentation 越界
//     报该 kind 白名单（协议 §2.7——关门的每一处都带窗）。

export interface AssetKindDef {
  /** 机器名——show_asset 的 kind 参数值（update 不可变更） */
  id: string;
  /** 一行话描述——list_block_kinds 展示 + prompt 引导 */
  description: string;
  /** payload 契约（JSON Schema draft-7）——show_asset 校验 + list_block_kinds 输出 */
  schema: Record<string, unknown>;
  /** 可用表现白名单（presentation 原语名）——Agent 只能在这里面选 */
  presentations: readonly string[];
  /** 缺省表现——show_asset 不带 presentation 时的回落 */
  defaultPresentation: string;
  /** 流式契约：append = 可 AssetDelta 增量（finalised 前字符串累加）；atomic = 一次性终值 */
  streamable: 'append' | 'atomic';
}

class AssetKindRegistry {
  private kinds = new Map<string, AssetKindDef>();

  /** 注册 kind 并返回所有权清理器（对齐 ContributionRegistry 纪律；重名装载期拒绝） */
  register(def: AssetKindDef): () => void {
    if (this.kinds.has(def.id)) {
      throw new Error(`[asset-kinds] 重复注册 kind "${def.id}" —— 装载期拒绝，不静默覆盖`);
    }
    this.kinds.set(def.id, def);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.kinds.get(def.id) === def) this.kinds.delete(def.id);
    };
  }

  list(): AssetKindDef[] {
    return [...this.kinds.values()];
  }

  get(id: string): AssetKindDef | undefined {
    return this.kinds.get(id);
  }

  has(id: string): boolean {
    return this.kinds.has(id);
  }
}

/** 全局 kind 注册表（单例；动态贡献面留给插件通道，v1 内置表注册于模块装载） */
export const assetKinds = new AssetKindRegistry();

// ═══════════════════════════════════════════════════════
// 内置 kind（首发清单，协议 §2.10）
// ═══════════════════════════════════════════════════════

/** draft-7 object schema 助手 */
function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

/** 首发内置 kind 表（模块装载期调用一次；重名注册会 throw——防御重复调用） */
export function registerBuiltinAssetKinds(): void {
  assetKinds.register({
    id: 'table',
    description: '二维表格数据（CSV 风格行集）；支持 append 流式行累积',
    schema: objectSchema(
      {
        columns: { type: 'array', items: { type: 'string' }, description: '列名（可空）' },
        rows: { type: 'array', items: { type: 'array' }, description: '行数据' },
        caption: { type: 'string', description: '表题（可空）' },
      },
      ['rows'],
    ),
    presentations: ['grid'],
    defaultPresentation: 'grid',
    streamable: 'append',
  });

  assetKinds.register({
    id: 'chart',
    description:
      '图表（柱/线/饼/散点四件套）——数据+配置，不是图片；presentation interactive 走 ECharts 交互版（科研渲染 #16）',
    schema: objectSchema(
      {
        type: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter'], description: '图表类型' },
        data: { description: '数据序列（按图表类型组织）' },
        config: { type: 'object', description: '可选配置（标题/轴/图例等）' },
      },
      ['type', 'data'],
    ),
    presentations: ['chart', 'interactive'],
    defaultPresentation: 'chart',
    streamable: 'atomic',
  });

  assetKinds.register({
    id: 'metric',
    description: '指标卡组（dashboard 最小单元）——若干 {label, value} 对',
    schema: objectSchema(
      {
        items: {
          type: 'array',
          items: objectSchema({
            label: { type: 'string' },
            value: { type: ['string', 'number'] },
            unit: { type: 'string' },
            tone: { type: 'string', enum: ['accent', 'green', 'danger', 'muted'] },
          }),
        },
        caption: { type: 'string' },
      },
      ['items'],
    ),
    presentations: ['metric', 'grid'],
    defaultPresentation: 'metric',
    streamable: 'atomic',
  });

  assetKinds.register({
    id: 'file',
    description: '会话文件/媒体引用（图片/视频/文档——点击打开预览）',
    schema: objectSchema({
      fileId: { type: 'string' },
      filePath: { type: 'string' },
      label: { type: 'string' },
      ext: { type: 'string' },
    }),
    presentations: ['media'],
    defaultPresentation: 'media',
    streamable: 'atomic',
  });

  assetKinds.register({
    id: 'deps_impact',
    description: '依赖影响面/依赖链（图谱内化：影响面树直通 trace_impact 输出）',
    schema: objectSchema(
      {
        nodeId: { type: 'string', description: '根节点 id（查询式）' },
        depth: { type: 'number', description: '波及深度（可空）' },
        nodes: {
          type: 'array',
          items: objectSchema({
            id: { type: 'string' },
            label: { type: 'string' },
            depth: { type: 'number' },
            kind: { type: 'string' },
          }),
          description: '节点表（直通式，与 edges 成对）',
        },
        edges: {
          type: 'array',
          items: objectSchema({ from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string' } }),
          description: '边表（直通式，与 nodes 成对）',
        },
      },
      [],
    ),
    presentations: ['graph', 'tree', 'table'],
    defaultPresentation: 'graph',
    streamable: 'atomic',
  });

  assetKinds.register({
    id: 'html',
    description: '任意 HTML/SVG 片段（沙箱 iframe 渲染——逃生舱，Agent 现场发明视觉）',
    schema: objectSchema({ code: { type: 'string', description: '内容片段（禁 DOCTYPE/html/head/body 包裹）' } }, [
      'code',
    ]),
    presentations: ['html'],
    defaultPresentation: 'html',
    streamable: 'atomic',
  });

  assetKinds.register({
    id: 'confirm',
    description:
      '确认卡（plan 审批模式泛化：选项/批准/修改/拒绝）——show_asset 挂起等待用户在卡上表决，' +
      '表决结果作为工具结果返回后继续；5 分钟无响应超时放行（嵌套/无界面环境立即放行）',
    schema: objectSchema(
      {
        title: { type: 'string' },
        body: { type: 'string' },
        options: {
          type: 'array',
          items: objectSchema({ label: { type: 'string' }, description: { type: 'string' } }),
        },
        confirmLabel: { type: 'string' },
      },
      [],
    ),
    presentations: ['form'],
    defaultPresentation: 'form',
    streamable: 'atomic',
  });

  assetKinds.register({
    id: 'board',
    description: '看板（列+卡）——任务状态板/流程阶段/分组清单',
    schema: objectSchema(
      {
        columns: {
          type: 'array',
          items: objectSchema({
            title: { type: 'string', description: '列标题' },
            cards: {
              type: 'array',
              items: objectSchema({
                label: { type: 'string', description: '卡标题' },
                body: { type: 'string', description: '卡内容（可空）' },
                tone: {
                  type: 'string',
                  enum: ['accent', 'green', 'danger', 'muted'],
                  description: '卡色（可空）',
                },
              }),
              description: '列内卡片',
            },
          }),
          description: '看板列',
        },
      },
      ['columns'],
    ),
    presentations: ['board'],
    defaultPresentation: 'board',
    streamable: 'atomic',
  });

  assetKinds.register({
    id: 'timeline',
    description: '时间轴/事件流——里程碑、变更历史、阶段演进',
    schema: objectSchema(
      {
        items: {
          type: 'array',
          items: objectSchema({
            ts: { type: 'string', description: '时间标记（自由文本：日期/版本号/阶段名）' },
            title: { type: 'string', description: '事件标题' },
            body: { type: 'string', description: '事件内容（可空）' },
          }),
          description: '事件序列（按时间序）',
        },
      },
      ['items'],
    ),
    presentations: ['timeline'],
    defaultPresentation: 'timeline',
    streamable: 'atomic',
  });

  // ═══════════════════════════════════════════════════════
  // 科研化学式（scientific-rendering #10，2026-09）
  // ═══════════════════════════════════════════════════════
  // 分子/反应呈现字段集（name/formula/smiles）——name = 展示名（可空），
  // formula = 分子式文本（可空，无 smiles 时兜底展示），smiles = 结构式
  // （SMILES，可含反应 'A>>B'）。整卡 atomic（一次给出）。
  // 表现原语 chem-body 在 plugins/builtin/renderers/components.tsx。
  assetKinds.register({
    id: 'chem',
    description:
      '化学物质/反应卡（分子式 + SMILES 结构式）——化学式与结构的结构化呈现：' +
      '名称/分子式/结构式。模型给出 SMILES（含反应式 A>>B）即渲染 2D 结构',
    schema: objectSchema(
      {
        name: { type: 'string', description: '物质展示名（如 阿司匹林，可空）' },
        formula: { type: 'string', description: '分子式文本（如 C9H8O4，可空）' },
        smiles: { type: 'string', description: 'SMILES 结构式（如 CC(=O)Oc1ccccc1C(=O)O；可含反应 A>>B）' },
      },
      [],
    ),
    presentations: ['chem'],
    defaultPresentation: 'chem',
    streamable: 'atomic',
  });

  // ═══════════════════════════════════════════════════════
  // 科研引用卡（scientific-rendering 4B，2026-09）
  // ═══════════════════════════════════════════════════════
  // BibTeX 字段集（title/authors/year/venue/doi/pmid/arxiv/url/bibtex）——
  // 字段均为字符串、整卡 atomic（模型一次给出完整元数据，无流式行累积语义）。
  // 表现原语 citation-card 在 plugins/builtin/renderers/components.tsx。
  assetKinds.register({
    id: 'citation',
    description:
      '学术引用卡（BibTeX/DOI/PMID/arXiv 等元数据）——参考文献条目的结构化呈现：' +
      '标题/作者/年份/venue/标识号，可展开 BibTeX 原文。模型从检索/知识中整理出条目即可交付',
    schema: objectSchema(
      {
        title: { type: 'string', description: '文献标题' },
        authors: {
          oneOf: [
            { type: 'string', description: '作者串（自由文本：A, B and C / 甲、乙、丙）' },
            { type: 'array', items: { type: 'string' }, description: '作者表（每作者一个条目）' },
          ],
          description: '作者（字符串或数组）',
        },
        year: { type: ['string', 'number'], description: '发表年份' },
        venue: { type: 'string', description: '发表载体（期刊/会议名，可空）' },
        doi: { type: 'string', description: 'DOI 标识（可空）' },
        pmid: { type: 'string', description: 'PubMed ID（可空）' },
        arxiv: { type: 'string', description: 'arXiv 编号（如 2401.00001，可空）' },
        url: { type: 'string', description: '其它来源 URL（可空）' },
        bibtex: { type: 'string', description: '完整 BibTeX 原文（可空；折叠展示）' },
      },
      [],
    ),
    presentations: ['citation'],
    defaultPresentation: 'citation',
    streamable: 'atomic',
  });
}

// ═══════════════════════════════════════════════════════
// 资产通道终值解析（协议 §2.3——assetChannel 工具返回 JSON 的 AssetEventData 形状）
// ═══════════════════════════════════════════════════════

/** 解析工具输出的资产终值 JSON（AssetToolOutput 形状）。单一解析真源：
 *  executor 终值事件、dispatchNestedTool 嵌套通道、asset-store 会话重建
 *  共用（schema 键/事件键/重建键三处一源——再漂移类事故的预防）。
 *  非资产 JSON / 截断文本 / 畸形 → null（调用方各按其语义处理）。 */
export function parseAssetEventOutput(output: string): import('./agent-types').AssetEventData | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.assetId !== 'string' || typeof o.kind !== 'string' || !('payload' in o)) return null;
    return {
      assetId: o.assetId,
      kind: o.kind,
      ...(typeof o.presentation === 'string' ? { presentation: o.presentation } : {}),
      ...(typeof o.title === 'string' && o.title.length > 0 ? { title: o.title } : {}),
      payload: o.payload,
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// 校验辅助（报错即导航——协议 §2.7）
// ═══════════════════════════════════════════════════════

/** 未知 kind 的带窗错误文本（含可用清单摘要） */
export function unknownKindErrorText(kind: string): string {
  return (
    `kind '${kind}' 未注册，无法生成资产块。当前可用 kind：${kindListSummary()}。` +
    '每种 kind 的 payload schema 与可用表现用 list_block_kinds 查询。'
  );
}

/** presentation 越界的带窗错误文本（含该 kind 白名单） */
export function presentationErrorText(kind: string, presentation: string, def: AssetKindDef): string {
  return (
    `kind '${kind}' 不支持表现 '${presentation}'。` +
    `可用表现：${def.presentations.join(' / ')}（默认 ${def.defaultPresentation}）。` +
    '不带 presentation 则自动用默认表现。'
  );
}

/** 一行话 kind 清单（错误信息与 prompt 引导共用） */
export function kindListSummary(): string {
  return assetKinds
    .list()
    .map((k) => `${k.id}[${k.streamable}]`)
    .join('、');
}

/** 取 kind 并带窗校验（未知 → throw） */
export function requireKind(kind: string): AssetKindDef {
  const def = assetKinds.get(kind);
  if (!def) throw new Error(unknownKindErrorText(kind));
  return def;
}

/** 校验 presentation ∈ 白名单（可空 → 回落 default） */
export function requirePresentation(def: AssetKindDef, presentation: string | undefined): string {
  const resolved = presentation ?? def.defaultPresentation;
  if (!def.presentations.includes(resolved)) {
    throw new Error(presentationErrorText(def.id, resolved, def));
  }
  return resolved;
}

// ═══════════════════════════════════════════════════════
// assetId 生成（对齐协议 §2.5：'as_{ts}_{seq}_{rand}'）
// ═══════════════════════════════════════════════════════

let assetIdSeq = 0;

export function generateAssetId(): string {
  assetIdSeq += 1;
  return `as_${Date.now().toString(36)}_${assetIdSeq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// 内置 kind 装载期注册（Node 模块缓存保证幂等——测试与生产同语义）
registerBuiltinAssetKinds();
