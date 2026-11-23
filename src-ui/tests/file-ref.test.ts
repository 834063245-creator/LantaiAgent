// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/file-ref — 会话文件引用的路径解析（2026-11-23 相对路径批）。
// 判据三条：绝对路径归一 / 相对路径按工作区根解析 / 非本机文件不认。
// 用户操作序列式断言：模型写什么 → 宿主拿到什么绝对路径。

import { describe, expect, it } from 'vitest';
import {
  firstFileReference,
  isAbsoluteLocalPath,
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

  it('裸文件名带扩展名算路径；裸词/目录 token 不算', () => {
    expect(resolveFileReference('CLAUDE.md', ROOT)).toBe('D:/HoloGramHG/CLAUDE.md');
    expect(resolveFileReference('npm', ROOT)).toBeNull();
    expect(resolveFileReference('2026/11/23', ROOT)).toBeNull();
    expect(resolveFileReference('v1.2.3', ROOT)).toBeNull();
  });

  it('无工作区根 ⇒ 相对路径 null（绝对路径不受影响）', () => {
    expect(resolveFileReference('docs/README.md', '')).toBeNull();
    expect(resolveFileReference('D:/ws/a.md', '')).toBe('D:/ws/a.md');
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
  });

  it('行锚片段与 :行号 后缀剥掉；百分号编码解码', () => {
    expect(resolveFileReference('docs/a.md#L24', ROOT)).toBe('D:/HoloGramHG/docs/a.md');
    expect(resolveFileReference('docs/a.md:24', ROOT)).toBe('D:/HoloGramHG/docs/a.md');
    expect(resolveFileReference('docs/a.md:24-30', ROOT)).toBe('D:/HoloGramHG/docs/a.md');
    expect(resolveFileReference('docs/My%20Doc.md', ROOT)).toBe('D:/HoloGramHG/docs/My Doc.md');
  });
});

describe('paper/file-ref — 工具卡参数里的第一条引用（保守扫描）', () => {
  it('绝对路径优先', () => {
    expect(firstFileReference('读取 D:/ws/docs/a.md · 96 行', ROOT)).toBe('D:/ws/docs/a.md');
  });

  it('相对路径 token：带扩展名才认（日期/URL/裸词不算）', () => {
    expect(firstFileReference('路径：docs/README.md · 312 行', ROOT)).toBe('D:/HoloGramHG/docs/README.md');
    expect(firstFileReference('生成于 2026/11/23 结束', ROOT)).toBeNull();
    expect(firstFileReference('见 https://example.com/a.md 说明', ROOT)).toBeNull();
    expect(firstFileReference('npm run build', ROOT)).toBeNull();
  });
});

describe('paper/file-ref — isAbsoluteLocalPath', () => {
  it('三种绝对形态为真，相对/URL 为假', () => {
    for (const p of ['D:/a', 'D:\\a', '\\\\srv\\a', '//srv/a', '/a']) expect(isAbsoluteLocalPath(p), p).toBe(true);
    for (const p of ['a/b', './a', 'https://x/a', 'C:relative']) expect(isAbsoluteLocalPath(p), p).toBe(false);
  });
});
