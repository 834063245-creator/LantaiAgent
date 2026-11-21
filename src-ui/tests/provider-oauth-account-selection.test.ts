import { describe, expect, it } from 'vitest';
import { applyProvidersDoc, parseProvidersDoc } from '../src/provider/providers-doc';

describe('OAuth per-provider account selection', () => {
  it('round-trips oauthAccountId through providers.yml', () => {
    const text = applyProvidersDoc('', {
      codex: {
        kind: 'responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        model: 'gpt-6-sol',
        authMode: 'oauth',
        oauthProvider: 'codex',
        oauthAccountId: 'user-2',
      },
    });
    expect(text).toContain('oauthAccountId: user-2');
    const parsed = parseProvidersDoc(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.sections[0]?.intent.oauthAccountId).toBe('user-2');
  });

  it('drops a non-string oauthAccountId as a field-level warning', () => {
    const doc = [
      'codex:',
      '  kind: responses',
      '  baseUrl: https://chatgpt.com/backend-api/codex',
      '  model: m',
      '  authMode: oauth',
      '  oauthProvider: codex',
      '  oauthAccountId: 42',
      '',
    ].join('\n');
    const parsed = parseProvidersDoc(doc);
    expect(parsed.errors).toEqual([]);
    expect(parsed.sections[0]?.intent.oauthAccountId).toBeUndefined();
    expect(parsed.warnings[0]?.message).toContain('oauthAccountId');
  });
});
