import { db } from '../db/store.js';
import { knowledgeRef, outcomeRef, tokenize } from './memory.js';
import type {
  ActionRecord, DecisionDelta, DecisionStatus, EvidenceRef, Opportunity, OpportunityDecision,
  OpportunityRun, OutcomeRef,
} from '../types.js';

/**
 * Decision Delta - previous recommendation -> new evidence learned -> what changed
 * -> why the Agent changed or kept its decision.
 *
 * The split of responsibility is deliberate:
 *   - WHAT was learned since the last scan (new articles, saved research, actions,
 *     outcomes) is computed here from stored data. The model cannot invent it.
 *   - WHICH previous recommendation each new one continues is proposed by the
 *     model (by P-label) and validated here; unknown labels are discarded.
 *   - WHY is the model's explanation, shown as such. When the model gives none,
 *     the UI says so instead of making one up.
 */

export interface PreviousRecommendation {
  label: string;
  id: string;
  title: string;
  action: string;
  signal: string;
  actions: ActionRecord[];
  outcomes: OutcomeRef[];
}

export function previousRecommendations(run: OpportunityRun | undefined): PreviousRecommendation[] {
  if (!run) return [];
  const s = db.read();
  const opps = (run.result as { opportunities?: Opportunity[] })?.opportunities ?? [];
  return opps.map((o, i) => {
    const actions = s.actions.filter((a) => a.opportunityId === o.id);
    const actionIds = new Set(actions.map((a) => a.id));
    return {
      label: `P${i + 1}`,
      id: o.id,
      title: o.title,
      action: o.action,
      signal: o.signal,
      actions,
      outcomes: s.outcomes.filter((x) => actionIds.has(x.actionId)).map(outcomeRef),
    };
  });
}

function jaccard(a: string, b: string): number {
  const x = tokenize(a);
  const y = tokenize(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return inter / (x.size + y.size - inter);
}

/** Near-identical titles are the same recommendation even if the model forgot to say so. */
const SAME_TITLE = 0.6;

export interface RawDecision {
  status?: string;
  previousId?: string;
  reason?: string;
}

export function resolveDecision(
  raw: RawDecision | undefined,
  title: string,
  previous: PreviousRecommendation[],
): OpportunityDecision {
  const reason = raw?.reason?.trim() ?? '';
  const prev = previous.find((p) => p.label === raw?.previousId?.trim());
  const status = raw?.status as DecisionStatus | undefined;

  if (prev && (status === 'kept' || status === 'changed')) {
    return {
      status, previousLabel: prev.label, previousOpportunityId: prev.id, previousTitle: prev.title,
      reason, attribution: 'model',
    };
  }
  if (status === 'new' && reason) return { status: 'new', reason, attribution: 'model' };

  // No valid link from the model: fall back to an explicit, labelled title match.
  const best = previous
    .map((p) => ({ p, score: jaccard(title, p.title) }))
    .sort((a, b) => b.score - a.score)[0];
  if (best && best.score >= SAME_TITLE) {
    return {
      status: 'kept', previousLabel: best.p.label, previousOpportunityId: best.p.id, previousTitle: best.p.title,
      reason, attribution: 'matched',
    };
  }
  return { status: 'new', reason, attribution: reason ? 'model' : 'none' };
}

function sinceText(fromIso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 60_000));
  if (mins < 1) return 'moments ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const OUTCOME_TEXT: Record<string, string> = {
  no_response: 'no response', not_relevant: 'not relevant', conversation_started: 'conversation started',
  partnership_opportunity: 'partnership opportunity', campaign_launched: 'campaign launched',
  players_acquired: 'players acquired', other: 'other',
};

export function buildDecisionDelta(input: {
  previousRun: OpportunityRun;
  previous: PreviousRecommendation[];
  opportunities: Opportunity[];
  evidence: EvidenceRef[];
  rawDropped: { previousId?: string; reason?: string }[];
  now?: number;
}): DecisionDelta {
  const { previousRun, previous, opportunities, evidence, rawDropped } = input;
  const s = db.read();
  const after = (iso: string) => iso > previousRun.createdAt;
  const agentId = previousRun.agentId;

  const knowledge = s.knowledge.filter((k) => k.agentId === agentId && after(k.createdAt)).map(knowledgeRef);
  const actions = s.actions
    .filter((a) => a.agentId === agentId && after(a.createdAt))
    .map((a) => ({ id: a.id, opportunityTitle: a.opportunityTitle, actionType: a.actionType, createdAt: a.createdAt }));
  const outcomes = s.outcomes.filter((o) => o.agentId === agentId && after(o.createdAt)).map(outcomeRef);
  const newEvidence = evidence.filter((e) => e.seenBefore === false);

  const decisions = opportunities.map((o) => ({
    opportunityId: o.id,
    title: o.title,
    ...(o.decision ?? { status: 'new' as const, reason: '', attribution: 'none' as const }),
  }));

  const continued = new Set(decisions.filter((d) => d.status !== 'new').map((d) => d.previousLabel));
  const dropped = previous
    .filter((p) => !continued.has(p.label))
    .map((p) => {
      const stated = rawDropped.find((d) => d.previousId?.trim() === p.label && d.reason?.trim());
      if (stated) {
        return { previousLabel: p.label, opportunityId: p.id, title: p.title, reason: stated.reason!.trim(), attribution: 'model' as const };
      }
      const outcome = p.outcomes[0];
      const dismissed = p.actions.some((a) => a.actionType === 'dismissed');
      const reason = outcome
        ? `Outcome recorded: ${OUTCOME_TEXT[outcome.outcomeType] ?? outcome.outcomeType}.`
        : dismissed ? 'Dismissed by the Agent.' : 'Not carried forward in this scan.';
      return { previousLabel: p.label, opportunityId: p.id, title: p.title, reason, attribution: 'derived' as const };
    });

  const counts = {
    kept: decisions.filter((d) => d.status === 'kept').length,
    changed: decisions.filter((d) => d.status === 'changed').length,
    new: decisions.filter((d) => d.status === 'new').length,
    dropped: dropped.length,
  };

  const learnedParts = [
    outcomes.length ? plural(outcomes.length, 'outcome') : '',
    knowledge.length ? plural(knowledge.length, 'saved research item') : '',
    actions.length ? plural(actions.length, 'action') : '',
    newEvidence.length ? plural(newEvidence.length, 'new ChainGPT article') : '',
  ].filter(Boolean);
  const when = sinceText(previousRun.createdAt, input.now);
  const learned = learnedParts.length
    ? `Since the last scan ${when}, the Agent learned ${learnedParts.join(', ')}.`
    : `Nothing new since the last scan ${when}: no new outcomes or research, and no new ChainGPT articles.`;
  const changedParts = [
    counts.kept ? `kept ${counts.kept}` : '',
    counts.changed ? `changed ${counts.changed}` : '',
    counts.new ? `added ${counts.new}` : '',
    counts.dropped ? `dropped ${counts.dropped}` : '',
  ].filter(Boolean);

  return {
    previousRunId: previousRun.id,
    previousRunAt: previousRun.createdAt,
    learned: { newEvidence, repeatedEvidence: evidence.length - newEvidence.length, knowledge, actions, outcomes },
    decisions,
    dropped,
    counts,
    summary: `${learned} Decisions: ${changedParts.join(', ') || 'none'}.`,
  };
}
