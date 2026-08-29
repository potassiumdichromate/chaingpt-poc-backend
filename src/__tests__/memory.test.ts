import { beforeEach, describe, expect, it } from 'vitest';
import { db, initStore } from '../db/store.js';
import { selectRelevantKnowledge } from '../intelligence/memory.js';
import type { KnowledgeItem } from '../types.js';

function item(over: Partial<KnowledgeItem>): KnowledgeItem {
  return {
    id: over.id ?? 'k1',
    agentId: over.agentId ?? 'agent_a',
    type: 'opportunity_research',
    title: over.title ?? 'Untitled',
    summary: over.summary ?? '',
    payload: null,
    sourceProvider: 'chaingpt',
    sourceRefs: [],
    createdAt: over.createdAt ?? new Date().toISOString(),
  };
}

describe('selectRelevantKnowledge', () => {
  beforeEach(async () => {
    await initStore();
    await db.mutate((s) => { s.knowledge = []; });
  });

  it('returns nothing for an Agent with no saved intelligence', () => {
    expect(selectRelevantKnowledge('agent_a', 'AI gaming')).toEqual([]);
  });

  it('scopes strictly to the requested Agent', async () => {
    await db.mutate((s) => {
      s.knowledge.push(item({ id: 'mine', agentId: 'agent_a', title: 'AI gaming grants' }));
      s.knowledge.push(item({ id: 'theirs', agentId: 'agent_b', title: 'AI gaming grants' }));
    });
    const got = selectRelevantKnowledge('agent_a', 'AI gaming grants');
    expect(got.map((k) => k.id)).toEqual(['mine']);
  });

  it('ranks keyword overlap above an unrelated item', async () => {
    await db.mutate((s) => {
      s.knowledge.push(item({ id: 'match', title: 'AI gaming ecosystem grant programs' }));
      s.knowledge.push(item({ id: 'other', title: 'Stablecoin settlement latency' }));
    });
    expect(selectRelevantKnowledge('agent_a', 'AI gaming ecosystem grants')[0]!.id).toBe('match');
  });

  it('prefers recent items when relevance is equal', async () => {
    const old = new Date(Date.now() - 12 * 86_400_000).toISOString();
    await db.mutate((s) => {
      s.knowledge.push(item({ id: 'stale', title: 'AI gaming grants', createdAt: old }));
      s.knowledge.push(item({ id: 'fresh', title: 'AI gaming grants' }));
    });
    expect(selectRelevantKnowledge('agent_a', 'AI gaming grants')[0]!.id).toBe('fresh');
  });

  it('caps the result at the requested limit', async () => {
    await db.mutate((s) => {
      for (let i = 0; i < 12; i += 1) s.knowledge.push(item({ id: `k${i}`, title: `AI gaming ${i}` }));
    });
    expect(selectRelevantKnowledge('agent_a', 'AI gaming', 5)).toHaveLength(5);
  });

  it('ignores stopwords so common filler does not drive ranking', async () => {
    await db.mutate((s) => {
      s.knowledge.push(item({ id: 'filler', title: 'The and for with that this from' }));
      s.knowledge.push(item({ id: 'real', title: 'Ecosystem distribution partners' }));
    });
    expect(selectRelevantKnowledge('agent_a', 'the and for ecosystem distribution')[0]!.id).toBe('real');
  });
});
