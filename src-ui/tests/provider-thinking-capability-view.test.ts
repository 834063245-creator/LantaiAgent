import { describe, expect, it } from 'vitest';
import { getModel } from '../src/provider/catalog';
import { parseModelEntry } from '../src/provider/model-meta';
import { thinkingOptionsFor } from '../src/provider/thinking';
import { effectiveModels, modelDescriptor, type ProviderSettings, providerId } from '../src/settings';

const CTX = { kind: 'openai' as const, vendor: 'gw', baseUrl: 'https://gw.test/v1' };

function row(over: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    kind: 'openai',
    name: providerId('gw'),
    apiKey: '',
    baseUrl: 'https://gw.test/v1',
    model: 'm',
    ...over,
  };
}

describe('provider thinking capability evidence', () => {
  it('accepts an API level->wire map and derives canonical levels', () => {
    const parsed = parseModelEntry(
      { id: 'm', thinking_efforts: { off: null, low: 'minimal', high: 'deep', turbo: 'x' } },
      CTX,
    );
    expect(parsed?.descriptor.thinkingEfforts).toEqual(['low', 'high']);
    expect(parsed?.meta.thinkingLevelMap).toEqual({ off: null, low: 'minimal', high: 'deep' });
  });

  it('provider-scoped descriptor exposes the API map to the composer selector', () => {
    const p = row({
      modelMeta: {
        m: {
          fetchedAt: 1,
          thinkingEfforts: ['low', 'high'],
          thinkingLevelMap: { low: 'minimal', high: 'deep' },
        },
      },
    });
    const desc = modelDescriptor(p, 'm');
    expect(desc?.thinkingLevelMap).toEqual({ low: 'minimal', high: 'deep' });
    expect(thinkingOptionsFor(desc).map((o) => o.value)).toEqual(['', 'low', 'high']);
  });

  it('models: [] is an explicit empty set, not a fallback to [model]', () => {
    expect(effectiveModels(row({ model: 'm', models: [] }))).toEqual([]);
    expect(effectiveModels(row({ model: 'm' }))).toEqual(['m']);
  });

  it('static catalog seed is provider-scoped by vendor or exact baseUrl, not global model id', () => {
    const seed = getModel('deepseek-v4-pro');
    expect(seed).toBeTruthy();
    const seedId = seed!.id;
    const foreign = row({ name: providerId('gw'), model: seedId, baseUrl: 'https://gw.test/v1' });
    expect(modelDescriptor(foreign, seedId)).toBeUndefined();
    const sameEndpoint = row({ name: providerId('gw'), model: seedId, baseUrl: seed!.baseUrl });
    expect(modelDescriptor(sameEndpoint, seedId)?.contextWindow).toBe(seed!.contextWindow);
  });
});
