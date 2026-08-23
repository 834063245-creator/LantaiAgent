import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANEL_DEFS } from '../src/app/panels/panel-def';
import { useDockStore } from '../src/state/dock-store';

// ── S1-5：DockPanelId union → string + panel-def 装载期运行时校验 ──
// 三条守护：
//   1. panel-def 清单自检（重复 id / 缺组件在装载期 throw——能 import 即通过）；
//   2. dock-store open 面向 string 开集（union 退役后的兼容面）；
//   3. 壳行 actions 的面板命令 id 与绑定的 dock id 不变对拍（静态源码断言，
//      对齐仓库 T0 模式）。
// V5 拆除（2026-08-22）：旧观测台面板族退役，常量面只剩 settings；
// paper 面板是组合层贡献（paper/paper-plugin.ts）。
// S3（2026-08-22）：settings 亦迁贡献（plugins/settings-plugin.ts），
// 常量面清空——面板命令迁址对拍移入 tests/s3-settings-domain.test.ts。

const SRC = join(__dirname, '..', 'src');

describe('composition 面板注册（S1-5 string 开集 + 装载期校验）', () => {
  it('PANEL_DEFS 装载期校验通过：id 唯一 + 组件完备（import 不炸即自检通过）', () => {
    const ids = PANEL_DEFS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of PANEL_DEFS) {
      expect(def.component).toBeTruthy();
    }
    // S3（2026-08-22）：常量面清空——settings 迁 plugins/settings-plugin.ts
    // 贡献（paper 先例 V3b）。合流对拍见 tests/s3-settings-domain.test.ts。
    expect(ids).toEqual([]);
  });

  it('dock-store open 面向 string 开集：未注册 key 的写入/读取不抛（校验在清单侧）', () => {
    const dock = useDockStore.getState();
    // 内置 id 正常路径
    dock.openPanel('settings');
    expect(useDockStore.getState().open.settings).toBe(true);
    dock.closePanel('settings');
    expect(useDockStore.getState().open.settings).toBe(false);
    // string 开集：任意 key 可写（装载期校验守清单，调用点不校验）
    expect(() => dock.togglePanel('plugin-panel-x')).not.toThrow();
    useDockStore.getState().openPanel('plugin-panel-x');
    expect(useDockStore.getState().open['plugin-panel-x']).toBe(true);
    // 清理（不污染其他测试——删除键而非置 undefined，Object.keys 才看不见）
    const { 'plugin-panel-x': _drop, ...rest } = useDockStore.getState().open;
    useDockStore.setState({ open: rest });
  });

  it('C14：open 初始表收缩为两个活键（settings + paper）——旧观测台五键退役', () => {
    const keys = Object.keys(useDockStore.getState().open);
    expect(keys.sort()).toEqual(['paper', 'settings']);
  });

  it('C14：setCheckResult 喂状态注入缓存 + 不再动 open（check 面板已退役）', async () => {
    const { getCheckStatusCached } = await import('../src/agent/state-inject');
    const before = useDockStore.getState().open;
    const r = {
      passed: false,
      timestamp: '2026-08-22T00:00:00.000Z',
      changed_files: [],
      total_changed_files: 0,
      l5_violations: [{ message: 'v5' }],
      l4_violations: [],
      l3_violations: [{ message: 'v3' }],
      l2_violations: [],
      passed_checks: [],
      blast_radius: 0,
      cross_community_edges: 0,
      new_cycles: 0,
      new_thread_conflicts: 0,
      api_signature_changes: 0,
    };
    useDockStore.getState().setCheckResult(r as never);
    // 结果入库
    expect(useDockStore.getState().checkResult).toBe(r);
    // open 未被触碰（失败简报不再自动展开死面板）
    expect(useDockStore.getState().open).toBe(before);
    // Agent 状态注入缓存被喂过（violationCount = 1+1 = 2）
    expect(getCheckStatusCached()?.violationCount).toBe(2);
  });

  it('面板命令 id 不变对拍：壳行留守动作 = open / esc-layer（面板切换动作已 S3 行化）', () => {
    // S2-3 起真源在壳行 actions（设计件 §2.6；不变式本身不变）。
    // S3（2026-08-22）：toggle-settings → settings-plugin 的 settings/toggle
    // 贡献；toggle-paper → paper-plugin 的 paper/toggle 贡献——迁址后的
    // 常量面对拍（含贡献 id 桥接断言）见 tests/s3-settings-domain.test.ts。
    const actionsSrc = readFileSync(join(SRC, 'shell', 'rows', 'actions.ts'), 'utf8');
    for (const id of ['open', 'esc-layer']) {
      expect(actionsSrc).toContain(`id: '${id}',`);
    }
    // 面板动作不再在壳行注册（已行化迁出）
    expect(actionsSrc).not.toContain("togglePanel('paper')");
    expect(actionsSrc).not.toContain("togglePanel('settings')");
    // 别名桥接真源存在（快捷键字面量 → 域贡献 id）
    const actionsModuleSrc = readFileSync(join(SRC, 'app', 'actions.ts'), 'utf8');
    expect(actionsModuleSrc).toContain("'toggle-settings': 'settings/toggle'");
    expect(actionsModuleSrc).toContain("'toggle-paper': 'paper/toggle'");
  });
});
