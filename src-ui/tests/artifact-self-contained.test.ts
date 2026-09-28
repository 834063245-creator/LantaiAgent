// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 产物自包含：**源码里不许有相对动态 import**（2026-09-28 真机事故立法）。
//
// 病灶（真机形态，用户报「本地模型填了占位符 Key 也连不上」）：
// `settings-domain/provider-data.ts` 用 `await import('../../../provider/credentials')`
// 取凭据缓存失效口，而产物构建的宿主桥重定向**只认静态 `./host`**
// （build-builtin-plugins.mjs 的 onResolve filter）⇒ 该相对动态 import 落回普通
// 解析、被 esbuild **整份内联成产物私有副本**（自带模块级状态 `_keyCache`）⇒
// 写穿失效打在副本上，内核那份（`provider/live.ts` 每请求现读的）纹丝不动：
// 该提供方名此前解析出的空值被负缓存钉住，**整个进程生命周期**都读不回新 Key
// （设置页显示已保存、凭据库确实有值，请求却恒报「未配置 API Key」；重启才恢复）。
// 同族：`await import('../../../rpc-contract')` —— 副本没有内核的 rpc 插桩，
// 收到的 ui.log 因此答不出「Key 到底写没写」（docs/plans/log-observability-plan.md）。
//
// 本文件把该判据钉在源码面（构建期还有一道同源检查：scripts/build-builtin-plugins.mjs
// 的 scanArtifactSources —— 判据真源 = scripts/lib/artifact-dynamic-imports.mjs，
// 两处共用一份，免得「脚本拦了、测试没拦」）。
//
// 正确姿势：静态 `import … from './host'`（宿主桥出口）。缺出口时按纪律补三处：
// host.ts + host.aliased.ts + host-modules.ts faceDeps（见 docs/plugins/README.md）。
//
// 2026-09-28 账本合一（W0，docs/plans/artifact-inlining-payoff-plan.md）：模块图级
// 豁免账**单一声明面 = 名册 `shared`**（原先另有一本平行快照账
// `scripts/lib/artifact-input-baseline.json`，属负债，已删）。本文件的后半段把那本
// 账的**形状**钉住：全局件恰三个、条目路径形态可解析、带模块级状态者不得登记。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findRelativeDynamicImports, scanArtifactSources } from '../../scripts/lib/artifact-dynamic-imports.mjs';
import { BUILTIN_ROSTER } from '../src/plugins/builtin-roster';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(HERE, '..');
const REPO_ROOT = join(UI_ROOT, '..');
const BUILTIN_SRC = join(UI_ROOT, 'src', 'plugins', 'builtin');
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-builtin-plugins.mjs');
/** 带模块级状态的内核模块欠账清单（构建期按此点名）。 */
const STATEFUL_LEDGER = join(REPO_ROOT, 'scripts', 'lib', 'stateful-kernel-modules.json');
/** 构建全局件——不属于任何单一产物，故不进名册 `shared`（构建脚本里显式列三个）。 */
const GLOBAL_INPUTS = [
  'src-ui/src/plugins/builtin/contribution-helpers.ts',
  'src-ui/src/plugins/builtin/face-css.ts',
  'src-ui/src/plugins/builtin/react-bridge.cjs',
];

describe('提取器：值位置的相对动态 import', () => {
  it('命中 await import(相对路径)（真机病灶形态）', () => {
    const hits = findRelativeDynamicImports(
      "const { invalidateCredentialCache } = await import('../../../provider/credentials');",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.spec).toBe('../../../provider/credentials');
  });

  it('不命中类型位置的 typeof import（host.aliased 的既定对拍形态）', () => {
    expect(
      findRelativeDynamicImports("const impl = host.mods.faceDeps as unknown as typeof import('./host');"),
    ).toEqual([]);
  });

  it('不命中注释里的 import（本仓库注释大量引用它作说明）', () => {
    const src = `
      // 正确姿势：静态 import … from './host'（勿写 await import('./host')）
      /* 块注释同样豁免：await import('../../../rpc-contract') 是反例 */
      const x = 1;
    `;
    expect(findRelativeDynamicImports(src)).toEqual([]);
  });

  it('不命中类型查询 import（`export type X = import(./host).X`——实测误报形态）', () => {
    expect(findRelativeDynamicImports("export type MessageBus = import('./host').MessageBus;")).toEqual([]);
  });

  it('不命中裸动态 import（那条由构建脚本的产物级检查兜）', () => {
    expect(findRelativeDynamicImports("const m = await import('some-pkg');")).toEqual([]);
  });

  it('行号与原文件对齐（块注释按字符换空白，不吞行）', () => {
    const src = "/* 跨行\n注释 */\nconst a = 1;\nawait import('./x');\n";
    expect(findRelativeDynamicImports(src)).toEqual([{ line: 4, spec: './x' }]);
  });
});

describe('产物自包含：全部出厂产物源码零相对动态 import', () => {
  it('名册逐目：命中即红（相对动态 import 会把内核模块内联成私有副本）', () => {
    const hits: string[] = [];
    for (const entry of BUILTIN_ROSTER) {
      for (const hit of scanArtifactSources(join(BUILTIN_SRC, entry.dir))) {
        hits.push(`${entry.dir} → ${relative(UI_ROOT, hit.file)}:${hit.line}  import('${hit.spec}')`);
      }
    }
    expect(
      hits,
      `产物源码出现相对动态 import（宿主桥失效、内核模块被内联成副本——模块级状态分家）：\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('构建脚本仍挂着同源检查（删掉它 = 这条纪律只剩测试兜，产物照样能发出去）', () => {
    const cfg = readFileSync(BUILD_SCRIPT, 'utf8');
    expect(cfg, '构建脚本缺 scanArtifactSources 检查').toContain('scanArtifactSources');
    expect(cfg, '构建脚本必须 import 判据真源').toContain("from './lib/artifact-dynamic-imports.mjs'");
    // 模块图级那道（2026-09-28 同批）：输入集比对 + 豁免账，删掉即「新内联无人拦」
    expect(cfg, '构建脚本缺逐插件输入集比对（allowedInputsFor）').toContain('allowedInputsFor');
    // 账本合一（W0）：豁免账只许有一本，且必须读名册 `shared`
    expect(cfg, '构建脚本的豁免账必须读名册 `shared`').toContain('e.shared ?? []');
    expect(
      existsSync(join(REPO_ROOT, 'scripts', 'lib', 'artifact-input-baseline.json')),
      '平行账 artifact-input-baseline.json 已随 W0 账本合删除（单一声明面 = 名册 shared）——别再建第二本',
    ).toBe(false);
  });
});

describe('产物输入账本：单一声明面 = 名册 shared（2026-09-28 账本合一）', () => {
  it('构建全局件恰三个（不是单一产物的事，才配留在脚本里）', () => {
    const cfg = readFileSync(BUILD_SCRIPT, 'utf8');
    const decl = /const GLOBAL_INPUTS = new Set\(\[([\s\S]*?)\]\);/.exec(cfg);
    expect(decl, '构建脚本缺 GLOBAL_INPUTS 声明').not.toBeNull();
    const actual = [...decl![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    expect(actual, '全局件集变了：只有跨产物的构建件才配留全局，其余一律进名册 shared').toEqual(
      [...GLOBAL_INPUTS].sort(),
    );
  });

  it('名册 shared 全是可解析的 src 相对路径，且不含构建全局件（别把全局件抄进每一条）', () => {
    const globals = new Set(GLOBAL_INPUTS.map((g) => g.replace(/^src-ui\/src\//, '')));
    const bad: string[] = [];
    for (const e of BUILTIN_ROSTER) {
      for (const s of e.shared ?? []) {
        if (s.startsWith('src-ui/') || s.startsWith('/')) bad.push(`${e.dir} → ${s}（须是 src/ 相对路径）`);
        else if (!existsSync(join(UI_ROOT, 'src', s))) bad.push(`${e.dir} → ${s}（文件不存在）`);
        if (globals.has(s)) bad.push(`${e.dir} → ${s}（构建全局件，不必登记）`);
      }
    }
    expect(bad, `名册 shared 条目形态不合规：\n${bad.join('\n')}`).toEqual([]);
  });

  it('带模块级状态者不得登记 shared（共享状态的唯一合法通道是宿主桥 ./host）', () => {
    const stateless = JSON.parse(readFileSync(STATEFUL_LEDGER, 'utf8')).modules as Record<string, unknown>;
    const stateful = new Set(Object.keys(stateless).map((k) => k.replace(/^src-ui\/src\//, '')));
    const violations = BUILTIN_ROSTER.flatMap((e) =>
      (e.shared ?? []).filter((s) => stateful.has(s)).map((s) => `${e.dir} → ${s}`),
    );
    expect(
      violations,
      '带模块级状态的内核模块被登记成「共享面」——那是副本病灶的种子（应改走宿主桥）：\n' + violations.join('\n'),
    ).toEqual([]);
  });
});
