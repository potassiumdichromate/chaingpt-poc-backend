import { db, newId } from './db/store.js';
import { log } from './lib/logger.js';
import { currentContext } from './lib/requestContext.js';
import type { AnalyticsEvent, OpportunityRun, ProviderCallRecord } from './types.js';

/** Spec 16 event vocabulary. */
export type EventName =
  | 'intelligence_exposed'
  | 'opportunity_scan_started'
  | 'opportunity_scan_completed'
  | 'opportunity_opened'
  | 'deep_research_completed'
  | 'knowledge_saved'
  | 'repeat_intelligence_scan'
  | 'memory_influenced_result'
  | 'decision_delta_generated'
  | 'recommended_action_taken'
  | 'outcome_recorded'
  | 'creator_growth_plan_generated'
  | 'request_rate_limited'
  | 'intelligence_error';

export async function track(
  name: EventName,
  payload: { agentId?: string; projectId?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  const ctx = currentContext();
  const event: AnalyticsEvent = {
    id: newId('evt'),
    name,
    agentId: payload.agentId,
    projectId: payload.projectId,
    metadata: payload.metadata,
    ...(ctx?.clientId ? { clientId: ctx.clientId } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    timestamp: new Date().toISOString(),
  };
  try {
    await db.append('events', event);
    log.debug('analytics_event', { name, agentId: payload.agentId });
  } catch (err) {
    // Analytics must never break an intelligence request.
    log.warn('analytics_write_failed', { name, error: (err as Error).message });
  }
}

/** Records one provider call attempt. Never throws - accounting must not fail a scan. */
export async function recordProviderCall(
  call: Omit<ProviderCallRecord, 'id' | 'at' | 'agentId' | 'clientId'>,
): Promise<void> {
  const ctx = currentContext();
  const record: ProviderCallRecord = {
    id: newId('call'),
    ...call,
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.clientId ? { clientId: ctx.clientId } : {}),
    at: new Date().toISOString(),
  };
  try {
    await db.append('providerCalls', record);
  } catch (err) {
    log.warn('provider_call_record_failed', { label: call.label, error: (err as Error).message });
  }
}

const POSITIVE_OUTCOMES = new Set(['conversation_started', 'partnership_opportunity', 'campaign_launched', 'players_acquired']);

type RunOpportunity = {
  id?: string;
  memoryInfluence?: { used?: boolean };
  provenance?: { knowledge?: unknown[]; outcomes?: unknown[] };
};

function runOpportunities(r: OpportunityRun): RunOpportunity[] {
  return (r.result as { opportunities?: RunOpportunity[] })?.opportunities ?? [];
}

const rate = (num: number, den: number) => (den > 0 ? Number((num / den).toFixed(3)) : 0);

/** Spec 16.1 KPIs. Volume of API calls is deliberately not treated as success. */
export function computeMetrics() {
  const s = db.read();
  const count = (n: EventName) => s.events.filter((e) => e.name === n).length;

  const surfaced = s.runs.flatMap(runOpportunities);
  const surfacedIds = new Set(surfaced.map((o) => o.id).filter(Boolean));

  // "Acted on" counts distinct recommendations, not clicks: three actions on one
  // card are one recommendation acted on. Dismissals are not action.
  const actedOn = new Set(
    s.actions.filter((a) => a.actionType !== 'dismissed').map((a) => a.opportunityId),
  );
  const actionsWithOutcome = new Set(s.outcomes.map((o) => o.actionId));
  const recsWithOutcome = new Set(
    s.actions.filter((a) => actionsWithOutcome.has(a.id)).map((a) => a.opportunityId),
  );

  const deltas = s.runs.map((r) => r.decisionDelta).filter((d): d is NonNullable<typeof d> => Boolean(d));
  const memoryInformed = s.runs.filter((r) => runOpportunities(r).some((o) =>
    o.memoryInfluence?.used || (o.provenance?.knowledge?.length ?? 0) > 0 || (o.provenance?.outcomes?.length ?? 0) > 0,
  ));

  const chaingpt = s.providerCalls.filter((c) => c.provider === 'chaingpt');

  return {
    uniqueAgentsUsingIntelligence: new Set(s.events.filter((e) => e.agentId).map((e) => e.agentId)).size,
    uniqueClients: new Set(s.events.filter((e) => e.clientId).map((e) => e.clientId)).size,
    uniqueAuthenticatedUsers: new Set(s.events.filter((e) => e.userId).map((e) => e.userId)).size,

    chaingptCalls: chaingpt.length,
    chaingptNewsCalls: chaingpt.filter((c) => c.kind === 'news').length,
    chaingptChatCalls: chaingpt.filter((c) => c.kind === 'chat').length,
    chaingptFailedCalls: chaingpt.filter((c) => !c.ok).length,
    estimatedCreditsSpent: Number(chaingpt.reduce((acc, c) => acc + c.estimatedCredits, 0).toFixed(2)),

    opportunityScans: count('opportunity_scan_completed'),
    repeatIntelligenceScans: count('repeat_intelligence_scan'),
    deepResearchSessions: count('deep_research_completed'),
    savedKnowledgeItems: s.knowledge.length,
    memoryInfluencedRecommendations: count('memory_influenced_result'),
    memoryInformedScans: memoryInformed.length,

    decisionDeltas: deltas.length,
    decisionsKept: deltas.reduce((acc, d) => acc + d.counts.kept, 0),
    decisionsChanged: deltas.reduce((acc, d) => acc + d.counts.changed, 0),
    decisionsDropped: deltas.reduce((acc, d) => acc + d.counts.dropped, 0),

    creatorGrowthPlans: count('creator_growth_plan_generated'),
    recommendationsSurfaced: surfacedIds.size || surfaced.length,
    recommendationsActedOn: actedOn.size,
    recommendedActionsTaken: count('recommended_action_taken'),
    recordedOutcomes: s.outcomes.length,
    positiveOutcomes: s.outcomes.filter((o) => POSITIVE_OUTCOMES.has(o.outcomeType)).length,

    recommendationToActionRate: rate(actedOn.size, surfacedIds.size || surfaced.length),
    recommendationToOutcomeRate: rate(recsWithOutcome.size, surfacedIds.size || surfaced.length),
    actionToOutcomeRate: rate(
      s.actions.filter((a) => actionsWithOutcome.has(a.id)).length,
      s.actions.length,
    ),

    rateLimitedRequests: count('request_rate_limited'),
    errors: count('intelligence_error'),
    totalEvents: s.events.length,
  };
}

export function recentEvents(limit = 60) {
  return [...db.read().events].reverse().slice(0, limit);
}
