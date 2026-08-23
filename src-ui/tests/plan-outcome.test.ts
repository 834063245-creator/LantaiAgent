// exit_plan_mode 审批 outcome 语义（execute / archive）—
// option 可携带 outcome 标记：archive=批准留档不执行（保持规划模式），
// execute=默认，批准即切换执行模式。UI 可用 response.outcome 显式覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';

// mock typedRpc：exit_plan_mode 通过它读计划文件
// 计划文件路径格式：{project}/.lantai/plans/plan-<ts>-<rand>.md
vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(async (method: string, args: { file_path: string }) => {
    if (
      method === 'read_file_content' &&
      args.file_path.includes('.lantai/plans/') &&
      args.file_path.endsWith('.md')
    ) {
      return '1\t# 计划\n2\t正文';
    }
    throw new Error(`unexpected rpc: ${method}`);
  }),
}));

import type { EventSink } from '../src/agent/agent-types';
import { PlanStateManager } from '../src/agent/plan/plan-state';
import type { PlanReviewRequest } from '../src/agent/plan/plan-tools';
import { createExitPlanModeTool } from '../src/agent/plan/plan-tools';
import { typedRpc } from '../src/rpc-contract';

/** 捕获型 eventSink + 执行器：execute() 后通过 lastRequest 拿到 PlanReview 请求 */
function setup(plan: PlanStateManager) {
  let captured: PlanReviewRequest | null = null;
  const sink: EventSink = (ev) => {
    if (ev.kind === 'plan_review' && ev.plan) captured = ev.plan as PlanReviewRequest;
  };
  const tool = createExitPlanModeTool(plan, sink);
  return {
    tool,
    /** 触发 exit_plan_mode；typedRpc await 后 eventSink 才发事件，故 flush 微任务再取请求 */
    run: async (args: Record<string, unknown> = {}) => {
      const p = tool.execute(args) as Promise<string>;
      await Promise.resolve(); // flush typedRpc 微任务
      if (!captured) throw new Error('eventSink 未捕获到 PlanReview 请求');
      return { request: captured, promise: p };
    },
  };
}

beforeEach(() => {
  vi.mocked(typedRpc).mockClear();
});

describe('exit_plan_mode — outcome 语义', () => {
  it('默认（option 无 outcome）：批准即退出规划模式', async () => {
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const { run } = setup(ps);
    const { request, promise } = await run({
      options: [
        { label: '小步重构', description: '风险低' },
        { label: '保守方案', description: '改动最小' },
      ],
    });
    request.callback({ decision: 'approved', selectedLabel: '小步重构' });
    const out = await promise;
    expect(out).toContain('已批准');
    expect(out).toContain('选定方案：小步重构');
    expect(out).toContain('已切换到执行模式');
    expect(ps.state.active).toBe(false);
  });

  it('选中 option 带 outcome=archive：批准留档，保持规划模式', async () => {
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const { run } = setup(ps);
    const { request, promise } = await run({
      options: [
        { label: '小步重构', description: '风险低' },
        { label: '大爆炸', description: '一次到位', outcome: 'archive' },
      ],
    });
    // 请求侧 options 透传 outcome
    expect(request.options?.find((o) => o.label === '大爆炸')?.outcome).toBe('archive');
    request.callback({ decision: 'approved', selectedLabel: '大爆炸' });
    const out = await promise;
    expect(out).toContain('留档');
    expect(out).toContain('大爆炸');
    expect(out).toContain('保持规划模式');
    // 关键语义：规划模式未退出
    expect(ps.state.active).toBe(true);
  });

  it('UI 显式 outcome=archive 覆盖 option 默认 execute', async () => {
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const { run } = setup(ps);
    const { request, promise } = await run({
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
    });
    request.callback({ decision: 'approved', selectedLabel: 'A', outcome: 'archive' });
    const out = await promise;
    expect(out).toContain('留档');
    expect(ps.state.active).toBe(true);
  });

  it('UI 显式 outcome=execute 覆盖 option 标记 archive', async () => {
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const { run } = setup(ps);
    const { request, promise } = await run({
      options: [
        { label: 'A', description: 'a', outcome: 'archive' },
        { label: 'B', description: 'b', outcome: 'archive' },
      ],
    });
    request.callback({ decision: 'approved', selectedLabel: 'A', outcome: 'execute' });
    const out = await promise;
    expect(out).toContain('已切换到执行模式');
    expect(ps.state.active).toBe(false);
  });

  it('revise / rejected 不受 outcome 影响，保持规划模式', async () => {
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const { run } = setup(ps);
    const r1 = await run();
    r1.request.callback({ decision: 'revise', feedback: '改小范围' });
    expect(await r1.promise).toContain('修改计划');
    expect(ps.state.active).toBe(true);

    const r2 = await run();
    r2.request.callback({ decision: 'rejected' });
    expect(await r2.promise).toContain('拒绝');
    expect(ps.state.active).toBe(true);
  });

  it('不在规划模式：返回错误提示，不发 PlanReview', async () => {
    const ps = new PlanStateManager();
    let sinkCalled = false;
    const sink: EventSink = () => {
      sinkCalled = true;
    };
    const tool = createExitPlanModeTool(ps, sink);
    const out = await tool.execute({});
    expect(out).toContain('不在规划模式');
    expect(sinkCalled).toBe(false);
  });

  it('无 eventSink（headless）：自动批准并退出规划模式', async () => {
    const ps = new PlanStateManager();
    ps.enter('/proj');
    const tool = createExitPlanModeTool(ps, undefined);
    const out = await tool.execute({});
    expect(out).toContain('自动批准');
    expect(ps.state.active).toBe(false);
  });
});
