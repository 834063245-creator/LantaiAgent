// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  credentialRevision,
  noteCredentialStored,
  _resetCredentialRevisionsForTests,
} from '../src/provider/credentials';
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
  beforeEach(() => {
    localStorage.clear();
    _resetCredentialRevisionsForTests();
  });

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

  it('R4：同长度换 Key 也推进 credential revision，旧探针立即失效', () => {
    noteCredentialStored('gw', 'sk-aaaa');
    const before = row({ apiKey: 'sk-aaaa' });
    const probe = {
      status: 'ok' as const,
      latencyMs: 12,
      at: 100,
      fingerprint: providerConnectionFingerprint(before),
    };
    expect(credentialRevision('gw')).toBe(1);

    noteCredentialStored('gw', 'sk-bbbb'); // 长度同为 7
    const after = row({ apiKey: 'sk-bbbb', lastTest: probe });
    expect(credentialRevision('gw')).toBe(2);
    expect(providerConnectionFingerprint(after)).not.toBe(probe.fingerprint);
    expect(probeMatchesProvider(after, probe)).toBe(false);
    expect(providerStatus(after)).toBe('configured');

    // 同值重写不 bump——每次保存都重写同一把 Key 不该反复误伤探针。
    noteCredentialStored('gw', 'sk-bbbb');
    expect(credentialRevision('gw')).toBe(2);
  });

  it('legacy probes without a fingerprint are treated as stale', () => {
    const p = row({ lastTest: { status: 'ok', latencyMs: 1, at: 1 } });
    expect(probeMatchesProvider(p, p.lastTest)).toBe(false);
    expect(providerStatus(p)).toBe('configured');
  });
});
