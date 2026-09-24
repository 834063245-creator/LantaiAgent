// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// faceDeps 登记守卫（2026-09-13 事故立法）——**产物域经宿主桥取用的每个模块键都必须在
// `plugins/builtin/host-modules.ts` 的 faceDeps 里登记**。
//
// 事故复盘（office-domain 新增那批）：产物 `entry.js` 在磁盘通道里是这样拿实现的——
//   const impl = requireHost().mods.faceDeps; const createOfficeTools = impl.createOfficeTools;
// 我只加了域插件与名册，**没登记 faceDeps** ⇒ 生产里 `createOfficeTools === undefined`
// ⇒ `apply()` 期 `createOfficeTools(NEVER_EXEC)` TypeError ⇒ 插件装载失败 ⇒ boot gate
// fail-loud 挂住 ⇒ chat 壳行不起 ⇒ 用户看到「会话核心未初始化，无法绑定目录」。
//
// 为什么既有守卫没拦住：host-modules.ts 的 `FaceBridgeSeal` 是**编译期**封印，但它只在
// 「新域被显式加进封印类型」时才生效——漏加就静默；两域测试又都直连真身（不经过 faceDeps）。
// 本守卫改用**产物源码文本**推导需求（`host.aliased.ts` 里的 `impl.<key>`），
// 对全部产物零维护覆盖：新域忘记登记 = 本用例当场红，不再等到用户 exe 里炸。
//
// 第二段（生产同形装载）：dist-plugins 存在时（本地 `npm run build` 后）真装载每个
// 工具域产物的 entry.js——按磁盘通道口径（globalThis.__lantai_plugin_host__ = pluginHostMods()）
// 跑一遍 apply，钉住"产物 + 宿主桥"能真的装起来。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { faceDepsKeys, pluginHostMods } from '../src/plugins/builtin/host-modules';
import { BUILTIN_ROSTER } from '../src/plugins/builtin-roster';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_SRC = join(HERE, '..', 'src', 'plugins', 'builtin');
const DIST_PLUGINS = join(HERE, '..', 'dist-plugins', 'builtin', 'hologram');

/** 从产物源码的 host.aliased.ts 推导它需要的 faceDeps 键（`export const X = impl.X;` 形态）。
 *  只认**真导出语句**——不认注释里的示例（paper-minimap 的注释里就写着 `export const X = impl.X`，
 *  宽匹配会把它当需求，误报一条 `X`）。 */
function requiredKeysFromAliased(dir: string): string[] {
  const fp = join(BUILTIN_SRC, dir, 'host.aliased.ts');
  if (!existsSync(fp)) return [];
  const src = readFileSync(fp, 'utf8');
  const keys = new Set<string>();
  for (const m of src.matchAll(/^\s*export const \w+ = impl\.([A-Za-z0-9_$]+)\s*;/gm)) keys.add(m[1]!);
  return [...keys];
}

describe('faceDeps 登记守卫：产物取用的模块键必须在宿主桥登记表里', () => {
  it('全部产物域（名册逐目）的 host.aliased 取用键 ⊆ faceDepsKeys()', () => {
    const have = faceDepsKeys();
    const missing: string[] = [];
    for (const entry of BUILTIN_ROSTER) {
      for (const key of requiredKeysFromAliased(entry.dir)) {
        if (!have.has(key)) missing.push(`${entry.dir} → ${key}`);
      }
    }
    expect(
      missing,
      `以下产物取用键未登记进 faceDeps（生产会 undefined → TypeError → boot 挂住）：\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('守卫自检：推导器确实能从 aliased 文件里读出取用键（防守卫自身失灵）', () => {
    // office-domain 批 3a 归家后改为桥平台面（defineTool / session-context 助手）
    expect(requiredKeysFromAliased('office-domain')).toContain('defineTool');
    // asset-domain 同理（老域对照：工厂仍在内核，经桥取用）
    expect(requiredKeysFromAliased('asset-domain')).toContain('createAssetTools');
  });
});

// ── 生产同形装载（dist-plugins 存在时跑；本地 build 后即生效）──
// 只挑**工具域产物**（名册 inject === ['tools']）：它们的入口只依赖 faceDeps + ctx.tools，
// 能在测试环境里以真 cordis 生命周期装载；面产物（panels/commands/renderers/react）依赖
// 宿主渲染面，不在本用例范围（它们由各自的插件测试覆盖）。
const toolDirs = BUILTIN_ROSTER.filter((e) => e.inject.length === 1 && e.inject[0] === 'tools').map((e) => e.dir);
const distDirs = existsSync(DIST_PLUGINS)
  ? readdirSync(DIST_PLUGINS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => toolDirs.includes(n))
  : [];
const d = distDirs.length > 0 ? describe : describe.skip;

d('生产同形装载：磁盘通道工具域产物 + 宿主桥 faceDeps（dist-plugins 在场）', () => {
  it('每个工具域产物都能在宿主桥下经真 cordis 装载并贡献工具行', async () => {
    const bridge = { mods: pluginHostMods(), notify: () => {}, createElement: () => null, loadCss: () => {} };
    (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__ = bridge;
    try {
      const failures: string[] = [];
      for (const dir of distDirs) {
        const entryPath = join(DIST_PLUGINS, dir, 'entry.js');
        if (!existsSync(entryPath)) continue;
        const root = new Context();
        try {
          await root.plugin(compositionServicesPlugin);
          const mod = (await import(/* @vite-ignore */ `file://${entryPath.replace(/\\/g, '/')}`)) as {
            default?: { name: string; apply: (ctx: unknown) => void };
          };
          const plugin = mod.default;
          if (!plugin?.apply) {
            failures.push(`${dir}: 产物无 default.apply`);
            continue;
          }
          const fiber = await root.plugin(plugin);
          const rows = pluginToolRows(root).map((r) => r.id);
          if (!rows.some((id) => id.startsWith(`plugin/${plugin.name}/`))) {
            failures.push(`${dir}: apply 后零工具行贡献`);
          }
          await fiber.dispose();
        } catch (e) {
          failures.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await root[Symbol.asyncDispose]?.();
        }
      }
      expect(failures, `磁盘通道装载失败（生产即此形）：\n${failures.join('\n')}`).toEqual([]);
    } finally {
      delete (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__;
    }
  }, 90_000);
});
