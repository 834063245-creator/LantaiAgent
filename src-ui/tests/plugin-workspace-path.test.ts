// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 工作区根围栏纯函数（P1）——路径拼接/越界判断/内容版本。

import { describe, expect, it } from 'vitest';
import {
  contentRevision,
  isWithinWorkspace,
  joinWorkspacePath,
  normalizeRelPath,
  normalizeWorkspaceRoot,
  relativeWorkspacePath,
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
});
