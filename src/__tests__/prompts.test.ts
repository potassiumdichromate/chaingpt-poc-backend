import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { toEvidenceRef } from '../intelligence/evidence.js';
import {
  DETAIL_LEVELS, buildDecisionReviewPrompt, buildGrowthPrompt, buildOpportunityPrompt, buildRepairPrompt,
  buildResearchPrompt, contextAtDetail, renderCitableIds,
} from '../intelligence/prompts.js';
import type { KultContext } from '../intelligence/memory.js';
import type { EvidenceNeed } from '../types.js';

/**
 * VERIFIED LIVE: ~7.6k-char prompts drew a ChainGPT gateway 504. These tests pin
 * the guarantee the engine relies on: even a worst-case Agent - full memory, three
 * previous recommendations, long titles - fits PROMPT_CHAR_BUDGET at the most
 * compact detail level with two articles. Prompt edits that break it fail here,
 * not in an 80-second live timeout.
 */

const words = (n: number, w: string) => Array.from({ length: n }, () => w).join(' ').slice(0, n);
const title = (i: number) => `Apply to the Immutable AI-native games grant track and distribution option ${i}`;

const ctx: KultContext = {
  agent: {
    id: 'did:privy:cmnditqy301kl0cjrbm20d737', name: 'privy:cmnditqy…',
    role: 'KULT Create creator - ships Action, Arcade, Endless Runner experiences',
    interests: ['Action', 'Arcade', 'Endless Runner', 'Puzzle', 'Runner', 'endless runner/sports', 'Pure AI Agent', 'AI gaming'],
    capabilities: ['creation', 'multi-title creator', 'browser-featured creator', 'agent commerce'],
    activity: ['Published 12 experiences through KULT Create', '48,120 total plays across published games', 'Featured 3 times', 'Active in AI Arena', 'Top 10 creator'],
    goals: ['Find distribution for published KULT Create experiences', 'Grow players beyond the KULT audience', 'Secure ecosystem grants'],
  },
  recentKnowledge: Array.from({ length: 5 }, (_, i) => ({
    id: `kn_mfabc${i}xyz12`, agentId: 'a', type: 'opportunity_research' as const, title: title(i),
    summary: words(400, 'research'), payload: null, sourceProvider: 'chaingpt', sourceRefs: [], createdAt: '',
  })),
  recentActions: Array.from({ length: 5 }, (_, i) => ({
    id: `act_${i}`, agentId: 'a', opportunityId: 'o', opportunityTitle: title(i),
    actionType: 'applied_to_program' as const, status: 'taken' as const, createdAt: '',
  })),
  recentOutcomes: Array.from({ length: 5 }, (_, i) => ({
    id: `out_mfabc${i}xyz12`, outcomeType: 'no_response' as const, notes: words(200, 'notes'), opportunityTitle: title(i), createdAt: '',
  })),
};

const needs: EvidenceNeed[] = [1, 2, 3].map((i) => ({
  id: `N${i}`, trigger: 'goal', quota: 2, phrases: ['AI gaming'],
  question: `What new openings match the goal "Find distribution for published KULT Create experiences" ${i}?`,
  reason: 'Current Agent goal, ranked by its interests (Action, Arcade, Endless Runner) and its latest outcomes.',
}));

const evidence = Array.from({ length: 6 }, (_, i) => toEvidenceRef({
  id: `s${i}`, title: `South Korea Makes AI a Free, Uncapped Public Utility — Threat to Token-Gated AI Projects ${i}`,
  description: words(900, 'article'), source: 'ChainGPT', publishedAt: new Date(Date.now() - i * 5 * 86_400_000).toISOString(),
}, `E${i + 1}`, 14, { needId: `N${(i % 3) + 1}` }));

const previous = [1, 2, 3].map((i) => ({
  label: `P${i}`, id: `opp_${i}`, title: title(i), action: words(200, 'action'), signal: '',
  actions: [ctx.recentActions[0]!], outcomes: [ctx.recentOutcomes[0]!],
}));

const compact = DETAIL_LEVELS[DETAIL_LEVELS.length - 1]!;

describe('prompt budget', () => {
  it('a worst-case repeat scan fits the budget at the most compact level', () => {
    const p = buildOpportunityPrompt({
      ctx, needs, evidence: evidence.slice(0, 2), windowDays: 14, previous, previousWhen: '2026-09-18 08:19 UTC', detail: compact,
    });
    expect(p.length).toBeLessThanOrEqual(config.promptCharBudget);
  });

  it('worst-case research and growth prompts fit too', () => {
    const opp = { title: title(0), signal: words(300, 's'), why: words(400, 'w'), opportunity: words(400, 'o'), action: words(300, 'a') };
    expect(buildResearchPrompt(ctx, opp, evidence.slice(0, 2), compact).length).toBeLessThanOrEqual(config.promptCharBudget);
    const project = {
      id: 'p', ownerAgentId: 'a', title: 'Knife Flip Tower', description: words(600, 'desc'), category: 'Arcade',
      tags: ['Arcade', 'Tap'], audience: ['Casual'], goals: ['Distribution'], publishedAt: '2026-07-16T00:00:00Z',
    };
    expect(buildGrowthPrompt({ ...ctx, project }, evidence.slice(0, 2), compact).length).toBeLessThanOrEqual(config.promptCharBudget);
  });

  it('each level is no larger than the one before it', () => {
    const sizes = DETAIL_LEVELS.map((d) => buildOpportunityPrompt({
      ctx, needs, evidence, windowDays: 14, previous, previousWhen: 'x', detail: d,
    }).length);
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!);
  });

  it('only memory that is rendered can be cited: the context is sliced to the same level', () => {
    const shown = contextAtDetail(ctx, compact);
    const p = buildOpportunityPrompt({ ctx, needs, evidence, windowDays: 14, previous: [], previousWhen: '', detail: compact });
    for (const k of ctx.recentKnowledge) {
      expect(p.includes(k.id)).toBe(shown.recentKnowledge.includes(k));
    }
  });
});

describe('prompt content', () => {
  const p = buildOpportunityPrompt({ ctx, needs, evidence, windowDays: 14, previous, previousWhen: '2026-09-18 08:19 UTC' });

  it('labels every article with its id, age and freshness', () => {
    expect(p).toMatch(/EVIDENCE_ID: E1 \| \d{4}-\d{2}-\d{2} \(today, fresh\)/);
    expect(p).toMatch(/EVIDENCE_ID: E4 .*\(15d old, stale\)/);
  });

  it('shows outcomes with the recommendation they resulted from', () => {
    expect(p).toContain(`OUTCOME_ID: out_mfabc0xyz12 | no response on "${title(0)}"`);
  });

  it('shows previous recommendations as context only on a repeat scan, and leaves decisions to the review', () => {
    expect(p).toContain('PREVIOUS_ID: P1');
    expect(p).not.toContain('"decision"');
    const first = buildOpportunityPrompt({ ctx, needs, evidence, windowDays: 14, previous: [], previousWhen: '' });
    expect(first).not.toContain('PREVIOUS_ID');
  });

  it('uses id labels only on data lines, never in instructions with example ids', () => {
    for (const m of p.matchAll(/(EVIDENCE_ID|OUTCOME_ID|PREVIOUS_ID|KNOWLEDGE_ID):/g)) {
      expect(p.slice(m.index! - 2, m.index!)).toBe('- ');
    }
  });
});

describe('repair prompt', () => {
  const citable = renderCitableIds([
    { id: 'E1', label: 'Immutable opens a grants track for AI-native game studios' },
    { id: 'P1', label: 'previous recommendation: Apply to the Immutable grant' },
  ]);

  it('lists the ids the rewrite may cite, and only as a data list', () => {
    const r = buildRepairPrompt('Here are three opportunities...', 'JSON.parse failed', '{}', citable);
    expect(r).toContain('CITABLE IDS\n- E1: Immutable opens a grants track');
    expect(r).toMatch(/only where the response clearly refers to that item/);
  });

  it('stays inside the budget even when the prose answer is very long', () => {
    const r = buildRepairPrompt('x'.repeat(20_000), 'r'.repeat(2000), '{"opportunities":[]}', citable);
    expect(r.length).toBeLessThanOrEqual(config.promptCharBudget);
  });

  it('omits the id rules when there is nothing to cite', () => {
    expect(buildRepairPrompt('text', 'reason', '{}')).not.toContain('CITABLE IDS');
  });
});

describe('decision review prompt', () => {
  const review = buildDecisionReviewPrompt({
    previous,
    current: [1, 2, 3].map((i) => ({ label: `N${i}`, title: title(i), action: words(300, 'act'), why: words(300, 'why') })),
    learned: {
      outcomes: [{ id: 'out_1', outcomeType: 'no_response', opportunityTitle: title(1), notes: 'No reply after a week' }],
      knowledge: [{ id: 'kn_1', title: title(2) }],
      actions: [{ actionType: 'applied_to_program', opportunityTitle: title(1) }],
      newEvidence: [{ id: 'E2', title: 'Immutable extends its grants track', ageDays: 1 }],
    },
  });

  it('labels last-scan and current items so the answer can be validated', () => {
    expect(review).toMatch(/^- P1: /m);
    expect(review).toMatch(/^- N3: /m);
    expect(review).toContain('TASK_ID: decision_review');
  });

  it('lists what was learned, by id, for the reason to cite', () => {
    expect(review).toContain('- outcome out_1: no response on');
    expect(review).toContain('- saved research kn_1:');
    expect(review).toContain('- new article E2 (1d old)');
  });

  it('is short: a single-purpose prompt well inside the budget', () => {
    expect(review.length).toBeLessThan(config.promptCharBudget * 0.6);
  });

  it('says so when nothing was learned', () => {
    const empty = buildDecisionReviewPrompt({ previous, current: [], learned: { outcomes: [], knowledge: [], actions: [], newEvidence: [] } });
    expect(empty).toContain('- nothing new');
  });
});
