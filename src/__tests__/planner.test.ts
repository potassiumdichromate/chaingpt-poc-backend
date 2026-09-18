import { describe, expect, it } from 'vitest';
import { planAgentEvidence, planResearchEvidence } from '../intelligence/planner.js';
import { salientPhrases } from '../intelligence/signals.js';
import type { Agent, OpportunityRun, OutcomeRef } from '../types.js';

const agent: Agent = {
  id: 'did:privy:test', name: 'Test', role: 'creator',
  interests: ['AI gaming', 'Racing'], capabilities: [], activity: [],
  goals: ['Find distribution for published KULT Create experiences'],
};

function previousRun(): OpportunityRun {
  return {
    id: 'run_prev', agentId: agent.id, query: 'AI gaming', provider: 'demo', signalIds: ['s1'],
    usedKnowledgeIds: [], createdAt: '2026-09-18T10:00:00.000Z',
    result: {
      opportunities: [
        { id: 'opp_1', title: 'Apply to the Immutable AI-native games grant', signal: 'Immutable opened a grants track' },
        { id: 'opp_2', title: 'Pilot agent commerce payments', signal: 'Agent payment rails in live consumer flows' },
      ],
    },
  };
}

const outcome = (type: OutcomeRef['outcomeType']): OutcomeRef => ({
  id: 'out_1', outcomeType: type, opportunityTitle: 'Apply to the Immutable AI-native games grant', createdAt: '',
});

describe('salientPhrases', () => {
  it('prefers proper nouns, then known Web3 terms, over leading verbs', () => {
    expect(salientPhrases('Apply to the Immutable AI-native games grant track')).toEqual(['Immutable', 'grant']);
  });

  it('does not treat every word of a Title Cased heading as a name', () => {
    const out = salientPhrases('Position The Agent For Agent Commerce Pilot Partnerships');
    expect(out).toEqual(['agent commerce']);
  });

  it('caps the list', () => {
    expect(salientPhrases('Ronin and Immutable and Polygon and Solana grants', 2)).toHaveLength(2);
  });
});

describe('planAgentEvidence', () => {
  it('plans goal and coverage needs on a first scan', () => {
    const needs = planAgentEvidence({ agent, newOutcomes: [] });
    expect(needs.map((n) => n.trigger)).toEqual(['goal', 'coverage']);
    expect(needs[0]!.phrases[0]).toBe('AI gaming');
    expect(needs.every((n) => n.reason.length > 10)).toBe(true);
  });

  it('puts the latest outcome first, and a no-response outcome looks for alternatives', () => {
    const needs = planAgentEvidence({ agent, previousRun: previousRun(), newOutcomes: [outcome('no_response')] });
    expect(needs[0]!.trigger).toBe('outcome');
    expect(needs[0]!.triggerRef?.id).toBe('out_1');
    expect(needs[0]!.question).toMatch(/alternatives/);
    expect(needs[0]!.phrases).not.toContain('Immutable');
  });

  it('a positive outcome searches for the named partner to support the follow-up', () => {
    const needs = planAgentEvidence({ agent, previousRun: previousRun(), newOutcomes: [outcome('conversation_started')] });
    expect(needs[0]!.phrases[0]).toBe('Immutable');
    expect(needs[0]!.reason).toMatch(/conversation started/);
  });

  it('re-checks the previous recommendation the outcome did not already cover', () => {
    const needs = planAgentEvidence({ agent, previousRun: previousRun(), newOutcomes: [outcome('no_response')] });
    const recheck = needs.find((n) => n.trigger === 'previous_recommendation');
    expect(recheck?.triggerRef?.id).toBe('opp_2');
  });

  it('plans the user focus first and never exceeds three needs', () => {
    const needs = planAgentEvidence({ agent, query: 'GameFi grants', previousRun: previousRun(), newOutcomes: [outcome('other')] });
    expect(needs[0]!.trigger).toBe('user_focus');
    expect(needs[0]!.phrases[0]).toBe('GameFi grants');
    expect(needs.length).toBeLessThanOrEqual(3);
  });

  it('never gives two needs the same lead phrase', () => {
    const needs = planAgentEvidence({ agent, previousRun: previousRun(), newOutcomes: [outcome('other')] });
    const leads = needs.map((n) => n.phrases[0]!.toLowerCase());
    expect(new Set(leads).size).toBe(leads.length);
  });

  it('splits the six-signal budget across needs', () => {
    for (const needs of [
      planAgentEvidence({ agent, newOutcomes: [] }),
      planAgentEvidence({ agent, previousRun: previousRun(), newOutcomes: [outcome('no_response')] }),
    ]) {
      expect(needs.reduce((acc, n) => acc + n.quota, 0)).toBeLessThanOrEqual(6);
      expect(needs.map((n) => n.id)).toEqual(needs.map((_, i) => `N${i + 1}`));
    }
  });
});

describe('planResearchEvidence', () => {
  it('searches the opportunity itself instead of its first two words', () => {
    const [need] = planResearchEvidence({ title: 'Apply to the Immutable AI-native games grant', signal: '' });
    expect(need!.phrases[0]).toBe('Immutable');
    expect(need!.phrases).not.toContain('Apply to');
    expect(need!.phrases.length).toBeLessThanOrEqual(4);
  });
});
