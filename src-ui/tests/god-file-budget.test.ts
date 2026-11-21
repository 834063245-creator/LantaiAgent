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
// ⚠ 2026-11-15 实测账外：`src-tauri/src/utils/bg_jobs.rs` = 1466 行（>LIMIT 却未登记）。
// 它**不属于本批**（V2 立卷 UX 只动 src-ui），登记与否是另一个决策——此处仅留痕，
// 不改 DEBT（登记 = 一次显式决策，应由持有那批改动的作者选档并写理由）。
const EXTS = /\.(ts|tsx|css|rs)$/;

/** 逾期账：文件 → 行数**上限档**（2026-11-06 实测向上取整到 100）。**只减不增**。
 *  档内的日常改动不吵；跨档要长，必须在同一 commit 里改这个数字（= 一次有记录的决策，
 *  写一句为什么）；拆到 LIMIT 以下请删条目（销账制）。 */
//
// ⚠ 2026-11-15 全仓 rustfmt 首刷后整体重量：格式化把长行拆开，物理行数普涨 5%~30%
//   （实测：dataflow_engine 1059→2260、query_adapter 2454→3141、lsp_manager 2642→2850），
//   **代码内容一个字符没多**——字符数只涨了空白。这不是真实增长，所以不是「跨档要长」，
//   而是量具换了刻度：整批按同一口径重测一次档位，原档位语义（百行档、只减不增）不变。
//   同时新增 `engine/src/plugins/mod.rs`（1137 行）——它一直超 LIMIT 但此前没人发现，
//   格式化后仍超，按规矩补登记。
const DEBT: Record<string, number> = {
  'engine/src/adapter/query_adapter.rs': 3200, // 现 3140
  'engine/src/lsp_manager.rs': 2900, // 现 2849
  'engine/src/analysis/framework_routes/mod.rs': 2700, // 现 2619
  'src-ui/src/agent/agent.ts': 2600, // 现 2530（2026-11-19 压力基准批：锚核验接线 + 信封签字 + 诊断基准字段；此前已漂到 2504 未升档）
  'src-tauri/src/os_sandbox.rs': 2300, // 现 2267
  'engine/src/analysis/di_reflection/langs.rs': 2300, // 现 2263
  'engine/src/analysis/dataflow_engine.rs': 2300, // 现 2259
  // 2026-11-21 code 模式批（跨档决策）：程文「程序内调用」段要三面镜像
  // （块高 / 墨迹 / 渲染同源），高度与墨迹两笔落在这里 ⇒ 2169 → 2233。拆法是把
  // 程文整族测量搬到单独模块（codeBlockH），那是另一批的活；本批只登记换档。
  'src-ui/src/plugins/builtin/paper-shell/measure.ts': 2300, // 现 2233
  'src-ui/src/plugins/builtin/renderers/components.tsx': 2200, // 现 2130
  'src-tauri/src/cdp/actions.rs': 2200, // 现 2143
  'engine/src/tools/mod.rs': 2100, // 现 2099
  'engine/src/engine/mod.rs': 2100, // 现 2020
  'src-tauri/src/cdp/session.rs': 2000, // 现 1932
  /* 2026-11-19 夹签批升档 1800 → 1900：引用快照那一拍落在 sendMessage 里
   * （cardsSnapshot / 逐枚降级 / 写盘失败不发送，约 40 行）。**为什么不再往坞的
   * hook 里塞**：发送编排的真源就是本文件的 sendMessage（目标自动轮 / 命令驱动轮
   * 也走它），放视图层会让那两条路绕过引用快照——那是行为裂缝，不是体量问题。
   * 真要动结构（把快照拍抽成独立模块）单独立单，别为了省档位把判据切开。 */
  /* 2026-11-21 升档 1900 → 2000（现 1967）。跨这一档的是两笔**发送编排**的活，
   * 都不是能在别处落脚的东西：
   *   ① 4f5fc5bf 题签态命令分诊（+67）——`draftCommandVerdict` 的判据必须与
   *      sendMessage 同源；放视图层会让「斜杠面板点选」与「Ctrl+K 点选」这两条
   *      **不经过 sendMessage** 的路绕过分诊，那正是「命令打到别的卷」的病灶；
   *   ② 8817aafa goal 轮次计数（+15）——计数随日志事件实时刷新，读面就在本卷的
   *      状态投影里。
   * 真要动结构（sendMessage 的分诊段 + 夹签快照段抽成 app/chat/send-orchestration/*）
   * 单独立单；本条按 2026-11-19 那次的口径处理——不为了省档位把判据切开。 */
  'src-ui/src/app/chat/chat-core.ts': 2000, // 现 1967
  /* 2026-11-20 补登记（提笔收束批 ef9bf492 把它推到 1001，此前 966 在 LIMIT 之下）：
   * 只超线 1 行，但**登记的是现状不是许可**——下一次动这个文件优先把 Quill 拆出去
   * 销账，而不是继续抬档。 */
  'src-ui/src/plugins/builtin/paper-shell/PaperPanel.tsx': 1100, // 现 1001
  'engine/src/community/louvain.rs': 1700, // 现 1697
  'src-tauri/src/commands/process_cap.rs': 1700, // 现 1658
  'engine/src/graph/import_resolver.rs': 1600, // 现 1596
  'src-ui/src/plugins/builtin/canvas-nav/SessionSidebar.tsx': 1600, // 现 1549
  'src-tauri/src/uia/com.rs': 1600, // 现 1595
  'src-tauri/src/permissions/bash.rs': 1400, // 现 1365
  'engine/src/graph/resolver.rs': 1400, // 现 1380
  'src-tauri/src/commands/plugin_install.rs': 1400, // 现 1306
  'engine/src/main.rs': 1400, // 现 1317
  'src-tauri/src/plugin_assets.rs': 1400, // 现 1325
  'engine/src/stress.rs': 1400, // 现 1358
  // 2026-11-17 跨档（1300 → 1400）：流式「蓄水池」批把读到的字与显示进度分开
  // （useStreamDelta 的 received/shown 双游标 + rAF 泵），是**渲染期状态机**而非可拆纯函数——
  // 拆出去要跨模块共享 ref，反而让「进度只影响渲染、不动 payload.text」这条纪律失去单点。现 1364。
  'src-ui/src/plugins/builtin/paper-renderers/renderers.tsx': 1400, // 现 1364
  'src-ui/src/plugins/builtin/settings-domain/settings-panel.css': 1300, // 现 1238
  // 2026-11-17 技术债批 B 从 app/panels/dock-panels/provider-settings.css 迁入产物
  // （归属收口：使用它的全是产物组件）。旧账那条随之销账、新址按现行行数登记；
  // 2026-11-19 补了漏掉的 type-scale @import（与本批题签重画无关，顺手清债）。
  'src-ui/src/plugins/builtin/settings-domain/provider-console.css': 1400, // 现 1319
  'src-tauri/src/confined_fs.rs': 1300, // 现 1278
  'engine/src/analysis/explore.rs': 1300, // 现 1225
  // 架阁底座 B1（entity-shelf-plan §5.1）：card_* 五命令分派 + shape 登记跨了 1300 档
  // ⇒ 抬到 1400（实测 1312；跨档 = 一次显式决策，本行为该决策记录）。
  'src-tauri/src/rpc.rs': 1400, // 现 1312
  'src-tauri/src/agent_isolation.rs': 1300, // 现 1223
  'engine/src/plugins/mod.rs': 1200, // 现 1137（2026-11-15 补登记：一直超 LIMIT，此前账外）
  // 架阁底座 B1：卡片库 5 条契约 + 5 条 result schema 跨了 1200 档 ⇒ 抬到 1300（实测 1219）。
  'src-ui/src/rpc-contract.ts': 1300, // 现 1219
  'src-ui/src/workspace.ts': 1200, // 现 1164
  'src-ui/src/paper/tool-present.ts': 1200, // 现 1104
  'src-tauri/src/permissions/mod.rs': 1200, // 现 1120
  'src-tauri/src/cdp/e2e.rs': 1200, // 现 1188
  /* 2026-11-19 用户定调：档位直接抬到 2500（跨两档，不是按 1200 逐档追）。
   * 理由 = 这个文件还在长（motion 第二批 0142f7e7 长到 1125），而侧栏样式是**一张
   * 连续的特异性升序表**（biome `noDescendingSpecificity` 要求整段整段落），按百行档
   * 每长几十行就来回一次「拆 or 改数字」，拆出来的只是把同一张表切段再互相 import——
   * 结构不会更好，只会更难查某条规则排在哪。一次留足空间，等真要动结构再按单据拆。 */
  'src-ui/src/plugins/builtin/canvas-nav/session-sidebar.css': 2500, // 现 1125
  'src-ui/src/plugins/builtin/settings-domain/SettingsPanel.tsx': 1100, // 现 1084
  'src-ui/src/plugins/builtin/sessions-home/home.css': 1100, // 现 1063
  /* 2026-11-21 升档 1100 → 1200（现 1112）。跨档那 56 行全在 4f5fc5bf：插件宿主桥补
   * `agent`（spawn / list）与 `panels`（toggle / open / close / isOpen）两个面。
   * **为什么长在 loader 里**：宿主桥 `installPluginHostBridge` / `createPluginHost`
   * 本来就是本文件的职责（外部插件拿到的 `__lantai_plugin_host__` 只有这一个构造点）；
   * 把两个面拆出去只是把同一张桥表切段再拼回来。真要动结构（宿主桥独立成
   * `plugins/host-bridge.ts`，连带 faceDeps 对拍与 install 时序一起搬）单独立单。 */
  'src-ui/src/plugins/loader.ts': 1200, // 现 1112
  'src-ui/src/agent/runtime/runtime.ts': 1100, // 现 1057
  'src-ui/src/plugins/builtin/compaction/agent-compaction.ts': 1100, // 现 1016
  /* 2026-11-17 交互原语批 A 补登记：宿主面注册表 + 指纹（faceDeps 单一真源）。
   * 它按定义是**一张平表**——拆成多个文件只是把同一张表切段、再互相 import 拼回来，
   * 结构不会更好，只会更难查「某个键在不在面内」。本批新增 useOutsideClose 让它
   * 越过 1000 线；下一次真该动它时按单据（faceDeps / verifier / fingerprint）拆。 */
  'src-ui/src/plugins/builtin/host-modules.ts': 1100, // 现 1001
  'src-tauri/src/credential.rs': 1100, // 现 1076
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
