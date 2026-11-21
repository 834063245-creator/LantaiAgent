// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import type { AppSettings } from './host';
import { loadSettings, panelReload, providersDocStatus, providersFilePath } from './host';

export function errTextOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Replace the provider domain from disk while carrying unsaved/restored API keys in memory. */
export function withCarriedKeys(s: AppSettings, disk: AppSettings['providers']): AppSettings {
  const carried = new Map(s.providers.map((p) => [p.name, p.apiKey]));
  return {
    ...s,
    providers: disk.map((p) => (p.apiKey ? p : { ...p, apiKey: carried.get(p.name) || '' })),
  };
}

/** Observable receipt for provider-domain reloads. Key values never enter the log. */
export function logPanelReload(trigger: string): void {
  const st = providersDocStatus();
  const rows = loadSettings().providers;
  panelReload({
    path: providersFilePath(),
    rows: rows.length,
    errors: [
      ...st.errors.map((e) => ({ name: e.name, reason: `[整节] ${e.message}` })),
      ...st.warnings.map((e) => ({ name: e.name, reason: `[字段] ${e.message}` })),
    ],
    fatal: st.fatal,
    empty: st.empty,
    source: st.available && st.loaded && !st.fatal && !st.empty ? 'file' : 'localStorage',
    keysCarried: {
      withKey: rows.filter((p) => (p.apiKey ?? '').trim().length > 0).length,
      total: rows.length,
    },
    trigger,
  });
}
