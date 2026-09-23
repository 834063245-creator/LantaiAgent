// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// viewer-mail — 邮件查看器（渲染面补全 B13，2026-09-23）：
//   ① 认领表 = 宿主层分类表（eml ↔ 'mail' 类）；
//   ② 头字段（From/To/Cc/Subject/Date/Message-ID 有则显示，序固定）+ 正文；
//   ③ multipart：取第一个 text/plain 并**如实说明**「仅显示第 N 部分（共 M 部分）」，
//      附件清单出文件名 / 内容类型 / 声明大小；
//   ④ 编码：quoted-printable 与 base64（`atob` + `TextDecoder`——多字节 UTF-8）都解码；
//      `charset` 生效，不支持的标签退 utf-8 **并说明**；filename*（RFC 2231）解出 CJK 名；
//   ⑤ 头解析失败 ⇒ 可读错误 + **原文照显**（不空白、不 JSON 兜底）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererServicePlugin, resolveAssetBlock } from '../src/composition/renderer-service';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { createBlock, type SourcedBlock } from '../src/paper/block-model';
import { VIEWER_MAIL_EXTS, viewerClassOf } from '../src/paper/viewer-exts';
import { builtinRenderersPlugin } from '../src/plugins/builtin/renderers';
import { viewerRegistry } from '../src/plugins/builtin/renderers/viewer-registry';
import { mailViewer } from '../src/plugins/builtin/renderers/viewers/mail';
import { typedRpc } from '../src/rpc-contract';

vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(),
  typedJsonRpc: vi.fn(),
}));

/** 读口成功响应（`fs_cap read` 的文本结局：{path, content}）。 */
function readOk(content: string): string {
  return JSON.stringify({ path: 'D:/a.eml', content });
}

/** 注册自带 + 用完摘除：主编排批次把本查看器加进 `viewers/index.ts` 后，
 *  这里不因重名再注册（装载期重名是硬拒绝，不是可忽略的重复）。 */
function withViewerRegistered(): () => void {
  if (viewerRegistry.get(mailViewer.id)) return () => {};
  return viewerRegistry.register(mailViewer);
}

async function withRenderers(fn: () => void | Promise<void>): Promise<void> {
  const ctx = new Context();
  const disposeViewer = withViewerRegistered();
  const f1 = ctx.plugin(compositionServicesPlugin);
  await f1;
  const f2 = ctx.plugin(rendererServicePlugin);
  await f2;
  const f3 = ctx.plugin(builtinRenderersPlugin);
  await f3;
  try {
    await fn();
  } finally {
    await f3.dispose();
    await f2.dispose();
    await f1.dispose();
    disposeViewer();
  }
}

function mediaBlock(payload: unknown): SourcedBlock {
  return {
    ...createBlock('file', payload as never, { messageId: 'm1', part: null }),
    id: 'pb:m1:0',
    asset: { assetId: 'as_1', presentation: 'media', title: 't', finalised: true },
  };
}

/** 头字段名 → 值（显示序即 DOM 序）。 */
function fieldMap(container: HTMLElement): Map<string, string> {
  return new Map(
    [...container.querySelectorAll('.pp-viewer-mail-field')].map((row) => [
      row.querySelector('.pp-viewer-mail-fieldName')?.textContent ?? '',
      row.querySelector('.pp-viewer-mail-fieldValue')?.textContent ?? '',
    ]),
  );
}

const PLAIN = [
  'From: alice@example.com',
  'To: bob@example.com',
  'Cc: carol@example.com',
  'Subject: 测试邮件',
  'Date: Mon, 23 Sep 2026 10:00:00 +0800',
  'Message-ID: <abc@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '正文第一行',
  '正文第二行',
].join('\n');

const MULTI = [
  'From: alice@example.com',
  'Subject: 带附件的邮件',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  '5L2g5aW977yM5LiW55WM',
  '--BOUND',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQ=',
  '--BOUND--',
  '',
].join('\n');

const QP = [
  'Subject: QP 编码',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '=E4=BD=A0=E5=A5=BD=EF=BC=8C=E4=B8=96=E7=95=8C',
].join('\n');

describe('邮件查看器 · 认领面（B13）', () => {
  it('认领表就是宿主层分类表（eml 一个扩展名）', () => {
    expect([...mailViewer.exts]).toEqual([...VIEWER_MAIL_EXTS]);
    expect([...mailViewer.exts]).toEqual(['eml']);
    for (const ext of VIEWER_MAIL_EXTS) expect(viewerClassOf(ext), ext).toBe('mail');
  });

  it('文本读取形态：bytesKind text + 行窗口 readLines（不整份进 IPC）', async () => {
    expect(mailViewer.id).toBe('mail');
    expect(mailViewer.bytesKind).toBe('text');
    expect(mailViewer.readLines).toBe(4000);
    await withRenderers(async () => {
      expect(viewerRegistry.resolve('eml')?.id).toBe('mail');
      expect(viewerRegistry.resolve('EML')?.id).toBe('mail'); // 大小写宽容（宿主归一）
    });
  });

  it('本查看器不认领别类的扩展名（认领表逐字 = 分类表）', () => {
    for (const ext of ['srt', 'vtt', 'ttf', 'pdf', 'md', 'csv']) {
      expect(mailViewer.exts.includes(ext), ext).toBe(false);
    }
  });
});

describe('邮件查看器 · 解析与渲染（B13）', () => {
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

  async function renderMail(content: string): Promise<void> {
    vi.mocked(typedRpc).mockResolvedValue(readOk(content));
    const Comp = resolveAssetBlock('file', 'media')!;
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.eml', ext: 'eml', label: 'a.eml' }) }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('text/plain：行窗口读（limit = readLines + 1）+ 六个头字段 + 正文原文', async () => {
    await withRenderers(async () => {
      await renderMail(PLAIN);
      expect(typedRpc).toHaveBeenCalledWith('fs_cap', {
        action: 'read',
        file_path: 'D:/a.eml',
        limit: 4001,
        is_agent: false,
      });
      const fields = fieldMap(container);
      expect([...fields.keys()]).toEqual(['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID']);
      expect(fields.get('Subject')).toBe('测试邮件');
      expect(fields.get('From')).toBe('alice@example.com');
      expect(container.querySelector('.pp-viewer-mail-body')?.textContent).toBe('正文第一行\n正文第二行');
      expect(container.querySelector('.pp-viewer-note')).toBeNull(); // 非 multipart ⇒ 无提示
      expect(container.querySelector('.pp-viewer-mail-attach')).toBeNull();
    });
  });

  it('multipart：取第一个 text/plain + **如实说明**部分序号 + 附件清单', async () => {
    await withRenderers(async () => {
      await renderMail(MULTI);
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain(
        'MIME multipart：仅显示第 1 部分（共 2 部分）',
      );
      // base64 + TextDecoder：多字节 UTF-8 解得出，不是 atob 的 latin1 直读
      expect(container.querySelector('.pp-viewer-mail-body')?.textContent).toBe('你好，世界');
      const item = container.querySelector('.pp-viewer-mail-attachItem');
      expect(item?.querySelector('.pp-viewer-mail-attachName')?.textContent).toBe('report.pdf');
      expect(item?.querySelector('.pp-viewer-mail-attachType')?.textContent).toBe('application/pdf');
      expect(item?.querySelector('.pp-viewer-mail-attachSize')?.textContent).toBe('约 8 B');
      expect(container.querySelector('.pp-viewer-mail-attachTitle')?.textContent).toContain('附件 1 个');
    });
  });

  it('inline 部分不列进附件清单（附件数不虚报）', async () => {
    const inline = [
      'Subject: 内嵌图',
      'Content-Type: multipart/related; boundary="R"',
      '',
      '--R',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '正文里的图见下',
      '--R',
      'Content-Type: image/png; name="pic.png"',
      'Content-Disposition: inline; filename="pic.png"',
      'Content-Transfer-Encoding: base64',
      '',
      'QUJD',
      '--R--',
      '',
    ].join('\n');
    await withRenderers(async () => {
      await renderMail(inline);
      expect(container.querySelector('.pp-viewer-mail-body')?.textContent).toBe('正文里的图见下');
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain(
        'MIME multipart：仅显示第 1 部分（共 2 部分）',
      );
      expect(container.querySelector('.pp-viewer-mail-attach')).toBeNull();
    });
  });

  it('quoted-printable 解码（=XX 十六进制 → UTF-8 字节流）', async () => {
    await withRenderers(async () => {
      await renderMail(QP);
      expect(container.querySelector('.pp-viewer-mail-body')?.textContent).toBe('你好，世界');
      expect(container.querySelector('.pp-viewer-note')).toBeNull();
    });
  });

  it('charset 不受支持 ⇒ 退 utf-8 并**说明**（不静默换码）', async () => {
    const weird = [
      'Subject: 怪字符集',
      'Content-Type: text/plain; charset=x-unknown-931',
      'Content-Transfer-Encoding: base64',
      '',
      '5L2g5aW9',
    ].join('\n');
    await withRenderers(async () => {
      await renderMail(weird);
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain(
        'charset=x-unknown-931 不受支持——已按 utf-8 解码',
      );
      expect(container.querySelector('.pp-viewer-mail-body')?.textContent).toBe('你好');
    });
  });

  it('没有 text/plain 部分 ⇒ 明说（不假装没有附件），filename*（RFC 2231）解出 CJK 名', async () => {
    const onlyAttachment = [
      'Subject: 只有附件',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: application/octet-stream',
      "Content-Disposition: attachment; filename*=utf-8''%E4%B8%AD%E6%96%87.pdf",
      'Content-Transfer-Encoding: base64',
      '',
      'QUJD',
      '--B--',
      '',
    ].join('\n');
    await withRenderers(async () => {
      await renderMail(onlyAttachment);
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain(
        'MIME multipart：没有 text/plain 部分可显示（共 1 部分，附件见下）',
      );
      expect(container.querySelector('.pp-viewer-mail-body')?.textContent).toBe('（无 text/plain 正文）');
      expect(container.querySelector('.pp-viewer-mail-attachName')?.textContent).toBe('中文.pdf');
    });
  });

  it('非 text/plain 正文（text/html）按原文显示并注明类型（不做渲染）', async () => {
    const html = ['Subject: 只有 HTML 正文', 'Content-Type: text/html; charset=utf-8', '', '<p>正文在这里</p>'].join(
      '\n',
    );
    await withRenderers(async () => {
      await renderMail(html);
      expect(container.querySelector('.pp-viewer-note')?.textContent).toContain(
        '正文类型 text/html——按原文显示（不做渲染）',
      );
      expect(container.querySelector('.pp-viewer-mail-body')?.textContent).toBe('<p>正文在这里</p>');
    });
  });

  it('头解析失败（没有一行是「字段: 值」）⇒ 可读错误 + 原文照显', async () => {
    await withRenderers(async () => {
      await renderMail('这不是邮件头\n没有冒号\n\n正文在这里');
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('邮件头解析失败');
      const raw = container.querySelector('.pp-viewer-mail-raw')?.textContent ?? '';
      expect(raw).toContain('这不是邮件头');
      expect(raw).toContain('正文在这里');
      expect(container.querySelector('.pp-viewer-mail-field')).toBeNull();
    });
  });

  it('头与正文之间没有分隔空行 ⇒ 可读错误 + 原文照显', async () => {
    await withRenderers(async () => {
      await renderMail('Subject: 缺空行');
      expect(container.querySelector('.pp-viewer-error')?.textContent).toContain('没找到头部与正文的分隔空行');
      expect(container.querySelector('.pp-viewer-mail-raw')?.textContent).toBe('Subject: 缺空行');
    });
  });

  it('空文件 ⇒ 明说「邮件为空」，不留空白盒', async () => {
    await withRenderers(async () => {
      await renderMail('');
      expect(container.querySelector('.pp-viewer-empty')?.textContent).toContain('邮件为空');
      expect(container.querySelector('.pp-viewer-mail')).toBeNull();
    });
  });

  it('读口响应不是 JSON ⇒ 可读错误（带前 120 字符），不 JSON 兜底', async () => {
    vi.mocked(typedRpc).mockResolvedValue('<html>not json</html>');
    await withRenderers(async () => {
      const Comp = resolveAssetBlock('file', 'media')!;
      root = createRoot(container);
      await act(async () => {
        root!.render(createElement(Comp, { block: mediaBlock({ filePath: 'D:/a.eml', ext: 'eml', label: 'a.eml' }) }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const line = container.querySelector('.pp-media-loading')?.textContent ?? '';
      expect(line).toContain('无法解析为 JSON');
      expect(line).toContain('<html>not json</html>');
    });
  });
});
