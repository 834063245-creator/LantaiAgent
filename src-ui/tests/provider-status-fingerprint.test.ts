import { describe, expect, it } from 'vitest';
import {
  probeMatchesProvider,
  providerConnectionFingerprint,
  providerStatus,
} from '../src/plugins/builtin/settings-domain/status';
import { type ProviderSettings, providerId } from '../src/settings';

function row(over: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    kind: 'openai',
    name: providerId('gw'),
    apiKey: 'sk-test',
    baseUrl: 'https://gw.test/v1',
    model: 'm1',
    ...over,
  };
}

describe('provider probe fingerprint', () => {
  it('only a probe made for the same connection identity counts as ok/fail', () => {
    const p = row();
    const probe = {
      status: 'ok' as const,
      latencyMs: 12,
      at: 100,
      fingerprint: providerConnectionFingerprint(p),
    };
    const tested = row({ lastTest: probe });
    expect(probeMatchesProvider(tested, probe)).toBe(true);
    expect(providerStatus(tested)).toBe('ok');

    const changed = row({ baseUrl: 'https://other.test/v1', lastTest: probe });
    expect(probeMatchesProvider(changed, probe)).toBe(false);
    expect(providerStatus(changed)).toBe('configured');
  });

  it('legacy probes without a fingerprint are treated as stale', () => {
    const p = row({ lastTest: { status: 'ok', latencyMs: 1, at: 1 } });
    expect(probeMatchesProvider(p, p.lastTest)).toBe(false);
    expect(providerStatus(p)).toBe('configured');
  });
});
