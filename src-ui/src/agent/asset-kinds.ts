// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-kinds — Agent 资产块 kind 注册表（协议 docs/archive/agent-asset-blocks.md §2.10/§2.11）。
//
// 纯数据层（agent 层，零 UI 依赖）：
//   - kind = 语义维度（数据意味着什么，无限）——每种 kind 一行注册：
//     { schema, presentations[], defaultPresentation, streamable }
//   - presentation = 表现维度（怎么画，有限）——组件注册面在 composition/
//     renderer-service.tsx（UI 层）；本文件只声明 kind 允许哪些表现名。
//   - 校验辅助的报错一律「带窗」：未知 kind 报可用清单，presentation 越界
//     报该 kind 白名单（协议 §2.7——关门的每一处都带窗）。

import { validateObjectJsonSchema } from './schema-validate';

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
  /** 跨字段校验（JSON Schema 受限子集表达不了的关系，如「两数组等长」）。
   *  返回错误文案，null/undefined = 通过。D1（2026-09-16）引入。 */
  payloadCheck?: (payload: unknown) => string | null;
  /** 正确形状示例（校验失败时随错误一起回给模型——错误即导航）。 */
  payloadExample?: string;
}

class AssetKindRegistry {
  private kinds = new Map<string, AssetKindDef>();

  /** 注册 kind 并返回所有权清理器（对齐 ContributionChannel 的纪律：重名装载期拒绝；
   *  本注册表是 agent 层纯数据面，**不是** composition 层贡献通道——无 ctx/Service/
   *  fiber 生命周期，见 composition/contribution-channel.ts 的边界注记）。 */
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

/** payload 契约校验（D1，2026-09-16）——show_asset / update_asset 共用的单一真源。
 *
 *  分两层：① schema 层走受限子集校验（形状/类型/必需字段）；② kind 自带的
 *  payloadCheck 补跨字段关系（如两数组等长）。
 *
 *  返回错误文案（带窗：kind + 期望 + 正确示例），null = 通过。
 *  注意：**不**用 assertSupportedSchema 预检 schema 本身——kind schema 的字段
 *  普遍带 description，而该函数的关键字白名单不含 description（会误拒）；
 *  validateObjectJsonSchema 对未知关键字宽容，直接用它即可。 */
export function validatePayload(def: AssetKindDef, payload: unknown): string | null {
  // chart 的 data 是 payload 内的字段，其余 kind 的 schema 描述整个 payload —— 统一按
  // 「payload 本身即 def.schema 描述的对象」处理：schema 校验整块 payload。
  const schemaErr = validateObjectJsonSchema(payload, def.schema);
  if (schemaErr) {
    return (
      `payload 不符合 '${def.id}' 的契约：${schemaErr}。` +
      (def.payloadExample ? `正确形状示例：${def.payloadExample}` : '') +
      `（完整 schema 用 list_block_kinds 查 '${def.id}'）`
    );
  }
  const crossErr = def.payloadCheck?.(payload) ?? null;
  if (crossErr) {
    return (
      `payload 不符合 '${def.id}' 的契约：${crossErr}。` +
      (def.payloadExample ? `正确形状示例：${def.payloadExample}` : '')
    );
  }
  return null;
}

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
        columns: { type: 'array', items: { type: 'string' }, description: '列名（可空——缺省按列位生成 #1/#2…）' },
        rows: {
          type: 'array',
          items: { type: 'array' },
          description: '行数据——每行是一个单元格数组（按 columns 顺序），如 [["feat",251],["docs",218]]',
        },
        caption: { type: 'string', description: '表题（可空）' },
        // 信息面（2026-09-17「让卡片说人话」批第三刀）：「几百行就是一面墙」——模型
        // 知道哪几行是重点，读者不知道。emphasis.rows = 0-based 行下标（对应 rows 数组），
        // 渲染为石青左条 + 洗底；纯样式，不改行高、不动测高，旧 payload 逐字有效。
        emphasis: {
          type: 'object',
          description: '重点行（0-based 行下标，对应 rows 数组第几行）——让读者一眼看到结论所在的行',
          properties: {
            rows: { type: 'array', items: { type: 'number' }, description: '重点行下标，如 [0,3]' },
          },
        },
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
        data: {
          description:
            '数据序列——两种形状二选一（机器校验，不符会被拒绝并提示正确形状）：' +
            '① 推荐：{labels: string[], values: number[]}（labels 与 values 必须等长）；' +
            '② 或：[{label, value}] 数组，纯数值数组 [1,2,3] 也可（此时无标签）。' +
            '注意：不是 ECharts 的 {datasets:[{data}]} 形状，也不是 {categories, series} —— 这些形状会被拒绝',
          // D2（2026-09-16）：显式联合，取代此前的纯 description「纸条提示」。
          // 两个分支互斥（object vs array）；array 分支的 items 用 oneOf 收窄，
          // 使空数组 [] 恰好命中一个分支（若把纯数值并列成第三个顶层分支，空数组会同时命中两个 → 被误拒）。
          oneOf: [
            {
              type: 'object',
              properties: {
                labels: { type: 'array', items: { type: 'string' } },
                values: { type: 'array', items: { type: 'number' } },
              },
              required: ['labels', 'values'],
            },
            {
              type: 'array',
              items: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      value: { type: 'number' },
                    },
                    required: ['label', 'value'],
                  },
                  { type: 'number' },
                ],
              },
            },
          ],
        },
        config: {
          type: 'object',
          description: '可选配置：title（字符串，不是 {text} 对象）、xName、yName、palette（颜色数组）',
        },
        // ── 信息面（2026-09-17「让卡片说人话」批，全部可选 ⇒ 旧 payload 逐字有效）──
        // 读者判断一张图能不能信，靠的不是柱子多高，而是「这些数字是什么口径」。
        // 此前 schema 只有 type/data/config ⇒ 图上只有一个裸数字（251 是次数还是毫秒？）。
        unit: {
          type: 'string',
          description: '数值单位（如「次」「毫秒」「%」）——渲染在类型行里，读者不用猜 251 是什么',
        },
        source: {
          type: 'string',
          description: '数据来源/口径（如「git log 近 30 天」「本会话统计」）——渲染在类型行末尾',
        },
      },
      ['type', 'data'],
    ),
    presentations: ['chart', 'interactive'],
    defaultPresentation: 'chart',
    streamable: 'atomic',
    payloadExample:
      '{type:"bar", data:{labels:["feat","fix","docs"], values:[251,88,36]}, unit:"次", source:"git log 近 30 天", config:{title:"提交类型分布", yName:"次数"}}',
    // labels/values 必须等长（受限子集无「两数组等长」关键字——运行时补）。
    // 注意取 payload.data（data 是 payload 的嵌套字段，不是 payload 本身）。
    payloadCheck: (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      const data = (payload as { data?: unknown }).data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null; // 形状交给 schema 拒
      const { labels, values } = data as { labels?: unknown; values?: unknown };
      if (!Array.isArray(labels) || !Array.isArray(values)) return null;
      if (labels.length !== values.length) {
        return `data.labels 与 data.values 必须等长（现在 ${labels.length} 个标签 vs ${values.length} 个数值）`;
      }
      return null;
    },
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
            // 信息面（2026-09-17「让卡片说人话」批第二刀）：单值没有比较对象就只能当
            // 装饰。一个字符串承载「与谁比、目标多少」（如「上期 88，+12%」「目标 100」），
            // 渲染在数值同行右侧（石青小字）⇒ 零测高改动、旧 payload 逐字有效。
            compare: {
              type: 'string',
              description: '比较对象/口径（如「上期 88」「目标 100」「阈值 5」）——读者据此判断这个数是好是坏',
            },
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
      fileId: { type: 'string', description: '会话文件 id（可空）' },
      filePath: { type: 'string', description: '绝对路径——图片/视频预览需给此项（读文件内容渲染）' },
      label: { type: 'string', description: '显示名（可空——缺省回落到 fileId/filePath）' },
      ext: { type: 'string', description: '扩展名（如 png/mp4/pdf，小写无点——决定渲染形态；可空）' },
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
        nodeId: {
          type: 'string',
          description:
            '根节点 id（仅作标注）——渲染不认查询式：必须同时给 nodes/edges 直通数据，' +
            '否则渲染「数据不可用」占位（要查影响面用 trace_impact 的输出直接透传）',
        },
        depth: { type: 'number', description: '波及深度（仅作标注，可空）' },
        nodes: {
          type: 'array',
          items: objectSchema({
            id: { type: 'string' },
            label: { type: 'string' },
            depth: { type: 'number' },
            kind: { type: 'string' },
          }),
          description: '节点表（渲染必需——与 edges 成对；边引用的 id 必须在本表出现）',
        },
        edges: {
          type: 'array',
          items: objectSchema({ from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string' } }),
          description: '边表（渲染必需——与 nodes 成对，from/to 取 nodes 里的 id）',
        },
      },
      [],
    ),
    // 2026-09-18 真机取证：'table' 曾被列进白名单但**没有任何渲染器注册该原语** ⇒
    // 模型按白名单选它是「合法」的，渲染侧却静默落 '*' JSON 兜底（用户看到一张 JSON 卡）。
    // 白名单只能声明注册面真实存在的原语；要有依赖表形态就单独实现渲染器再加回来。
    presentations: ['graph', 'tree'],
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
        // 题签行（B 图版签，2026-09-17）：看板也有题名，签为「板」（题签恒在，题名可空）
        caption: { type: 'string', description: '看板题名（可空）' },
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
        // 题签行同上：时间轴题名，签为「序」
        caption: { type: 'string', description: '时间轴题名（可空）' },
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 资产内容摘要（模型可见的「派生读数」——§2.7 报错带窗的成功面对偶）。
 *
 *  Why（2026-09-16 真机事故）：show_asset 的成功回执此前是**入参的原样回放**，
 *  零新增信息——模型据此无法核对「我发的东西存成了什么」，于是把「怀疑 → 重发」
 *  当验证手段（同一张表连发 4 次，4 次全成功、聊天里 4 张重复卡，最后弃用该 kind）。
 *  摘要给的是**模型没说过的数字**（列数/行数/行宽是否一致/顶层键/字符数）——
 *  这才是能反驳「payload 没送全 / 被弄脏」的证据。
 *
 *  单一权威源：全部由 payload 派生，不存第二份真相（只读、无状态）。 */
export function assetDigest(kind: string, payload: unknown): string {
  const bits: string[] = [];
  if (kind === 'table' && isPlainObject(payload)) {
    const rows = Array.isArray(payload.rows) ? payload.rows : null;
    const cols = Array.isArray(payload.columns) ? payload.columns.length : null;
    if (rows) {
      const widths = [...new Set(rows.map((r) => (Array.isArray(r) ? r.length : 0)))];
      const ragged = widths.length > 1 ? `（行宽不一：${widths.join('/')}）` : '';
      bits.push(cols !== null ? `${cols} 列 × ${rows.length} 行${ragged}` : `未给 columns；${rows.length} 行${ragged}`);
    }
  }
  if (isPlainObject(payload)) {
    const keys = Object.keys(payload);
    if (keys.length > 0) bits.push(`顶层键 ${keys.slice(0, 8).join('/')}${keys.length > 8 ? '/…' : ''}`);
  } else if (Array.isArray(payload)) {
    bits.push(`数组 ${payload.length} 项`);
  }
  bits.push(`${JSON.stringify(payload ?? null).length} 字符`);
  return bits.join('；');
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
