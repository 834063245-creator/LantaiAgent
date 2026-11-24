// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/file-ref — 会话文件引用的路径解析（2026-11-23 相对路径批；
// 2026-11-24 可点判定收紧批）。
// 判据：绝对/相对归一 / ~ 与 MSYS 形态 / 非文件（标识符/glob/占位符）不认。
// 用户操作序列式断言：模型写什么 → 宿主拿到什么绝对路径。

import { describe, expect, it } from 'vitest';
import {
  candidateFileRefs,
  isAbsoluteLocalPath,
  isLocalFileReference,
  isOpenableDocumentPath,
  normalizeLocalPath,
  resolveFileReference,
} from '../src/paper/file-ref';

const ROOT = 'D:/HoloGramHG';

describe('paper/file-ref — 绝对路径（原样归一，不查根）', () => {
  it('盘符 / UNC / POSIX 根都认，反斜杠归一为正斜杠', () => {
    expect(resolveFileReference('D:\\ws\\docs\\a.md', ROOT)).toBe('D:/ws/docs/a.md');
    expect(resolveFileReference('D:/ws/docs/a.md', ROOT)).toBe('D:/ws/docs/a.md');
    expect(resolveFileReference('\\\\srv\\share\\a.md', ROOT)).toBe('//srv/share/a.md');
    expect(resolveFileReference('/home/u/a.md', ROOT)).toBe('/home/u/a.md');
  });

  it('MSYS / Cygwin 盘符路径转 Windows（2026-11-24）', () => {
    expect(resolveFileReference('/d/HoloGramHG/src-ui', ROOT)).toBe('d:/HoloGramHG/src-ui');
    expect(resolveFileReference('/cygdrive/d/HoloGramHG/a.md', ROOT)).toBe('d:/HoloGramHG/a.md');
    // 首段多字母 = 真 POSIX，不误切盘符
    expect(resolveFileReference('/home/u/a.md', ROOT)).toBe('/home/u/a.md');
  });

  it('~ 原样保留（Rust 会展开，前端不拼根）', () => {
    expect(resolveFileReference('~/.lantai/providers.yml', ROOT)).toBe('~/.lantai/providers.yml');
    expect(resolveFileReference('~\\.lantai\\mcp.json', ROOT)).toBe('~/.lantai/mcp.json');
    expect(resolveFileReference('~', ROOT)).toBe('~');
    expect(resolveFileReference('~foo/a.md', ROOT)).toBeNull();
  });

  it('消 . / .. 段；越过盘符根的 .. 夹住（不把 .. 甩给 Rust）', () => {
    expect(resolveFileReference('D:/ws/./docs/../README.md', ROOT)).toBe('D:/ws/README.md');
    expect(resolveFileReference('D:/../etc/passwd', ROOT)).toBe('D:/etc/passwd');
    expect(normalizeLocalPath('D:/a/../../b')).toBe('D:/b');
    // 根边界：POSIX 根弹空即止；UNC 根（server/share）不参与弹栈
    expect(normalizeLocalPath('/a/../..')).toBe('/');
    expect(normalizeLocalPath('//srv/share/../../x')).toBe('//srv/share/x');
  });

  it('Windows 扩展前缀剥壳；设备命名空间不认', () => {
    expect(resolveFileReference('\\\\?\\D:\\ws\\a.md', ROOT)).toBe('D:/ws/a.md');
    expect(resolveFileReference('\\\\.\\pipe\\x', ROOT)).toBeNull();
  });
});

describe('paper/file-ref — 相对路径（基准 = 工作区根）', () => {
  it('仓库相对路径 / ./ / ../ 都拼根', () => {
    expect(resolveFileReference('docs/README.md', ROOT)).toBe('D:/HoloGramHG/docs/README.md');
    expect(resolveFileReference('./docs/README.md', ROOT)).toBe('D:/HoloGramHG/docs/README.md');
    expect(resolveFileReference('../other/a.md', ROOT)).toBe('D:/other/a.md');
    expect(resolveFileReference('docs\\a.md', 'D:\\HoloGramHG\\')).toBe('D:/HoloGramHG/docs/a.md');
  });

  it('裸文件名带已知文件后缀算路径；裸词/目录 token 不算', () => {
    expect(resolveFileReference('CLAUDE.md', ROOT)).toBe('D:/HoloGramHG/CLAUDE.md');
    expect(resolveFileReference('PaperPanel.tsx', ROOT)).toBe('D:/HoloGramHG/PaperPanel.tsx');
    expect(resolveFileReference('npm', ROOT)).toBeNull();
    expect(resolveFileReference('2026/11/23', ROOT)).toBeNull();
    expect(resolveFileReference('v1.2.3', ROOT)).toBeNull();
  });

  it('点号标识符 / 纯后缀 / glob / 占位符不是文件（2026-11-24 收紧）', () => {
    for (const raw of [
      'doc.save',
      'ctx.windows',
      'style.transform',
      'JSON.parse',
      'manifest.app',
      'window.lantai.state',
      '.ts',
      '.tsx',
      'composer-*.tsx',
      'surface/use-composer-*.ts',
      'plugins/builtin/*/host.ts',
      'engine/grammars/build/**/parser.c',
      '.lantai/asset-state/<会话号>.json',
      'D:\\Cache\\…',
      'plab-a…f*.png',
    ]) {
      expect(resolveFileReference(raw, ROOT), raw).toBeNull();
    }
  });

  it('无工作区根 ⇒ 相对路径 null（绝对路径 / ~ 不受影响）', () => {
    expect(resolveFileReference('docs/README.md', '')).toBeNull();
    expect(resolveFileReference('D:/ws/a.md', '')).toBe('D:/ws/a.md');
    expect(resolveFileReference('~/.lantai/a.yml', '')).toBe('~/.lantai/a.yml');
  });
});

describe('paper/file-ref — 非文件引用一律 null（不误伤）', () => {
  it('URL / 锚点 / 含空白 / 空串', () => {
    for (const raw of [
      'https://example.com/a.md',
      'http://x/y',
      'mailto:a@b.c',
      'data:text/plain,hi',
      '#L24',
      'npm run build',
      '',
      '   ',
    ]) {
      expect(resolveFileReference(raw, ROOT), raw).toBeNull();
    }
  });

  it('file:// URI 归一（%XX 解码；盘符去前导斜杠）', () => {
    expect(resolveFileReference('file:///D:/My%20Docs/a.md', ROOT)).toBe('D:/My Docs/a.md');
    expect(resolveFileReference('file:///d/HoloGramHG/a.md', ROOT)).toBe('d:/HoloGramHG/a.md');
  });

  it('行锚片段与 :行号 后缀剥掉；百分号编码解码', () => {
    expect(resolveFileReference('docs/a.md#L24', ROOT)).toBe('D:/HoloGramHG/docs/a.md');
    expect(resolveFileReference('docs/a.md:24', ROOT)).toBe('D:/HoloGramHG/docs/a.md');
    expect(resolveFileReference('docs/a.md:24-30', ROOT)).toBe('D:/HoloGramHG/docs/a.md');
    expect(resolveFileReference('docs/My%20Doc.md', ROOT)).toBe('D:/HoloGramHG/docs/My Doc.md');
  });
});

describe('paper/file-ref — 候选子根（模型写短路径时再试一次）', () => {
  it('多段相对路径按常见子根补候选；裸文件名不猜', () => {
    expect(candidateFileRefs('tests/setup.ts', ROOT)).toContain('D:/HoloGramHG/src-ui/tests/setup.ts');
    expect(candidateFileRefs('paper/fold.ts', ROOT)).toContain('D:/HoloGramHG/src-ui/src/paper/fold.ts');
    expect(candidateFileRefs('plans/README.md', ROOT)).toContain('D:/HoloGramHG/docs/plans/README.md');
    expect(candidateFileRefs('PaperPanel.tsx', ROOT)).toEqual(['D:/HoloGramHG/PaperPanel.tsx']);
    expect(candidateFileRefs('D:/x/a.md', ROOT)).toEqual(['D:/x/a.md']);
    expect(candidateFileRefs('~/.lantai/a.yml', ROOT)).toEqual(['~/.lantai/a.yml']);
  });
});

describe('paper/file-ref — 可打开 / 本机形态判据', () => {
  it('文卷能打开的文本/代码后缀', () => {
    for (const name of [
      'a.md',
      'a.markdown',
      'a.txt',
      'a.ts',
      'a.tsx',
      'a.json',
      'a.yml',
      'a.css',
      'README',
      'Makefile',
    ]) {
      expect(isOpenableDocumentPath(name), name).toBe(true);
    }
    for (const name of ['a.png', 'a.jpg', 'a.exe', 'a.pdf', 'doc.save', 'ctx.windows', '.gitignore', 'a']) {
      expect(isOpenableDocumentPath(name), name).toBe(false);
    }
  });

  it('isLocalFileReference：本地文件形为真，URL/标识符为假', () => {
    expect(isLocalFileReference('docs/a.md', ROOT)).toBe(true);
    expect(isLocalFileReference('D:/ws/a.ts', ROOT)).toBe(true);
    expect(isLocalFileReference('~/.lantai/providers.yml', ROOT)).toBe(true);
    expect(isLocalFileReference('https://example.com/a.md', ROOT)).toBe(false);
    expect(isLocalFileReference('doc.save', ROOT)).toBe(false);
  });
});

describe('paper/file-ref — isAbsoluteLocalPath', () => {
  it('三种绝对形态为真，相对/URL 为假', () => {
    for (const p of ['D:/a', 'D:\\a', '\\\\srv\\a', '//srv/a', '/a']) expect(isAbsoluteLocalPath(p), p).toBe(true);
    for (const p of ['a/b', './a', 'https://x/a', 'C:relative']) expect(isAbsoluteLocalPath(p), p).toBe(false);
  });
});
