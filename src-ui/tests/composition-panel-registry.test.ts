import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANEL_DEFS } from '../src/app/panels/panel-def';
import { useDockStore } from '../src/state/dock-store';

// ── S1-5：DockPanelId union → string + panel-def 装载期运行时校验 ──
// 三条守护：
//   1. panel-def 清单自检（重复 id / 缺组件在装载期 throw——能 import 即通过）；
//   2. dock-store open 面向 string 开集（union 退役后的兼容面）；
//   3. main.ts 的 panel.* 命令 id 不变对拍（静态源码断言，对齐仓库 T0 模式）。

const SRC = join(__dirname, '..', 'src');

describe('composition 面板注册（S1-5 string 开集 + 装载期校验）', () => {
  it('PANEL_DEFS 装载期校验通过：id 唯一 + 组件完备（import 不炸即自检通过）', () => {
    const ids = PANEL_DEFS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of PANEL_DEFS) {
      expect(def.component).toBeTruthy();
    }
    // 内置六面齐全（S1-5 迁移前后清单不变）。paper 已迁组合层贡献
    // （V3b 壳装配：paper/paper-plugin.ts 经 PanelsService 注册——
    // 见 tests/paper-v3b.test.ts 的合流对拍）。
    expect(ids).toEqual(['check', 'constraints', 'dataflow', 'settings', 'agents', 'tasks']);
  });

  it('dock-store open 面向 string 开集：未注册 key 的写入/读取不抛（校验在清单侧）', () => {
    const dock = useDockStore.getState();
    // 内置 id 正常路径
    dock.openPanel('check');
    expect(useDockStore.getState().open.check).toBe(true);
    dock.closePanel('check');
    expect(useDockStore.getState().open.check).toBe(false);
    // string 开集：任意 key 可写（装载期校验守清单，调用点不校验）
    expect(() => dock.togglePanel('plugin-panel-x')).not.toThrow();
    useDockStore.getState().openPanel('plugin-panel-x');
    expect(useDockStore.getState().open['plugin-panel-x']).toBe(true);
    // 清理（不污染其他测试）
    useDockStore.setState({ open: { ...useDockStore.getState().open, 'plugin-panel-x': undefined } });
  });

  it('panel.* 命令 id 不变对拍：壳行 actions 四个面板命令 id 与绑定的 dock id 逐字保留', () => {
    // S2-3 起真源在壳行 10（设计件 §2.6 行 10 迁移；不变式本身不变）
    const actionsSrc = readFileSync(join(SRC, 'shell', 'rows', 'actions.ts'), 'utf8');
    for (const id of ['panel.check', 'panel.constraints', 'panel.dataflow', 'panel.agents']) {
      expect(actionsSrc).toContain(`id: '${id}',`);
    }
    // 命令 run 体绑定到同名字面量 dock id（id 与动作一致，防改 id 漏改绑定）
    expect(actionsSrc).toContain("togglePanel('check')");
    expect(actionsSrc).toContain("togglePanel('constraints')");
    expect(actionsSrc).toContain("togglePanel('dataflow')");
    expect(actionsSrc).toContain("togglePanel('agents')");
  });
});
