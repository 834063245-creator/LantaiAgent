// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// S4 装载调度层（plugin-bundle-retirement）——boot 审计三条覆盖：
//   a) 依赖缺失 → PENDING 不报 error（装载层不拒载）
//   b) 依赖后到 → 自动 ACTIVE（cordis fiber 等待语义）
//   c) 依赖永不出现 → settle 审计 fail-loud 报缺名
// （2026-09-16：原第四条「消费面在 bootGate 前不可用 / 之后可用」随空转的
//  bootGate 服务整删——该 inject 面从未被任何生产消费者使用，见
//  src/plugins/boot-gate.ts 头注的历史段。）

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context, Service } from '../src/cordis';
import { auditBoot } from '../src/plugins/boot-gate';

describe('boot-gate（S4 装载调度层审计）', () => {
  let root: Context;

  beforeEach(() => {
    root = new Context();
  });

  afterEach(async () => {
    await root.fiber.dispose();
  });

  it('a) 依赖缺失 → fiber PENDING 不报 error（装载层不拒载）', async () => {
    const fiber = root.plugin({
      name: 'pending-probe',
      inject: ['never-provided-service'],
      apply() {
        throw new Error('依赖缺失时 apply 不应被调用');
      },
    });
    await fiber; // await() 立即 resolve（PENDING 的惯性是 undefined）
    // fiber state = 0（PENDING——依赖永缺）
    expect(fiber.state).toBe(0);
  });

  it('b) 依赖后到 → fiber 自动 ACTIVE（cordis fiber 等待语义）', async () => {
    const fiber = root.plugin({
      name: 'late-dep-probe',
      inject: ['late-service'],
      apply(ctx: Context) {
        ctx.effect(() => () => {}, 'late-probe');
      },
    });
    // 此时 PENDING
    expect(fiber.state).toBe(0);
    // 依赖后到 → fiber 自动激活
    class LateService extends Service {
      constructor(ctx: Context) {
        super(ctx, 'late-service');
      }
    }
    new LateService(root);
    await fiber.await();
    expect(fiber.state).toBe(2); // ACTIVE
  });

  it('c) 依赖永不出现 → 审计 fail-loud 报缺名', async () => {
    root.plugin({
      name: 'doomed-probe',
      inject: ['never-service'],
      apply() {
        throw new Error('不应被调用');
      },
    });
    const audit = await auditBoot(root, 100);
    expect(audit.ok).toBe(false);
    expect(audit.failures.length).toBe(1);
    expect(audit.failures[0]).toContain('doomed-probe');
    expect(audit.failures[0]).toContain('state=0');
  });

  it('apply 抛错 → 审计失败且原始错误进失败清单（fail-loud 的输入）', async () => {
    root.plugin({
      name: 'broken-probe',
      apply() {
        throw new Error('apply boom');
      },
    });
    const audit = await auditBoot(root, 100);
    expect(audit.ok).toBe(false);
    expect(audit.failures[0]).toContain('broken-probe');
    expect(audit.failures[0]).toContain('apply boom');
  });

  it('全 ACTIVE 树 → 审计通过且失败清单为空', async () => {
    await root.plugin({
      name: 'healthy-a',
      apply(ctx: Context) {
        ctx.effect(() => () => {}, 'a');
      },
    });
    await root.plugin({
      name: 'healthy-b',
      apply(ctx: Context) {
        ctx.effect(() => () => {}, 'b');
      },
    });
    const audit = await auditBoot(root);
    expect(audit.ok).toBe(true);
    expect(audit.failures).toEqual([]);
  });
});
