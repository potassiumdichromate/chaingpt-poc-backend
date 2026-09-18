import { describe, expect, it } from 'vitest';
import {
  attributeEvidence, freshnessOf, scoreConfidence, summarizeQuality, toEvidenceRef,
} from '../intelligence/evidence.js';
import type { EvidenceRef, Provenance, Signal } from '../types.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-18T12:00:00Z');

function signal(id: string, title: string, daysOld: number): Signal {
  return {
    id, title, description: `${title} - details`, source: 'ChainGPT AI News',
    publishedAt: new Date(NOW - daysOld * DAY).toISOString(),
  };
}

function ref(id: string, title: string, daysOld: number): EvidenceRef {
  return toEvidenceRef(signal(`s_${id}`, title, daysOld), id, 14, { now: NOW });
}

describe('freshness', () => {
  it('classifies by age against a 7-day fresh line and the retrieval window', () => {
    expect(freshnessOf(0, 14)).toBe('fresh');
    expect(freshnessOf(7, 14)).toBe('fresh');
    expect(freshnessOf(8, 14)).toBe('aging');
    expect(freshnessOf(14, 14)).toBe('aging');
    expect(freshnessOf(15, 14)).toBe('stale');
  });

  it('computes age from the real publication date, not ingest time', () => {
    const r = ref('E1', 'Immutable opens AI games grant', 3);
    expect(r.ageDays).toBe(3);
    expect(r.freshness).toBe('fresh');
  });
});

describe('summarizeQuality', () => {
  it('says plainly when there is no evidence', () => {
    const q = summarizeQuality([], 14);
    expect(q.level).toBe('none');
    expect(q.note).toMatch(/KULT context alone/);
  });

  it('flags an all-stale set and names the newest age', () => {
    const q = summarizeQuality([ref('E1', 'a', 20), ref('E2', 'b', 31)], 14, 1);
    expect(q.level).toBe('stale');
    expect(q.relaxedFreshness).toBe(true);
    expect(q.newestAgeDays).toBe(20);
    expect(q.note).toMatch(/20 days old/);
  });

  it('reports a mixed set with the stale count', () => {
    const q = summarizeQuality([ref('E1', 'a', 1), ref('E2', 'b', 30)], 14, 1);
    expect(q.level).toBe('mixed');
    expect(q.stale).toBe(1);
    expect(q.fresh).toBe(1);
  });

  it('calls an all-in-window set good', () => {
    const q = summarizeQuality([ref('E1', 'a', 0), ref('E2', 'b', 10)], 14);
    expect(q.level).toBe('good');
    expect(q.note).toMatch(/today/);
  });
});

describe('attributeEvidence', () => {
  const evidence = [
    ref('E1', 'Immutable opens a grants track for AI-native game studios', 1),
    ref('E2', 'Stablecoin volumes hit record on Ethereum', 2),
  ];

  it('keeps only cited ids that were actually retrieved', () => {
    const out = attributeEvidence(['E1', 'E9'], evidence, 'anything');
    expect(out.map((e) => e.id)).toEqual(['E1']);
    expect(out[0]!.attribution).toBe('cited');
  });

  it('falls back to a labelled text match when nothing valid was cited', () => {
    const out = attributeEvidence([], evidence, 'Apply to the Immutable grants track for AI-native studios');
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('E1');
    expect(out[0]!.attribution).toBe('matched');
  });

  it('matches across word forms, as live prose paraphrases headlines', () => {
    const live = [ref('E3', 'SEC approves five-year pilot for trading tokenized U.S. stocks on public blockchains', 1)];
    const out = attributeEvidence([], live, 'Tokenized U.S. Stocks Trading. The SEC has recently approved a five-year pilot for trading tokenized stock.');
    expect(out.map((e) => `${e.id}/${e.attribution}`)).toEqual(['E3/matched']);
  });

  it('attributes nothing when the text shares no substance with any article', () => {
    expect(attributeEvidence([], evidence, 'Run a community tournament on Discord')).toEqual([]);
  });
});

describe('scoreConfidence', () => {
  const empty: Provenance = { evidence: [], knowledge: [], outcomes: [] };

  it('is low with no evidence and no memory, and says why', () => {
    const c = scoreConfidence(empty);
    expect(c.level).toBe('low');
    expect(c.reasons.join(' ')).toMatch(/No ChainGPT evidence/);
  });

  it('is high with fresh cited evidence plus memory and an outcome', () => {
    const c = scoreConfidence({
      evidence: [{ ...ref('E1', 'a', 1), attribution: 'cited' }, { ...ref('E2', 'b', 2), attribution: 'cited' }],
      knowledge: [{ id: 'kn_1', title: 't', type: 'opportunity_research', createdAt: '' }],
      outcomes: [{ id: 'out_1', outcomeType: 'conversation_started', createdAt: '' }],
    });
    expect(c.level).toBe('high');
    expect(c.reasons.some((r) => /fresh ChainGPT article/.test(r))).toBe(true);
    expect(c.reasons.some((r) => /recorded outcome/.test(r))).toBe(true);
  });

  it('penalizes stale-only evidence below the same set when fresh', () => {
    const stale = scoreConfidence({ ...empty, evidence: [{ ...ref('E1', 'a', 40), attribution: 'cited' }] });
    const fresh = scoreConfidence({ ...empty, evidence: [{ ...ref('E1', 'a', 1), attribution: 'cited' }] });
    expect(stale.score).toBeLessThan(fresh.score);
    expect(stale.reasons.join(' ')).toMatch(/Only stale evidence/);
  });

  it('weights text-matched evidence below cited evidence', () => {
    const cited = scoreConfidence({ ...empty, evidence: [{ ...ref('E1', 'a', 1), attribution: 'cited' }] });
    const matched = scoreConfidence({ ...empty, evidence: [{ ...ref('E1', 'a', 1), attribution: 'matched' }] });
    expect(matched.score).toBeLessThan(cited.score);
    expect(matched.reasons.join(' ')).toMatch(/did not cite/);
  });
});
