// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-office — Office 查看器（渲染面补全 P3 · B4，2026-09-23）：
//   ① docx：`view <f> annotated` **一次**调用 → 正文块序列（标题按层级、正文按行）+ 读数行；
//   ② xlsx：`view <f> text` **一次**取全多表 → 表体走 `grid` 原语（`.pp-grid-table`）
//      + 多表页签切换（**切换只重渲不重读**：RPC 调用次数不增）；
//   ③ pptx：`view <f> text` → 逐页（页序 + 每页文本块）；
//   ④ 失败面四种各出一行可读错误（带 officecli 原话）：报错 / 没装 binary / 超时 / 没退出码；
//   ⑤ **只读**：每次调用的 argv 首词都在 {view,get,query,validate} 内，targets.write 恒 false；
//   ⑥ 无 filePath ⇒ 文件壳（`.pp-media-file`）。
//
// 注册行（`viewers/index.ts`）在用户缝里：本文件自带**幂等注册守卫**（已注册即跳过），
// 用完 `dispose()`。取 def 走动态 import（静态 import 会把 `viewers/office` 顶到
// `components.tsx` 之前求值，撞上 viewers/index 的注册表单例——动态取件落在渲染面已装载之后）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/** `process_cap{action:'office_exec'}` 的载荷形状（断言与只读纪律共用）。 */
interface OfficeExecParams {
  action?: string;
  office?: { argv?: string[]; targets?: Array<{ path: string; write: boolean }> };
  is_agent?: boolean;
}

/** officecli 读口成功响应（强制层形态：成功前置 `[exit code: 0]`）。 */
function officeOk(text: string): string {
  return `[exit code: 0]\n${text}`;
}

/** officecli 读口失败响应。 */
function officeFail(code: number, text: string): string {
  return `[exit code: ${code}]\n${text}`;
}

const DOCX_ANNOTATED = [
  '[/body/p[@paraId=00100000]] 「季度研究报告」 ← Heading1 | 等线 11pt',
  '[/body/p[@paraId=00100002]] 「本季度收入同比增长 25%。」 ← Normal | 等线 11pt',
  '[/body/p[@paraId=00100004]] 「风险提示」 ← Heading2 | 等线 11pt',
  '[/body/p[@paraId=00100006]] 「供应链仍有不确定性。」 ← Normal | 等线 11pt',
].join('\n');

const XLSX_TEXT = [
  '=== Sheet: Sheet1 ===',
  '[/Sheet1/row[1]] A1=地区\tB1=销量',
  '[/Sheet1/row[2]] A2=华东\tB2=1200',
  '[/Sheet1/row[3]] A3=华南\tB3=980',
  '',
  '=== Sheet: 汇总 ===',
  '[/汇总/row[1]] A1=合计\tB1=2180',
].join('\n');

const PPTX_TEXT = [
  '=== /slide[1] ===',
  '季度汇报',
  '收入增长 25%',
  '',
  '=== /slide[2] ===',
  '风险提示',
  '供应链不确定性',
].join('\n');

/** 注册守卫的 disposer（本文件注册过才非 null）。 */
let disposeOffice: (() => void) | null = null;

/** 注册面取件：用户注册行已落 ⇒ 直接用；未落 ⇒ 动态取 def 自注册（幂等：`get(id)` 存在则跳过）。 */
async function ensureOfficeRegistered(): Promise<void> {
  if (viewerRegistry.get('office') || disposeOffice) return;
  const mod = await import('../src/plugins/builtin/renderers/viewers/office');
  if (viewerRegistry.get('office')) return; // 用户注册行已落 ⇒ 不重复注册（同名装载期会 throw）
  disposeOffice = viewerRegistry.register(mod.officeViewer);
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  await ensureOfficeRegistered();
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

/** 每一次 office_exec 调用的载荷（只读纪律断言用）。 */
let officeCalls: OfficeExecParams[] = [];

/** 读口桩：按 argv 回内容文本；逐次记下载荷。 */
function stubOffice(handler: (argv: string[]) => string): void {
  vi.mocked(typedRpc).mockImplementation(async (_m: string, params: Record<string, unknown>) => {
    const p = params as OfficeExecParams;
    officeCalls.push(p);
    return handler(p.office?.argv ?? []);
  });
}

describe('Office 查看器（docx / xlsx / pptx）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    officeCalls = [];
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function renderFile(payload: unknown): Promise<void> {
    root?.unmount(); // 同一用例里换文件：先卸旧根（免得 createRoot 撞同一容器）
    root = null;
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock(payload) }));
      await Promise.resolve();
    });
    // 读取链是「RPC resolve → 解析 → setState」多跳：再空跑一轮宏任务让状态落定
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('docx：一次 `view <f> annotated` 调用 + 标题按层级、正文按行 + 读数行', async () => {
    stubOffice(() => officeOk(DOCX_ANNOTATED));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/报告.docx', ext: 'docx', label: '报告.docx' });
      expect(typedRpc).toHaveBeenCalledWith('process_cap', {
        action: 'office_exec',
        office: {
          argv: ['view', 'D:/报告.docx', 'annotated'],
          targets: [{ path: 'D:/报告.docx', write: false }],
        },
        is_agent: false,
      });
      expect(typedRpc).toHaveBeenCalledTimes(1); // 一次调用取全，不逐段重读
      expect(container.querySelector('.pp-viewer-office-h1')?.textContent).toBe('季度研究报告');
      expect(container.querySelector('.pp-viewer-office-h2')?.textContent).toBe('风险提示');
      const paras = [...container.querySelectorAll('.pp-viewer-office-p')].map((n) => n.textContent);
      expect(paras).toEqual(['本季度收入同比增长 25%。', '供应链仍有不确定性。']);
      const note = container.querySelector('.pp-viewer-note')?.textContent ?? '';
      expect(note).toContain('4 段正文');
      expect(note).toContain('2 处标题');
      // 不是一整坨 pre（块序列 = 逐块元素）
      expect(container.querySelector('.pp-viewer-office pre')).toBeNull();
    });
  });

  it('docx：表格节点出标记行（结构不丢）+ 读数行报表格数', async () => {
    stubOffice(() =>
      officeOk(
        ['[/body/p[@paraId=00100000]] 「含表格的文档」 ← Normal | 等线 11pt', '[/body/tbl[1]] [Table: 3×3]'].join('\n'),
      ),
    );
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/表.docx', ext: 'docx', label: '表.docx' });
      expect(container.querySelector('.pp-viewer-office-table')?.textContent).toBe('[Table: 3×3]');
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain('1 处表格');
    });
  });

  it('docx：空文档（officecli 无输出）⇒ 明说没有正文，不留空白盒', async () => {
    stubOffice(() => officeOk(''));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/空.docx', ext: 'docx', label: '空.docx' });
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('没有正文');
    });
  });

  it('xlsx：一次 `view text` 取全多表 → 表体走 grid 原语 + 页签切换**不重读**', async () => {
    stubOffice(() => officeOk(XLSX_TEXT));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/账.xlsx', ext: 'xlsx', label: '账.xlsx' });
      expect(officeCalls[0].office?.argv).toEqual(['view', 'D:/账.xlsx', 'text']);
      // 表体 = grid 原语（列头走列号：officecli 不给「表头行」概念，不替用户猜）
      expect([...container.querySelectorAll('.pp-grid-table th')].map((n) => n.textContent)).toEqual(['A', 'B']);
      const rows = (): string[][] =>
        [...container.querySelectorAll('.pp-grid-table tbody tr')].map((tr) =>
          [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''),
        );
      expect(rows()).toEqual([
        ['地区', '销量'],
        ['华东', '1200'],
        ['华南', '980'],
      ]);
      expect([...container.querySelectorAll('.pp-viewer-office-tab')].map((n) => n.textContent)).toEqual([
        'Sheet1',
        '汇总',
      ]);
      // 切到第二张表：只重渲，不再调 RPC
      await act(async () => {
        (container.querySelectorAll('.pp-viewer-office-tab')[1] as HTMLButtonElement).click();
      });
      expect(typedRpc).toHaveBeenCalledTimes(1);
      expect(rows()).toEqual([['合计', '2180']]);
      expect(container.querySelector('.pp-viewer-office-tab--on')?.textContent).toBe('汇总');
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain('2 张工作表');
    });
  });

  it('xlsx：单表不出页签（一个表不需要切换）；空表出可读空态', async () => {
    stubOffice(() => officeOk('=== Sheet: Sheet1 ===\n[/Sheet1/row[1]] A1=唯一\tB1=1'));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/单.xlsx', ext: 'xlsx', label: '单.xlsx' });
      expect(container.querySelector('.pp-viewer-office-tabs')).toBeNull();
      expect(container.querySelector('.pp-grid-table')).not.toBeNull();
    });
  });

  it('xlsx：全空工作表 ⇒ 可读空态（不画一张没有列的空表）', async () => {
    stubOffice(() => officeOk('=== Sheet: Sheet1 ==='));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/空.xlsx', ext: 'xlsx', label: '空.xlsx' });
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('没有非空单元格');
      expect(container.querySelector('.pp-grid-table')).toBeNull();
    });
  });

  it('pptx：一次 `view text` → 逐页（页序 + 每页文本块）', async () => {
    stubOffice(() => officeOk(PPTX_TEXT));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/汇报.pptx', ext: 'pptx', label: '汇报.pptx' });
      expect(officeCalls[0].office?.argv).toEqual(['view', 'D:/汇报.pptx', 'text']);
      const slides = [...container.querySelectorAll('.pp-viewer-office-slide')];
      expect(slides.length).toBe(2);
      expect(container.querySelectorAll('.pp-viewer-office-page')[0].textContent).toContain('/slide[1]');
      expect(container.querySelectorAll('.pp-viewer-office-page')[1].textContent).toContain('第 2 页 · /slide[2]');
      expect(slides[0].textContent).toContain('季度汇报');
      expect(slides[0].textContent).toContain('收入增长 25%');
      expect(slides[1].textContent).toContain('供应链不确定性');
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain('2 页');
    });
  });

  it('officecli 报错（文件不是 OOXML）⇒ 一行可读错误，带文件名与原话', async () => {
    stubOffice(() => officeFail(1, 'Error: Cannot open 报告.docx: File contains corrupted data.'));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/报告.docx', ext: 'docx', label: '报告.docx' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('报告.docx');
      expect(err).toContain('读正文（view annotated）');
      expect(err).toContain('File contains corrupted data.');
      expect(err).toContain('不是有效的 OOXML');
      expect(container.querySelector('.pp-viewer-office')).toBeNull();
    });
  });

  it('officecli 缺失 ⇒ 一行可读错误点明解析序（不静默、不空白）', async () => {
    stubOffice(() => officeFail(127, '/usr/bin/bash: line 1: officecli: command not found'));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/账.xlsx', ext: 'xlsx', label: '账.xlsx' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('没找到 officecli 可执行文件');
      expect(err).toContain('$OFFICECLI_PATH');
      expect(err).toContain('command not found');
    });
  });

  it('超时（退出码 -1）⇒ 一行可读错误点明超时', async () => {
    stubOffice(() => '[exit code: -1] 命令超时 (120000ms)，已终止。\n');
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/大.pptx', ext: 'pptx', label: '大.pptx' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('大.pptx');
      expect(err).toContain('超时');
    });
  });

  it('返回里没有退出码（读口形态变了）⇒ 结果未知，绝不 JSON 兜底当内容', async () => {
    stubOffice(() => JSON.stringify({ ok: true, data: { elements: [{ text: '不该被当成正文' }] } }));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/x.docx', ext: 'docx', label: 'x.docx' });
      const err = container.querySelector('.pp-viewer-error')?.textContent ?? '';
      expect(err).toContain('没有退出码');
      // 原始载荷只出现在错误行里（原话前 200 字符）——**绝不**当成内容渲染成块
      expect(container.querySelector('.pp-viewer-office')).toBeNull();
      expect(container.querySelector('.pp-viewer-error')).not.toBeNull();
    });
  });

  it('能力口拒绝（口内报错）⇒ 一行可读错误带原话', async () => {
    vi.mocked(typedRpc).mockRejectedValue(new Error("office_exec: 动词 'raw' 不在允许面"));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/x.docx', ext: 'docx', label: 'x.docx' });
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('不在允许面');
    });
  });

  it('只读：每个 argv 首词都在读动词白名单内，targets 恒 write:false', async () => {
    stubOffice((argv) => officeOk(argv[2] === 'annotated' ? DOCX_ANNOTATED : XLSX_TEXT));
    await withRenderers(async () => {
      await renderFile({ filePath: 'D:/a.docx', ext: 'docx', label: 'a.docx' });
      await renderFile({ filePath: 'D:/a.xlsx', ext: 'xlsx', label: 'a.xlsx' });
      await renderFile({ filePath: 'D:/a.pptx', ext: 'pptx', label: 'a.pptx' });
      expect(officeCalls.length).toBe(3);
      for (const call of officeCalls) {
        const argv = call.office?.argv ?? [];
        expect(['view', 'get', 'query', 'validate']).toContain(argv[0]);
        for (const verb of ['set', 'add', 'remove', 'batch', 'create', 'merge', 'load_skill']) {
          expect(argv[0]).not.toBe(verb);
        }
        expect(call.office?.targets).toEqual([{ path: call.office?.targets?.[0].path, write: false }]);
        expect(call.is_agent).toBe(false);
      }
    });
  });

  it('无 filePath ⇒ 文件壳（不发任何 RPC）', async () => {
    await withRenderers(async () => {
      await renderFile({ ext: 'docx', label: '报告.docx' });
      expect(container.querySelector('.pp-media-file')).not.toBeNull();
      expect(container.querySelector('.pp-media-ext')?.textContent).toBe('docx');
      expect(typedRpc).not.toHaveBeenCalled();
    });
  });

  it('认领面：docx / xlsx / pptx 三个扩展名都路由到 office，且不读字节', () => {
    const def = viewerRegistry.get('office');
    expect(def).toBeTruthy();
    expect(def?.id).toBe('office');
    expect(def?.needsBytes).toBe(false);
    for (const ext of ['docx', 'xlsx', 'pptx']) {
      expect(viewerRegistry.resolve(ext)?.id, ext).toBe('office');
    }
  });
});
