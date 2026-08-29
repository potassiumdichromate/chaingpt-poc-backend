import { db, newId } from './db/store.js';
import { log } from './lib/logger.js';
import type { AnalyticsEvent } from './types.js';

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
  | 'recommended_action_taken'
  | 'outcome_recorded'
  | 'creator_growth_plan_generated'
  | 'intelligence_error';

export async function track(
  name: EventName,
  payload: { agentId?: string; projectId?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  const event: AnalyticsEvent = {
    id: newId('evt'),
    name,
    agentId: payload.agentId,
    projectId: payload.projectId,
    metadata: payload.metadata,
    timestamp: new Date().toISOString(),
  };
  try {
    await db.mutate((s) => { s.events.push(event); });
    log.debug('analytics_event', { name, agentId: payload.agentId });
  } catch (err) {
    // Analytics must never break an intelligence request.
    log.warn('analytics_write_failed', { name, error: (err as Error).message });
  }
}

/** Spec 16.1 KPIs. Volume of API calls is deliberately not treated as success. */
export function computeMetrics() {
  const s = db.read();
  const count = (n: EventName) => s.events.filter((e) => e.name === n).length;

  const scans = count('opportunity_scan_completed');
  const actions = count('recommended_action_taken');
  const opportunitiesSurfaced = s.runs.reduce(
    (acc, r) => acc + ((r.result as { opportunities?: unknown[] })?.opportunities?.length ?? 0),
    0,
  );

  return {
    uniqueAgentsUsingIntelligence: new Set(s.events.filter((e) => e.agentId).map((e) => e.agentId)).size,
    opportunityScans: scans,
    deepResearchSessions: count('deep_research_completed'),
    savedKnowledgeItems: s.knowledge.length,
    repeatIntelligenceScans: count('repeat_intelligence_scan'),
    memoryInfluencedRecommendations: count('memory_influenced_result'),
    creatorGrowthPlans: count('creator_growth_plan_generated'),
    recommendedActionsTaken: actions,
    recordedOutcomes: s.outcomes.length,
    recommendationToActionRate:
      opportunitiesSurfaced > 0 ? Number((actions / opportunitiesSurfaced).toFixed(3)) : 0,
    errors: count('intelligence_error'),
    totalEvents: s.events.length,
  };
}

export function recentEvents(limit = 60): AnalyticsEvent[] {
  return [...db.read().events].reverse().slice(0, limit);
}
