// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具卡「打开」签的来源（2026-11-24 可点判定收紧）：
// 只认文件动作（fs read/edit/write）的结构化 path/filePath——
// shell 的 cwd、code_execution 的代码片段、search 的正则都不再出签。

import { describe, expect, it } from 'vitest';
import { toolFileArg } from '../src/paper/tool-present';

describe('paper/tool-present — toolFileArg（工具卡打开签的唯一来源）', () => {
  it('fs(read/edit/write) 的 path/filePath/file_path 都认', () => {
    expect(toolFileArg('fs', '{"action":"read","path":"src/a.ts"}')).toBe('src/a.ts');
    expect(toolFileArg('fs', '{"action":"edit","filePath":"D:/ws/a.ts"}')).toBe('D:/ws/a.ts');
    expect(toolFileArg('fs', '{"action":"write","file_path":"D:/ws/a.ts","content":"x"}')).toBe('D:/ws/a.ts');
  });

  it('非文件动作 / 非 fs 工具一律 null（shell cwd、search 正则、code 片段不是文件）', () => {
    expect(toolFileArg('fs', '{"action":"list","path":"src"}')).toBeNull();
    expect(toolFileArg('fs', '{"action":"glob","pattern":"**/*.ts","dir":"src"}')).toBeNull();
    expect(toolFileArg('fs', '{"action":"mkdir","path":"src/new"}')).toBeNull();
    expect(toolFileArg('shell', '{"action":"run","command":"cd /d/ws && ls","cwd":"/d/ws"}')).toBeNull();
    expect(toolFileArg('code_execution', '{"code":"const p = "D:/ws/a.ts"; return p;"}')).toBeNull();
    expect(toolFileArg('search', '{"action":"content","pattern":"/framer-motion/","path":"src"}')).toBeNull();
    expect(toolFileArg('git', '{"action":"diff","file":"src/a.ts"}')).toBeNull();
  });

  it('缺参数 / 坏 JSON / 无 name → null（不炸投影）', () => {
    expect(toolFileArg('fs', '{"action":"read"}')).toBeNull();
    expect(toolFileArg('fs', 'not-json')).toBeNull();
    expect(toolFileArg(undefined, '{"action":"read","path":"a.ts"}')).toBeNull();
  });
});
