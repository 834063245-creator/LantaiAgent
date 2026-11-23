// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 文卷随包形态（P1a）：名册 software 段 / 派生 manifest / 源码域插件对象三者对齐。

import { describe, expect, it } from 'vitest';
import { BUILTIN_ROSTER } from '../src/plugins/builtin-roster';
import { factoryProductPlugins } from '../src/plugins/factory-products';
import { validateManifest } from '../src/plugins/types';

describe('文卷随包产物（P1a）', () => {
  const entry = BUILTIN_ROSTER.find((e) => e.dir === 'md-editor');

  it('名册有 software 段：app/dataDir/tools 齐全', () => {
    expect(entry?.software).toBeDefined();
    expect(entry?.software?.app.entry).toBe('./app/index.html');
    expect(entry?.software?.app.workspace).toBe(true);
    expect(entry?.software?.app.documents).toBe(true);
    expect(entry?.software?.tools?.[0]?.name).toBe('wenjuan_open');
  });

  it('派生 manifest 过 PluginManifestSchema（app.workspace / tools / dataDir）', () => {
    expect(entry?.software).toBeDefined();
    const manifest = {
      name: 'hologram/md-editor',
      version: '1.0.0',
      description: entry!.description,
      entry: 'entry.js',
      inject: [],
      app: entry!.software!.app,
      dataDir: true,
      tools: entry!.software!.tools,
    };
    const parsed = validateManifest(manifest);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.app?.workspace).toBe(true);
      expect(parsed.manifest.tools?.[0]?.name).toBe('wenjuan_open');
    }
  });

  it('源码域插件对象在册（dev 装载面不落单）', () => {
    const plugin = factoryProductPlugins().find((p) => p.name === 'hologram/md-editor');
    expect(plugin).toBeDefined();
    expect(typeof plugin?.apply).toBe('function');
  });
});
