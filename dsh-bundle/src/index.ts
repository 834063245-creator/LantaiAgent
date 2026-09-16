/**
 * @module hologram-dsh — HoloGram engine MCP bridge for the DeepSeek Harness.
 *
 * Node-half glue plugin. It resolves the bundled `hologram-engine` binary (an
 * install-time fact of this package, never user config) and provides the
 * `hologramEngine` service used by the `hologram-mcp` row in
 * cordis.patch.yml. Reusing DSH's own `dsh-mcp-client` for the actual MCP
 * connection means we need no MCP client code here — just the facts DSH
 * can't know: where the engine lives and what project to analyze.
 *
 * 2026-09-16 拆除记录：原「阶段2」的 3D 视图（viewer 目录 + client 半 +
 * `/hologram` 同源静态路由 + `/hologram/api/graph` 与 9777 TCP 数据面）随主仓
 * 图谱渲染内核退役一并拆除——本包自此只提供**引擎 + MCP 工具面**。
 * 施工记录见 `docs/archive/dsh-viewer-phase2-{design,integration}.md`，
 * 拆除裁定见 `docs/landmine-map.md`。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Stable cordis plugin name (the import specifier `hologram-dsh`). */
export const name = 'hologram-dsh'

/** Plugin config: where to analyze. */
export interface Config {
  /** Filesystem root the engine should analyze (defaults to the process cwd). */
  projectRoot: string
  /** Extra environment variables for the engine subprocess. */
  env: Record<string, string>
}

export const Config: z<Config> = z.object({
  projectRoot: z.string().default(''),
  env: z.dict(String).default({}),
})

/** The resolved facts of the bundled engine. */
export interface HologramEngineService {
  /** Absolute path to the bundled `hologram-engine` executable. */
  bin: string
  /** Absolute analysis project root (the process cwd when unset). */
  projectRoot: string
  /**
   * Full argv for `serve` (derived from this package's facts). Exposed as a
   * plain value rather than a patch-side flow-collection expression so the
   * yaml `!!js` tag only ever carries scalar expression bodies — a flow
   * collection body is rejected by the loader's js-yaml function schema.
   */
  serveArgs: string[]
  /** Environment additions handed to the engine subprocess. */
  env: Record<string, string>
}

/** Service key provided by this plugin and injected by the mcp row. */
const SERVICE = 'hologramEngine'

// The binary ships inside THIS package at bin/hologram-engine.exe, next to
// lib/ (built) or src/ (source). When installed into a dsh profile, the exe
// sits at node_modules/<pkg>/bin/hologram-engine.exe.
// One `..` from either src/index.ts or lib/index.mjs lands on the package root
// that holds bin/. In lib/index.mjs the file's parent is lib/, so a single
// hop reaches the package root; two hops would escape into node_modules.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Resolve the bundled engine executable. Throws a clear diagnostic when the
 * binary is missing so the harness reports a fixable error instead of a
 * cryptic spawn failure.
 */
export function resolveEngineBinary(): string {
  const candidate = path.join(PACKAGE_ROOT, 'bin', 'hologram-engine.exe')
  if (!existsSync(candidate)) {
    throw new Error(
      `hologram-dsh: bundled engine not found at ${candidate}. Run "pnpm run pack:bin" in the hologram-dsh package (or "npm run dsh:pack" in the repo) to copy it in — the engine binary is not committed to source control.`,
    )
  }
  return candidate
}

/**
 * Resolve the project root the engine should analyze. Empty (the schema
 * default) falls back to the current working directory of the dsh process.
 */
export function resolveProjectRoot(configProjectRoot: string): string {
  return configProjectRoot.trim().length > 0
    ? path.resolve(configProjectRoot)
    : process.cwd()
}

/**
 * Mount the engine facts service (stdio MCP only — 数据面 `--tcp` 随 3D 视图退役拆除).
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const projectRoot = resolveProjectRoot(config.projectRoot)
  const service: HologramEngineService = {
    bin: resolveEngineBinary(),
    projectRoot,
    serveArgs: ['serve', '--project-root', projectRoot],
    env: config.env,
  }
  ctx.provide(SERVICE, service)
}