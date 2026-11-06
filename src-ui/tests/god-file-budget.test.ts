// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 上帝文件体量门禁（2026-11-06 立规；施工单 docs/plans/god-file-governance.md）
//
// 病灶：体量纪律一直只管「文件集」（ui/ 只减不增 = 13 个文件不少一个），没有一处管
// 「单文件长到多大」。于是 chat-session.ts 从 1099 行长到 2729 行无人报警（一年 97 次
// 提交，还在冻结名单上），PaperPanel.css 两个月 +91%；两次自发拆分（agent.ts 9/15、
// PaperPanel.tsx 9/18）六周内又长回去——**没有封顶的拆分只是一次性动作**。
//
// 口径（三条，刻意与既有先例对齐）：
//   ① 物理行数（末尾换行不算一行），与 plugin-home-ledger.test.ts 的 physicalLines 同尺；
//   ② 未登记文件不得超过 LIMIT（新文件长成上帝文件 = 红：先拆，或先登记）；
//   ③ 已登记文件只减不增（ratchet）——但登记值是**上限档**（实测向上取整到 100），
//      不是当前行数：档内的小改动（+几十行）不吵，跨档 = 一次显式决策。
//      2026-11-06 用户定调「DEBT 表可以调一下」：原版按当前行数逐行卡死，日常改一行
//      就红，噪音大于信号；改为百行档位后，只有「这个文件又长了一大截」才拦。
//
// ⚠️ 为什么**不做目录总量水线**：2026-09-24 立过又撤（见 privileged-zone-freeze.test.ts
// 头注）——本仓多窗口并行施工，目录总量上限会把别人的正当改动判红。单文件 ratchet 的
// 爆炸半径小得多：红了就是这一个文件，改法是「拆它」或「改这一行数字」。
//
// 销账制：文件降到 LIMIT 以下必须从 DEBT 表删掉（留着 = 红），账不腐。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 src-ui/tests/ 下）。 */
const REPO = join(HERE, '..', '..');

/** 未登记文件的行数上限。 */
const LIMIT = 1000;

/** 登记值的取整档宽：ceiling = 实测向上取整到 100。 */
const BAND = 100;

/** 扫描面：前端 / 引擎 / 壳（三棵 src 树；不含 tests 与生成物）。 */
const SCAN_ROOTS = ['src-ui/src', 'engine/src', 'src-tauri/src'] as const;
const EXTS = /\.(ts|tsx|css|rs)$/;

/** 逾期账：文件 → 行数**上限档**（2026-11-06 实测向上取整到 100）。**只减不增**。
 *  档内的日常改动不吵；跨档要长，必须在同一 commit 里改这个数字（= 一次有记录的决策，
 *  写一句为什么）；拆到 LIMIT 以下请删条目（销账制）。 */
const DEBT: Record<string, number> = {
  'engine/src/lsp_manager.rs': 2700, // 现 2641
  'src-ui/src/agent/agent.ts': 2500, // 现 2486
  'engine/src/adapter/query_adapter.rs': 2500, // 现 2447
  'engine/src/analysis/framework_routes/mod.rs': 2300, // 现 2211
  'src-tauri/src/os_sandbox.rs': 2200, // 现 2147
  'src-ui/src/plugins/builtin/paper-shell/measure.ts': 2200, // 现 2130
  'src-ui/src/plugins/builtin/renderers/components.tsx': 2200, // 现 2130
  'src-ui/src/app/chat/chat-core.ts': 2200, // 现 2118
  'src-tauri/src/cdp/actions.rs': 2200, // 现 2115
  'engine/src/tools/mod.rs': 2000, // 现 1987
  'src-tauri/src/cdp/session.rs': 2000, // 现 1943
  'engine/src/engine/mod.rs': 1900, // 现 1859
  'engine/src/analysis/di_reflection/langs.rs': 1700, // 现 1660
  'src-ui/src/plugins/builtin/compose-dock/ComposerDock.tsx': 1700, // 现 1622
  'engine/src/graph/import_resolver.rs': 1600, // 现 1555
  'src-ui/src/plugins/builtin/canvas-nav/SessionSidebar.tsx': 1600, // 现 1553
  'engine/src/community/louvain.rs': 1600, // 现 1546
  'src-ui/src/app/panels/dock-panels/provider-settings.css': 1500, // 现 1420
  'src-tauri/src/commands/process_cap.rs': 1500, // 现 1415
  'src-tauri/src/uia/com.rs': 1400, // 现 1340
  'src-tauri/src/permissions/bash.rs': 1400, // 现 1314
  'src-ui/src/plugins/builtin/paper-renderers/renderers.tsx': 1300, // 现 1299
  'engine/src/graph/resolver.rs': 1300, // 现 1252
  'src-ui/src/plugins/builtin/settings-domain/settings-panel.css': 1300, // 现 1238
  'src-tauri/src/confined_fs.rs': 1200, // 现 1192
  'src-ui/src/rpc-contract.ts': 1200, // 现 1176
  'src-tauri/src/commands/plugin_install.rs': 1200, // 现 1161
  'engine/src/analysis/explore.rs': 1200, // 现 1150
  'src-ui/src/workspace.ts': 1200, // 现 1135
  'src-tauri/src/rpc.rs': 1200, // 现 1131
  'engine/src/main.rs': 1200, // 现 1123
  'src-ui/src/paper/tool-present.ts': 1200, // 现 1104
  'src-tauri/src/plugin_assets.rs': 1200, // 现 1104
  'engine/src/stress.rs': 1200, // 现 1101
  'src-ui/src/plugins/builtin/canvas-nav/session-sidebar.css': 1100, // 现 1089
  'src-ui/src/plugins/builtin/settings-domain/SettingsPanel.tsx': 1100, // 现 1084
  'src-tauri/src/permissions/mod.rs': 1100, // 现 1079
  'src-ui/src/plugins/builtin/sessions-home/home.css': 1100, // 现 1063
  'engine/src/analysis/dataflow_engine.rs': 1100, // 现 1058
  'src-ui/src/plugins/loader.ts': 1100, // 现 1056
  'src-ui/src/agent/runtime/runtime.ts': 1100, // 现 1036
  'src-tauri/src/cdp/e2e.rs': 1100, // 现 1019
  'src-ui/src/plugins/builtin/compaction/agent-compaction.ts': 1100, // 现 1016
  'src-tauri/src/agent_isolation.rs': 1100, // 现 1014
  'src-tauri/src/credential.rs': 1100, // 现 1001
};

function physicalLines(p: string): number {
  const text = readFileSync(p, 'utf8');
  if (text === '') return 0;
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function scanFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'dist-plugins', 'target'].includes(e.name)) continue;
        walk(p);
      } else if (EXTS.test(e.name)) {
        out.push(relative(REPO, p).split('\\').join('/'));
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO, root));
  return out;
}

describe('上帝文件体量门禁（docs/plans/god-file-governance.md）', () => {
  const files = scanFiles();

  it('扫描面非空（守卫先证明自己看到了代码）', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('登记档位合法（都是 ' + BAND + ' 的整数倍，且不低于 LIMIT）', () => {
    const bad = Object.entries(DEBT)
      .filter(([, ceiling]) => ceiling % BAND !== 0 || ceiling <= LIMIT)
      .map(([f, c]) => f + ' = ' + c);
    expect(bad, 'DEBT 值必须是 ' + BAND + ' 的整数倍（档位口径，见头注 ③）：').toEqual([]);
  });

  it('未登记文件 ≤ LIMIT 行', () => {
    const violations = files
      .filter((f) => !(f in DEBT))
      .map((f) => ({ f, n: physicalLines(join(REPO, f)) }))
      .filter((x) => x.n > LIMIT);
    expect(
      violations.map((v) => v.f + ' = ' + v.n + ' 行'),
      '出现未登记的上帝文件（> ' + LIMIT + ' 行）——先拆，或登记进 DEBT 并说明理由：',
    ).toEqual([]);
  });

  it('已登记文件不得跨档增长（ratchet）', () => {
    const violations: string[] = [];
    for (const [f, ceiling] of Object.entries(DEBT)) {
      const p = join(REPO, f);
      if (!existsSync(p)) {
        violations.push(f + '：已不存在（请从 DEBT 删条目，销账制）');
        continue;
      }
      const n = physicalLines(p);
      if (n > ceiling) {
        const nextBand = Math.ceil(n / BAND) * BAND;
        violations.push(
          f + '：' + n + ' 行 > 上限档 ' + ceiling + '（要长就得把档位改到 ' + nextBand + '，并写一句为什么）',
        );
      }
      if (n <= LIMIT) violations.push(f + '：已降到 ' + n + ' 行（≤ ' + LIMIT + '）——请从 DEBT 销账');
    }
    expect(violations, '登记账漂移（跨档 = 一次显式决策；拆小了 = 销账）：').toEqual([]);
  });
});
