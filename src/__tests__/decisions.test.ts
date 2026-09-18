import { beforeEach, describe, expect, it } from 'vitest';
import { db, initStore } from '../db/store.js';
import { buildDecisionDelta, previousRecommendations, resolveDecision } from '../intelligence/decisions.js';
import { toEvidenceRef } from '../intelligence/evidence.js';
import type { Opportunity, OpportunityRun } from '../types.js';

const AGENT = 'agent_delta_test';
const T0 = '2026-09-18T10:00:00.000Z';
const T1 = '2026-09-18T10:30:00.000Z';

function opp(id: string, title: string, decision?: Opportunity['decision']): Opportunity {
  return {
    id, title, relevance: 80, signal: '', why: '', opportunity: '', action: 'do it',
    memoryInfluence: { used: false, knowledgeIds: [], reason: '' },
    provenance: { evidence: [], knowledge: [], outcomes: [] },
    confidence: { level: 'medium', score: 50, reasons: [] },
    ...(decision ? { decision } : {}),
  };
}

const prevRun: OpportunityRun = {
  id: 'run_p', agentId: AGENT, query: 'q', provider: 'demo', signalIds: ['s_old'], usedKnowledgeIds: [],
  createdAt: T0,
  result: {
    opportunities: [
      opp('p1', 'Apply to the Immutable AI games grant'),
      opp('p2', 'Pilot agent commerce payments'),
      opp('p3', 'Target creator distribution funds'),
    ],
  },
};

describe('resolveDecision', () => {
  const previous = [
    { label: 'P1', id: 'p1', title: 'Apply to the Immutable AI games grant', action: '', signal: '', actions: [], outcomes: [] },
    { label: 'P2', id: 'p2', title: 'Pilot agent commerce payments', action: '', signal: '', actions: [], outcomes: [] },
  ];

  it('accepts a model link to a real previous recommendation', () => {
    const d = resolveDecision({ status: 'changed', previousId: 'P1', reason: 'Outcome out_1 showed no response.' }, 'x', previous);
    expect(d).toMatchObject({ status: 'changed', previousLabel: 'P1', previousOpportunityId: 'p1', attribution: 'model' });
  });

  it('discards a link to a label that was never shown, falling back to a title match', () => {
    const d = resolveDecision({ status: 'kept', previousId: 'P9', reason: '' }, 'Pilot agent commerce payments', previous);
    expect(d).toMatchObject({ status: 'kept', previousLabel: 'P2', attribution: 'matched' });
  });

  it('marks an unlinked recommendation new and admits when there is no reason', () => {
    const d = resolveDecision(undefined, 'Run a Discord tournament', previous);
    expect(d).toEqual({ status: 'new', reason: '', attribution: 'none' });
  });
});

describe('buildDecisionDelta', () => {
  beforeEach(async () => {
    await initStore();
    await db.mutate((s) => {
      s.knowledge = []; s.runs = []; s.actions = []; s.outcomes = []; s.events = [];
      // Before the previous scan - must NOT count as learned.
      s.knowledge.push({ id: 'kn_old', agentId: AGENT, type: 'opportunity_research', title: 'old', summary: 's', payload: null, sourceProvider: 'demo', sourceRefs: [], createdAt: '2026-09-18T09:00:00.000Z' });
      // After it - learned.
      s.knowledge.push({ id: 'kn_new', agentId: AGENT, type: 'opportunity_research', title: 'Grant research', summary: 's', payload: null, sourceProvider: 'demo', sourceRefs: [], createdAt: T1 });
      s.actions.push({ id: 'act_1', agentId: AGENT, opportunityId: 'p1', opportunityTitle: 'Apply to the Immutable AI games grant', runId: 'run_p', actionType: 'applied_to_program', status: 'taken', createdAt: T1 });
      s.outcomes.push({ id: 'out_1', agentId: AGENT, actionId: 'act_1', outcomeType: 'no_response', createdAt: T1 });
      s.actions.push({ id: 'act_3', agentId: AGENT, opportunityId: 'p3', opportunityTitle: 'Target creator distribution funds', actionType: 'dismissed', status: 'dismissed', createdAt: T1 });
    });
  });

  it('links previous recommendations to their actions and outcomes', () => {
    const prev = previousRecommendations(prevRun);
    expect(prev.map((p) => p.label)).toEqual(['P1', 'P2', 'P3']);
    expect(prev[0]!.outcomes[0]).toMatchObject({ id: 'out_1', outcomeType: 'no_response', opportunityTitle: 'Apply to the Immutable AI games grant' });
  });

  it('reports only what was learned after the previous scan, and why each decision moved', () => {
    const previous = previousRecommendations(prevRun);
    const evidence = [
      toEvidenceRef({ id: 's_old', title: 'old news', description: '', source: 's', publishedAt: T0 }, 'E1', 14, { seenBefore: true }),
      toEvidenceRef({ id: 's_new', title: 'new news', description: '', source: 's', publishedAt: T1 }, 'E2', 14, { seenBefore: false }),
    ];
    const opportunities = [
      opp('n1', 'Follow up with Immutable developer relations', {
        status: 'changed', previousLabel: 'P1', previousOpportunityId: 'p1', previousTitle: 'x',
        reason: 'No response to the application.', attribution: 'model',
      }),
      opp('n2', 'Pilot agent commerce payments', {
        status: 'kept', previousLabel: 'P2', previousOpportunityId: 'p2', previousTitle: 'y', reason: '', attribution: 'matched',
      }),
      opp('n3', 'Run a tournament', { status: 'new', reason: 'New.', attribution: 'model' }),
    ];

    const delta = buildDecisionDelta({
      previousRun: prevRun, previous, opportunities, evidence, rawDropped: [], now: Date.parse(T1) + 60_000,
    });

    expect(delta.learned.knowledge.map((k) => k.id)).toEqual(['kn_new']);
    expect(delta.learned.outcomes.map((o) => o.id)).toEqual(['out_1']);
    expect(delta.learned.newEvidence.map((e) => e.id)).toEqual(['E2']);
    expect(delta.learned.repeatedEvidence).toBe(1);
    expect(delta.counts).toEqual({ kept: 1, changed: 1, new: 1, dropped: 1 });
    expect(delta.dropped[0]).toMatchObject({ previousLabel: 'P3', reason: 'Dismissed by the Agent.', attribution: 'derived' });
    expect(delta.summary).toMatch(/learned 1 outcome, 1 saved research item, 2 actions, 1 new ChainGPT article/);
    expect(delta.summary).toMatch(/kept 1, changed 1, added 1, dropped 1/);
  });

  it('prefers the model\'s stated reason for a dropped recommendation', () => {
    const delta = buildDecisionDelta({
      previousRun: prevRun, previous: previousRecommendations(prevRun), opportunities: [], evidence: [],
      rawDropped: [{ previousId: 'P2', reason: 'Payment pilots need a live wallet surface first.' }],
    });
    const p2 = delta.dropped.find((d) => d.previousLabel === 'P2');
    expect(p2).toMatchObject({ attribution: 'model', reason: 'Payment pilots need a live wallet surface first.' });
    const p1 = delta.dropped.find((d) => d.previousLabel === 'P1');
    expect(p1?.reason).toBe('Outcome recorded: no response.');
  });
});
