// code 模式（2026-11-21）：程序内专属工具被**直调**时的引导反馈。
//
// 语义：工具还在册、程序里照常能 await 到，只是不在直调面（schemas 已扣）。
// 模型绕过 code_execution 直接点名时，必须拿到一条可行动的引导——否则
// 「组合说收进程序」只是一句空话（静默跑掉或含糊的 unknown tool 都不算）。
import { describe, expect, it } from 'vitest';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import { type Tool, ToolRegistry } from '../src/agent/tool';
import type { ToolCall } from '../src/provider/types';

function toyTool(name: string, order: string[]): Tool {
  return {
    name: () => name,
    description: () => name,
    parameters: () => ({ type: 'object', properties: {}, required: [] }),
    readOnly: () => true,
    execute: async () => {
      order.push(name);
      return `${name}-ok`;
    },
  };
}

function call(name: string): ToolCall {
  return { id: `call-${name}`, name, arguments: '{}' } as ToolCall;
}

describe('code 模式：直调程序内专属工具', () => {
  it('返回可行动的引导（不执行、不假装未知工具）', async () => {
    const order: string[] = [];
    const reg = new ToolRegistry();
    reg.register(toyTool('fs', order));
    reg.setProgramOnly('fs', true);

    const executor = new StreamingToolExecutor(reg, () => {});
    executor.addTool(call('fs'));
    const results = await executor.awaitRemaining();

    expect(results).toHaveLength(1);
    expect(order).toEqual([]); // 没有真执行
    const out = String(results[0]?.output ?? '');
    expect(out).toContain('[code 模式]');
    expect(out).toContain('code_execution');
    expect(out).toContain('tools.fs'); // 告诉它怎么写
    // 结果形状与「已淘汰重定向」同族：引导文本走 output（不是 err——它要模型读到
    // 并照做，而不是被记成一次失败调用）
    expect(results[0]?.err).toBeUndefined();
  });

  it('未声明为程序内专属的工具照常直调（零回归）', async () => {
    const order: string[] = [];
    const reg = new ToolRegistry();
    reg.register(toyTool('ask_user', order));

    const executor = new StreamingToolExecutor(reg, () => {});
    executor.addTool(call('ask_user'));
    const results = await executor.awaitRemaining();

    expect(order).toEqual(['ask_user']);
    expect(results[0]?.isError).toBeFalsy();
  });
});
