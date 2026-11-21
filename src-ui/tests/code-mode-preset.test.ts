// code 模式 preset（2026-11-21）——组合面到底有没有把工具从**直调面**收进程序。
//
// 判据只有一条：`schemas()`（模型直调面）扣掉 programOnly，而 `visibleTools()`
// （code_execution 的绑定集）照旧包含它们。任何一侧漏了，code 模式要么半残
// （程序里也调不到 = 剪行的失败形态），要么是空话（直调面没变）。
import { describe, expect, it } from 'vitest';
import { buildToolRegistry } from '../src/agent/runtime/agent-builder';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { resolvePresetComposition } from '../src/composition/presets';
import { SubAgentPool } from '../src/plugins/builtin/subagent-in-process/coordinator';
import { TaskManager } from '../src/plugins/builtin/task-domain/task';

describe('code 模式：直调面收进程序', () => {
  it('组合 → 注册表：programOnly 名进 visibleTools、不进 schemas（标准组合零变化）', async () => {
    const built = await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const code = resolvePresetComposition('code');
        const standard = resolvePresetComposition('standard');
        const deps = () => ({
          deps: {},
          taskManager: new TaskManager(),
          subAgentPool: new SubAgentPool(),
        });
        const codeReg = await buildToolRegistry({
          ...deps(),
          toolRows: code.tools,
          programOnly: code.programOnly,
        });
        const stdReg = await buildToolRegistry({ ...deps(), toolRows: standard.tools });
        return { code, standard, codeReg, stdReg };
      }),
    );

    const { code, codeReg, stdReg } = built;
    expect(code.programOnly.length).toBeGreaterThan(0);

    // ① 直调面：被声明的名字一个都不在
    const direct = codeReg.schemas().map((s) => s.name);
    for (const name of code.programOnly) {
      // 名字只对「这个组合里真有这个工具」的那批有意义；没装的行按语义静默忽略
      if (stdReg.get(name)) expect(direct, `${name} 应已收进程序`).not.toContain(name);
    }
    // 常驻原语仍直调（问人 / 计划模式 / 执行原语都不是「日常工具」）
    expect(direct).toContain('ask_user');
    expect(direct).toContain('wait');

    // ② 程序面：绑定集照旧包含它们（这是 code 模式不残废的证据）
    const visible = codeReg.visibleTools().map((t) => t.name());
    expect(visible).toContain('fs');
    expect(visible).toContain('shell');

    // ③ 标准组合零漂移：同一把尺子下直调面 ≡ 可见面
    expect(
      stdReg
        .schemas()
        .map((s) => s.name)
        .sort(),
    ).toEqual(
      stdReg
        .visibleTools()
        .map((t) => t.name())
        .sort(),
    );
  });
});
