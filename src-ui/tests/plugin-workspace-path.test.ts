// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 工作区根围栏纯函数（P1）——路径拼接/越界判断/内容版本。

import { describe, expect, it } from 'vitest';
import {
  contentRevision,
  isWithinWorkspace,
  joinWorkspacePath,
  mimeOfPath,
  normalizeRelPath,
  normalizeWorkspaceRoot,
  relativeWorkspacePath,
  resolveFileHref,
} from '../src/state/plugin-workspace-path';

describe('工作区根围栏', () => {
  it('相对路径：拒绝绝对/盘符/回溯/反斜杠/冒号，允许空串', () => {
    expect(normalizeRelPath('')).toBe('');
    expect(normalizeRelPath('docs/a.md')).toBe('docs/a.md');
    expect(normalizeRelPath('./docs//a.md')).toBe('docs/a.md');
    expect(normalizeRelPath('../a.md')).toBeNull();
    expect(normalizeRelPath('docs/../../a.md')).toBeNull();
    expect(normalizeRelPath('/etc/passwd')).toBeNull();
    expect(normalizeRelPath('C:/x.md')).toBeNull();
    expect(normalizeRelPath('docs\\a.md')).toBe('docs/a.md');
    expect(normalizeRelPath('docs/a:b.md')).toBeNull();
  });

  it('根归一：Windows 盘符、POSIX 根、尾斜杠', () => {
    expect(normalizeWorkspaceRoot('D:\\proj\\')).toBe('D:/proj');
    expect(normalizeWorkspaceRoot('D:\\')).toBe('D:/');
    expect(normalizeWorkspaceRoot('/work//')).toBe('/work');
    expect(normalizeWorkspaceRoot('/')).toBe('/');
    expect(normalizeWorkspaceRoot('')).toBe('');
  });

  it('拼接：根 + 相对路径（Windows/POSIX）', () => {
    expect(joinWorkspacePath('D:\\proj', 'docs/a.md')).toBe('D:/proj/docs/a.md');
    expect(joinWorkspacePath('D:\\proj\\', '')).toBe('D:/proj');
    expect(joinWorkspacePath('D:\\', 'a.md')).toBe('D:/a.md');
    expect(joinWorkspacePath('/work', 'docs/a.md')).toBe('/work/docs/a.md');
    expect(joinWorkspacePath('/work', '')).toBe('/work');
    expect(joinWorkspacePath('/work', '../x')).toBeNull();
    expect(joinWorkspacePath('/work', '/etc/passwd')).toBeNull();
  });

  it('根内判断：前缀不能靠字符串巧合，Windows 大小写不敏感', () => {
    expect(isWithinWorkspace('/work', '/work/a.md')).toBe(true);
    expect(isWithinWorkspace('/work', '/work')).toBe(true);
    expect(isWithinWorkspace('/work', '/workspace/a.md')).toBe(false);
    expect(isWithinWorkspace('/work/', '/work/a.md')).toBe(true);
    expect(isWithinWorkspace('D:/proj', 'd:/proj/a.md')).toBe(true);
    expect(isWithinWorkspace('D:/proj', 'D:/proj2/a.md')).toBe(false);
    expect(isWithinWorkspace('/', '/a.md')).toBe(true);
  });

  it('反推相对路径', () => {
    expect(relativeWorkspacePath('/work', '/work/docs/a.md')).toBe('docs/a.md');
    expect(relativeWorkspacePath('D:/proj', 'D:/proj/a.md')).toBe('a.md');
    expect(relativeWorkspacePath('/work', '/elsewhere/a.md')).toBeNull();
  });

  it('内容版本稳定且区分内容', () => {
    expect(contentRevision('abc')).toBe(contentRevision('abc'));
    expect(contentRevision('abc')).not.toBe(contentRevision('abd'));
    expect(contentRevision('')).toMatch(/^0\./);
  });

  it('文档内相对链接：按文档目录解析，Windows/POSIX/UNC 都认', () => {
    expect(resolveFileHref('D:/proj/docs/a.md', '../b.md')).toBe('D:/proj/b.md');
    expect(resolveFileHref('D:/proj/docs/a.md', 'sub/c.md#x')).toBe('D:/proj/docs/sub/c.md');
    expect(resolveFileHref('/work/docs/a.md', './img/x.png')).toBe('/work/docs/img/x.png');
    expect(resolveFileHref('//srv/share/docs/a.md', '../b.md')).toBe('//srv/share/b.md');
    expect(resolveFileHref('D:/proj/docs/a.md', 'https://example.com')).toBeNull();
    expect(resolveFileHref('D:/proj/docs/a.md', '/etc/passwd')).toBeNull();
    expect(resolveFileHref('D:/proj/docs/a.md', 'a\\b.md')).toBeNull();
    // 解析器只做路径归一，根围栏由宿主（isWithinWorkspace）再判；
    // 越过文档目录但在文件系统根内是合法绝对路径。
    expect(resolveFileHref('/work/a.md', '../b.md')).toBe('/b.md');
  });

  it('资产 MIME 按后缀', () => {
    expect(mimeOfPath('a.PNG')).toBe('image/png');
    expect(mimeOfPath('a.jpeg')).toBe('image/jpeg');
    expect(mimeOfPath('a.svg')).toBe('image/svg+xml');
    expect(mimeOfPath('a.pdf')).toBe('application/pdf');
    expect(mimeOfPath('a.bin')).toBe('application/octet-stream');
  });
});
