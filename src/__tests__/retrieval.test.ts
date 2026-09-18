import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewsQuery } from '../providers/types.js';
import type { Signal } from '../types.js';

/**
 * The retrieval walk against a scripted provider: which phrase wins, when
 * freshness is relaxed, and how the cache and forceFreshSignals interact.
 */

const DAY = 86_400_000;
const calls: (string | undefined)[] = [];
let script: Record<string, number[]> = {};

function rows(phrase: string, ages: number[]): Signal[] {
  return ages.map((age, i) => ({
    id: `${phrase}_${i}`, title: `${phrase} ${i}`, description: '', source: 'test',
    publishedAt: new Date(Date.now() - age * DAY).toISOString(),
  }));
}

vi.mock('../providers/index.js', () => ({
  getProvider: () => ({
    name: 'scripted',
    fetchNews: async (q: NewsQuery) => {
      calls.push(q.searchQuery);
      return rows(q.searchQuery ?? 'feed', script[q.searchQuery ?? ''] ?? []);
    },
    reason: async () => ({}),
    health: async () => ({ ok: true, detail: '' }),
  }),
}));

const { retrieveSignals, clearSignalCache } = await import('../intelligence/retrieval.js');

describe('retrieveSignals', () => {
  beforeEach(() => {
    calls.length = 0;
    script = {};
    clearSignalCache();
  });

  it('walks past an empty phrase to the first one with in-window news', async () => {
    script = { 'web3 gaming': [], AI: [0, 1] };
    const r = await retrieveSignals({ phrases: ['web3 gaming', 'AI', 'web3'], limit: 3, freshnessDays: 14 });
    expect(r.usedPhrase).toBe('AI');
    expect(r.relaxedFreshness).toBe(false);
    expect(calls).toEqual(['web3 gaming', 'AI']);
  });

  it('keeps walking past stale-only results, then uses the freshest stale set if nothing is fresh', async () => {
    script = { gaming: [17, 20], 'AI agents': [30], web3: [] };
    const r = await retrieveSignals({ phrases: ['gaming', 'AI agents', 'web3'], limit: 3, freshnessDays: 14 });
    expect(r.relaxedFreshness).toBe(true);
    expect(r.usedPhrase).toBe('gaming');
    expect(r.newestAgeDays).toBe(17);
    expect(calls).toEqual(['gaming', 'AI agents', 'web3']);
  });

  it('returns only the in-window rows of a mixed result', async () => {
    script = { AI: [1, 40] };
    const r = await retrieveSignals({ phrases: ['AI'], limit: 3, freshnessDays: 14 });
    expect(r.signals).toHaveLength(1);
  });

  it('reports nothing found rather than inventing signals', async () => {
    const r = await retrieveSignals({ phrases: ['nothing'], limit: 3, freshnessDays: 14 });
    expect(r).toMatchObject({ signals: [], usedPhrase: null, relaxedFreshness: false });
  });

  it('serves a repeat query from cache, and forceFreshSignals bypasses it', async () => {
    script = { AI: [0] };
    const q = { phrases: ['AI'], limit: 3, freshnessDays: 14 };
    await retrieveSignals(q);
    const cached = await retrieveSignals(q);
    expect(cached.fromCache).toBe(true);
    expect(calls).toHaveLength(1);

    const fresh = await retrieveSignals({ ...q, bypassCache: true });
    expect(fresh.fromCache).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('shares identical searches between the needs of one plan, even with the cache bypassed', async () => {
    script = { 'web3 gaming': [40], gaming: [45] };
    const memo = new Map();
    const a = { phrases: ['web3 gaming', 'gaming'], limit: 6, freshnessDays: 14, bypassCache: true };
    const b = { phrases: ['web3 gaming', 'blockchain gaming'], limit: 6, freshnessDays: 14, bypassCache: true };
    await Promise.all([retrieveSignals(a, memo), retrieveSignals(b, memo)]);
    expect(calls.filter((c) => c === 'web3 gaming')).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it('keys the cache on filters, so a category-filtered query is not served unfiltered rows', async () => {
    script = { AI: [0] };
    await retrieveSignals({ phrases: ['AI'], limit: 3, freshnessDays: 14 });
    const filtered = await retrieveSignals({ phrases: ['AI'], limit: 3, freshnessDays: 14, categoryId: [2] });
    expect(filtered.fromCache).toBe(false);
  });
});
