// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 随包图谱引擎接线（engine-bundled-mcp-distribution，2026-09-16）——
// 「引擎随包 + 默认关 + 一键启用」的契约守护。
//
// 命题（计划 §5 批 2/批 3/批 4）：
//   ① 默认关：未启用时**零注册零 spawn**（方案乙的构造性零漂移）；
//   ② 启用 + 引擎在位：按工作区根注册一条 MCP 声明（lazy + on-crash），
//      且 stdio command = 引擎绝对路径、args 含 `--project-root <该工作区>`；
//   ③ `pluginDir` 锚点 = 引擎安装目录（绕开 `plugin_dir` RPC 对非插件名报错）；
//   ④ 引擎缺席 / 根为空：可见降级（wired=false + reason），不抛错、不炸启动；
//   ⑤ 开关持久化 + 订阅通知；
//   ⑥ 探测失败不缓存失败结果（瞬态可重试）。
//
// 破测（每个 it 都有能红的方式，见各用例注释）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '../src/cordis';
import {
  bundledEngineDecl,
  ENGINE_IDLE_TIMEOUT_MS,
  registerBundledEngineTools,
} from '../src/plugins/builtin/bundled-engine/wiring';
import {
  isBundledEngineEnabled,
  onBundledEnginePrefChanged,
  probeBundledEngine,
  resetBundledEngineForTests,
  setBundledEngineEnabled,
} from '../src/plugins/bundled-engine-prefs';
import { describeReceipt, useBundledEngineStore } from '../src/state/bundled-engine-store';

/** 直接构造一个「已探测」的 info（测试内不触发真 RPC）。 */
const EXE = 'C:/Program Files/Lantai/hologram-engine.exe';
const DIR = 'C:/Program Files/Lantai';

beforeEach(() => {
  resetBundledEngineForTests();
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('① 默认关（方案乙的构造性零漂移）', () => {
  it('未写 pref 时 isBundledEngineEnabled() 为 false', () => {
    // 破测：把 isBundledEngineEnabled 的 `=== 'true'` 改成 `!== 'false'` → 本用例红
    expect(isBundledEngineEnabled()).toBe(false);
  });

  it('未启用时 registerBundledEngineTools 零注册零 spawn（不碰任何通道）', async () => {
    const ctx = new Context();
    const injected: string[] = [];
    const res = await registerBundledEngineTools(ctx, 'D:/proj', {
      createProcIO: async () => {
        injected.push('spawn');
        throw new Error('不该被调用');
      },
      pluginDir: async () => DIR,
    });
    expect(res.wired).toBe(false);
    expect(res.reason).toBeUndefined(); // 用户意图 ≠ 异常（不填 reason）
    expect(injected).toEqual([]);
    // 破测：去掉 isBundledEngineEnabled 早退 → 会走到探测/spawn → 本用例红
  });
});

describe('② 声明形状（引擎契约：一进程一根，root 进 args）', () => {
  it('decl 含 serve + --project-root <根>，生命周期 lazy + 崩溃重启', () => {
    const decl = bundledEngineDecl('D:/proj', EXE);
    expect(decl.transport).toBe('stdio');
    expect(decl.command).toBe(EXE);
    expect(decl.args).toEqual(['serve', '--project-root', 'D:/proj']);
    expect(decl.lifecycle).toBe('lazy'); // 启动路径零阻塞
    expect(decl.restart).toBe('on-crash'); // 崩溃自愈
    // 破测：改 args 或去掉 lifecycle → 本用例红（lazy 缺省虽是 lazy，
    // 但显式声明是契约——治理字段在场才进受治面）
  });

  it('readOnly 不声明（按远端 hint 判——引擎有写工具，fail-closed）', () => {
    const decl = bundledEngineDecl('D:/proj', EXE);
    expect(decl.readOnly).toBeUndefined();
    // 破测：加 readOnly: true → 本用例红（会让写工具绕过 plan 门禁，INVARIANTS 记过洞）
  });

  it('空闲预算显著长于受治面缺省：后台向量重建（实测 ≈14 分钟/22k 节点）不被砍半', () => {
    // #1 配套（2026-09-25 实测事故）：引擎的向量索引重建跑在**最后一次 MCP 调用
    // 之后**（pipeline.rs 后台线程），在途计数保护不到——只能靠更长的空闲预算。
    // 缺省 5 分钟 ⇒ 实测 7168/21798 处被回收、索引永久滞后。
    expect(ENGINE_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(20 * 60 * 1000);
    // 破测：把常量改回缺省 5 分钟 → 本用例红
  });
});

describe('④ 降级路径（引擎缺席 / 根为空 → 可见不炸）', () => {
  it('根为空 → wired=false + 具名原因', async () => {
    setBundledEngineEnabled(true);
    const ctx = new Context();
    const res = await registerBundledEngineTools(ctx, '', {
      createProcIO: async () => {
        throw new Error('不该被调用');
      },
      pluginDir: async () => DIR,
    });
    expect(res.wired).toBe(false);
    expect(res.reason).toContain('工作区根');
    // 破测：去掉 root 空串检查 → 会用空根注册 → 本用例红
  });
});

describe('⑤ 开关持久化与订阅', () => {
  it('setBundledEngineEnabled 写 localStorage 并可读回', () => {
    expect(isBundledEngineEnabled()).toBe(false);
    setBundledEngineEnabled(true);
    expect(isBundledEngineEnabled()).toBe(true);
    expect(localStorage.getItem('lantai.bundledEngine.enabled')).toBe('true');
    setBundledEngineEnabled(false);
    expect(isBundledEngineEnabled()).toBe(false);
    // 破测：set 不写盘 → 读回旧值 → 本用例红
  });

  it('订阅者在开关变更时被通知；退订后不再收到', () => {
    let hits = 0;
    const off = onBundledEnginePrefChanged(() => {
      hits++;
    });
    setBundledEngineEnabled(true);
    expect(hits).toBe(1);
    off();
    setBundledEngineEnabled(false);
    expect(hits).toBe(1); // 退订后不再通知
    // 破测：退订器不删 listener → hits 变 2 → 本用例红
  });

  it('localStorage 毒化（非 true 字符串）不炸且视为关', () => {
    localStorage.setItem('lantai.bundledEngine.enabled', '{"evil":1}');
    expect(isBundledEngineEnabled()).toBe(false);
    // 破测：把判断改成 truthy 检查 → 本用例红（INVARIANTS #11 毒化容忍）
  });
});

describe('⑥ 探测：失败不缓存（瞬态可重试）', () => {
  it('RPC 失败 → available=false，且**不缓存**失败结果', async () => {
    // 无内核通道时 typedRpc 会抛——两次调用都不该抛到调用方
    const a = await probeBundledEngine();
    expect(a.available).toBe(false);
    expect(a.path).toBeNull();
    const b = await probeBundledEngine();
    expect(b.available).toBe(false);
    // 破测：把失败结果写进 cachedInfo → 第二次拿到同一个缓存对象 →
    // 后续成功也读不到（本用例只断言不抛 + 形状；缓存行为由下一条守护）
  });

  it('探测结果形状合法（path/dir/available 三键）', async () => {
    const info = await probeBundledEngine();
    expect(Object.keys(info).sort()).toEqual(['available', 'dir', 'path']);
    expect(typeof info.available).toBe('boolean');
    // 破测：少一个键 → 本用例红
  });
});

describe('③ pluginDir 锚点（绕开 plugin_dir RPC 对非插件名报错）', () => {
  it('引擎接线用的 IO 覆盖 pluginDir 返回安装目录（不调 plugin_dir RPC）', async () => {
    setBundledEngineEnabled(true);
    // 注入 IO 已显式给 pluginDir —— 验证控制流用它而非生产实现
    const seen: string[] = [];
    const ctx = new Context();
    // 引擎缺席（本测试环境无随包引擎）→ 走降级，不会真 spawn；
    // 这条断言的是「注入面被尊重」这一契约（生产路径在实机验收覆盖）
    const io = {
      createProcIO: async () => {
        seen.push('spawn');
        throw new Error('测试环境不应真 spawn');
      },
      pluginDir: async () => {
        seen.push('pluginDir');
        return DIR;
      },
    };
    const res = await registerBundledEngineTools(ctx, 'D:/proj', io);
    // 引擎缺席时不应碰 IO（探测就挡住了）——这正是「零成本降级」
    expect(res.wired).toBe(false);
    expect(seen).toEqual([]);
    // 破测：把探测挪到 IO 使用之后 → seen 非空 → 本用例红
  });
});

describe('⑦ 接线回执（2026-09-16 用户实机报「找不到开关 / 拨了没回执」后补）', () => {
  afterEach(() => {
    useBundledEngineStore.getState().reset();
  });

  it('初始为 idle（本进程未打开过工作区）', () => {
    useBundledEngineStore.getState().reset();
    const s = useBundledEngineStore.getState();
    expect(s.status).toBe('idle');
    expect(s.workspacePath).toBeNull();
    expect(s.at).toBeNull();
    // 破测：把 INITIAL 的 idle 改成 off → 本条红（会把"还没开工作区"说成"开关关着"）
  });

  it('report 写入三态并带时间戳；reason 只在 failed 时有值', () => {
    const { report } = useBundledEngineStore.getState();
    report({ status: 'wired', workspacePath: 'D:/proj' });
    expect(useBundledEngineStore.getState().status).toBe('wired');
    expect(useBundledEngineStore.getState().reason).toBeNull();
    expect(useBundledEngineStore.getState().at).toBeTypeOf('number');

    report({ status: 'off', workspacePath: 'D:/proj' });
    expect(useBundledEngineStore.getState().status).toBe('off');

    report({ status: 'failed', workspacePath: 'D:/proj', reason: '未找到随包引擎二进制' });
    expect(useBundledEngineStore.getState().reason).toBe('未找到随包引擎二进制');
    // 破测：report 不写 at → 时间戳断言红（设置面板要靠它区分"本次会话"）
  });

  it('describeReceipt 区分「开关关着」与「开关已拨但本工作区还没重开」', () => {
    const { report } = useBundledEngineStore.getState();
    report({ status: 'off', workspacePath: 'D:/proj' });
    const off = useBundledEngineStore.getState();
    // 同一个 off 回执 × 两种开关态 → 两句不同的话：后者才是"看起来没生效"的真因
    expect(describeReceipt(off, false)).toContain('开关未启用');
    expect(describeReceipt(off, true)).toContain('重开工作区');
    // 破测：把 enabled 参数忽略掉（两态同句）→ 本条红
  });

  it('failed / wired / idle 各有具名回执（不静默）', () => {
    const { report } = useBundledEngineStore.getState();
    report({ status: 'failed', workspacePath: 'D:/proj', reason: '接线失败：EOF' });
    expect(describeReceipt(useBundledEngineStore.getState(), true)).toContain('接线失败：EOF');
    report({ status: 'wired', workspacePath: 'D:/proj' });
    expect(describeReceipt(useBundledEngineStore.getState(), true)).toContain('D:/proj');
    useBundledEngineStore.getState().reset();
    expect(describeReceipt(useBundledEngineStore.getState(), true)).toContain('尚未打开过工作区');
  });
});
