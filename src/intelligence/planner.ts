import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { toEvidenceRef } from './evidence.js';
import { retrieveSignals, type FetchMemo, type SignalResult } from './retrieval.js';
import {
  COVERAGE_PHRASES, FALLBACK_PHRASES, SIGNAL_LIMIT, preferredDomainOrder, salientPhrases,
} from './signals.js';
import type {
  Agent, EvidenceNeed, EvidenceNeedResult, EvidencePlan, EvidenceRef, Opportunity, OpportunityRun, OutcomeRef,
} from '../types.js';

/**
 * Evidence Planner - the Agent decides what live ChainGPT intelligence it needs
 * BEFORE reasoning, then retrieves only that.
 *
 * Deliberately rule-based rather than an extra LLM call: a ChainGPT reasoning call
 * takes 20-80s and costs credits, and the News API only matches short literal
 * phrases, so a model-written query would mostly return zero rows. The rules read
 * KULT memory - the latest outcome, the previous recommendation, the Agent's goal -
 * and turn each into one question with searchable phrases. Every need says WHY it
 * exists, and the UI shows the plan, so the Agent's reasoning about what to look up
 * is visible rather than implied.
 */

const MAX_NEEDS = 3;

export interface PlannerInput {
  agent: Agent;
  /** Explicit focus from the user; always planned first. */
  query?: string;
  previousRun?: OpportunityRun;
  /** Outcomes recorded since the previous scan, newest first. */
  newOutcomes: OutcomeRef[];
}

type PrevOpportunity = Pick<Opportunity, 'id' | 'title' | 'signal'>;

function previousOpportunities(run?: OpportunityRun): PrevOpportunity[] {
  return ((run?.result as { opportunities?: PrevOpportunity[] })?.opportunities ?? []).filter((o) => o?.title);
}

const OUTCOME_LABEL: Record<string, string> = {
  no_response: 'no response',
  not_relevant: 'not relevant',
  conversation_started: 'conversation started',
  partnership_opportunity: 'partnership opportunity',
  campaign_launched: 'campaign launched',
  players_acquired: 'players acquired',
  other: 'other outcome',
};

function outcomeNeed(outcome: OutcomeRef, prev: PrevOpportunity[], domain: string[]): Omit<EvidenceNeed, 'id' | 'quota'> {
  const title = outcome.opportunityTitle ?? 'the last recommendation';
  const source = prev.find((p) => p.title === outcome.opportunityTitle);
  const entities = salientPhrases(`${title} | ${source?.signal ?? ''}`);
  const label = OUTCOME_LABEL[outcome.outcomeType] ?? outcome.outcomeType;
  const triggerRef = { kind: 'outcome' as const, id: outcome.id, label: `${label} on "${title}"` };

  switch (outcome.outcomeType) {
    case 'no_response':
    case 'not_relevant':
      return {
        trigger: 'outcome', triggerRef,
        question: `What alternatives to "${title}" are open right now?`,
        reason: `The last action on it ended in "${label}", so the Agent looks for other routes instead of repeating it.`,
        phrases: domain.filter((d) => !entities.some((e) => e.toLowerCase() === d.toLowerCase())).slice(0, 3),
      };
    case 'conversation_started':
    case 'partnership_opportunity':
      return {
        trigger: 'outcome', triggerRef,
        question: `What is current around ${entities[0] ?? `"${title}"`} to support the follow-up?`,
        reason: `The last action produced "${label}", so the Agent looks for news it can use in the next conversation.`,
        phrases: [...entities, ...domain].slice(0, 3),
      };
    case 'campaign_launched':
    case 'players_acquired':
      return {
        trigger: 'outcome', triggerRef,
        question: `Where can the "${label}" result on "${title}" be amplified?`,
        reason: `"${label}" is a result worth building on, so the Agent looks for distribution channels.`,
        phrases: ['web3 gaming', 'GameFi', 'gaming'],
      };
    default:
      return {
        trigger: 'outcome', triggerRef,
        question: `Has anything changed around "${title}"?`,
        reason: 'An outcome was recorded on it since the last scan, so the Agent re-checks the situation.',
        phrases: [...entities, ...domain].slice(0, 3),
      };
  }
}

/** Builds the plan. Pure and deterministic, so it is unit-testable without a provider. */
export function planAgentEvidence(input: PlannerInput): EvidenceNeed[] {
  const { agent, query, previousRun, newOutcomes } = input;
  const domain = preferredDomainOrder([...agent.interests, ...agent.goals]);
  const prev = previousOpportunities(previousRun);
  const drafts: Omit<EvidenceNeed, 'id' | 'quota'>[] = [];

  if (query?.trim()) {
    const phrase = query.trim().split(/[\s,]+/).slice(0, 2).join(' ');
    drafts.push({
      trigger: 'user_focus',
      triggerRef: { kind: 'query', label: query.trim() },
      question: `What is happening around "${query.trim()}" right now?`,
      reason: 'You asked the Agent to focus on this.',
      phrases: [phrase, ...salientPhrases(query), domain[0]!],
    });
  }

  const latestOutcome = newOutcomes[0];
  if (latestOutcome) drafts.push(outcomeNeed(latestOutcome, prev, domain));

  // Re-check the previous top recommendation unless an outcome already covers it.
  const top = prev.find((p) => p.title !== latestOutcome?.opportunityTitle);
  if (top && previousRun) {
    drafts.push({
      trigger: 'previous_recommendation',
      triggerRef: { kind: 'opportunity', id: top.id, label: top.title },
      question: `Does the premise of "${top.title}" still hold?`,
      reason: 'It was a leading recommendation last scan; the Agent re-checks it before keeping or changing it.',
      phrases: [...salientPhrases(`${top.title} | ${top.signal ?? ''}`), ...domain].slice(0, 3),
    });
  }

  const goal = agent.goals[0];
  drafts.push({
    trigger: 'goal',
    triggerRef: { kind: 'goal', label: goal ?? 'current interests' },
    question: goal ? `What new openings match the goal "${goal}"?` : 'What new openings match this Agent\'s interests?',
    reason: `Current Agent goal, ranked by its interests (${agent.interests.slice(0, 3).join(', ') || 'none recorded'}).`,
    phrases: domain.slice(0, 3),
    ...(config.news.categoryIds.length ? { categoryIds: config.news.categoryIds } : {}),
  });

  drafts.push({
    trigger: 'coverage',
    question: 'What is current across AI and Web3 right now?',
    reason: 'Broad coverage, so the scan is not blind when narrower phrases only find old news.',
    phrases: COVERAGE_PHRASES,
  });

  // Keep the first MAX_NEEDS distinct needs; a need whose lead phrase another need
  // already searches would only fetch the same articles again.
  const used = new Set<string>();
  const needs: Omit<EvidenceNeed, 'id' | 'quota'>[] = [];
  for (const d of drafts) {
    const phrases = d.phrases.filter((p, i, all) => p && all.indexOf(p) === i && !used.has(p.toLowerCase()));
    if (phrases.length === 0) continue;
    used.add(phrases[0]!.toLowerCase());
    needs.push({ ...d, phrases });
    if (needs.length === MAX_NEEDS) break;
  }

  const quota = Math.max(1, Math.floor(SIGNAL_LIMIT / needs.length));
  return needs.map((n, i) => ({ ...n, id: `N${i + 1}`, quota }));
}

/** Deep research has one need: fresh evidence on the specific opportunity. */
export function planResearchEvidence(opportunity: { title: string; signal: string }): EvidenceNeed[] {
  const entities = salientPhrases(`${opportunity.title} | ${opportunity.signal}`);
  return [{
    id: 'N1',
    trigger: 'opportunity',
    triggerRef: { kind: 'opportunity', label: opportunity.title },
    question: `What is current around "${opportunity.title}"?`,
    reason: 'Deep research needs evidence on this specific opportunity, not the general feed.',
    phrases: [...entities, 'AI gaming', 'web3 gaming', ...FALLBACK_PHRASES].filter((p, i, a) => a.indexOf(p) === i).slice(0, 4),
    quota: 5,
  }];
}

export interface ExecutedPlan {
  plan: EvidencePlan;
  evidence: EvidenceRef[];
  relaxedNeeds: number;
}

/**
 * Retrieves each need's evidence, de-duplicates articles across needs, and gives
 * every article a stable prompt id (E1, E2, ...) the model must cite.
 */
export async function executePlan(
  needs: EvidenceNeed[],
  opts: { bypassCache?: boolean; idPrefix?: string; previousSignalIds?: string[]; label?: string } = {},
): Promise<ExecutedPlan> {
  const windowDays = config.news.freshnessDays;
  const prefix = opts.idPrefix ?? 'E';
  const seenBefore = new Set(opts.previousSignalIds ?? []);

  const memo: FetchMemo = new Map();
  const results = await Promise.all(needs.map(async (need): Promise<SignalResult | null> => {
    try {
      return await retrieveSignals({
        phrases: need.phrases,
        // One request size for every need, so identical searches are shared via
        // the memo, with headroom for articles another need already claimed.
        limit: SIGNAL_LIMIT,
        categoryId: need.categoryIds,
        freshnessDays: windowDays,
        bypassCache: opts.bypassCache,
        label: opts.label ?? 'chaingpt.news',
      }, memo);
    } catch (err) {
      // One need failing must not sink the others; the plan records the failure.
      log.warn('evidence_need_failed', { need: need.id, error: (err as Error).message });
      return null;
    }
  }));

  const claimed = new Set<string>();
  const evidence: EvidenceRef[] = [];
  const planned: EvidenceNeedResult[] = needs.map((need, i) => {
    const r = results[i];
    const ids: string[] = [];
    for (const s of r?.signals ?? []) {
      if (ids.length >= need.quota) break;
      if (claimed.has(s.id)) continue;
      claimed.add(s.id);
      const ref = toEvidenceRef(s, `${prefix}${evidence.length + 1}`, windowDays, {
        needId: need.id,
        ...(opts.previousSignalIds ? { seenBefore: seenBefore.has(s.id) } : {}),
      });
      evidence.push(ref);
      ids.push(ref.id);
    }
    return {
      ...need,
      usedPhrase: r?.usedPhrase ?? null,
      evidenceIds: ids,
      status: !r ? 'failed' : r.signals.length === 0 ? 'none' : r.relaxedFreshness ? 'stale_only' : 'fresh',
      newestAgeDays: r?.newestAgeDays ?? null,
    };
  });

  return {
    plan: { strategy: 'rules', windowDays, needs: planned },
    evidence,
    relaxedNeeds: planned.filter((n) => n.status === 'stale_only').length,
  };
}
