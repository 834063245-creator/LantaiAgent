// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 测试腰：coding 五族工具拼接（2026-09-24 批 4c-1 起替代退役的内核聚合工厂）。
//
// 为什么在测试侧：五族各归其产物包后，「拼一起」只对测试有意义——内核拼聚合 =
// 内核 import 产物（宿主→插件禁反）。各族搬走时**只改本文件的 import 一行**，
// 消费方（define-tool / tool-param-contract / parallel-subagent-bugs）不动。

import type { CodingToolsUI, Tool, ToolExecutor } from '../../src/agent/tool';
import { createAgentIsolationTools } from '../../src/plugins/builtin/agent-isolation-domain/isolation-tools';
import { createAskUserTools } from '../../src/plugins/builtin/ask-domain/ask-tools';
import { createFsTools } from '../../src/plugins/builtin/fs-domain/fs-tools';
import { createGitTools } from '../../src/plugins/builtin/git-domain/git-tools';
import { createShellTools } from '../../src/plugins/builtin/shell-domain/shell-tools';

/** 五族全量工具（表序 = 历史 createCodingTools 的拼接序：fs → shell → git → isolation → ask）。 */
export function buildCodingTools(exec: ToolExecutor, ui?: CodingToolsUI): Tool[] {
  return [
    ...createFsTools(exec),
    ...createShellTools(exec),
    ...createGitTools(exec),
    ...createAgentIsolationTools(exec),
    ...createAskUserTools(ui),
  ];
}
