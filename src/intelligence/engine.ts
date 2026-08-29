import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { db, newId } from '../db/store.js';
import { log } from '../lib/logger.js';
import { ProviderError } from '../lib/errors.js';
import { getProvider } from '../providers/index.js';
import { track } from '../analytics.js';
import { parseStructured, parseWithRepair } from './parser.js';
import { deepResearchSchema, growthPlanSchema, memoryEnforcementSchema, opportunitySetSchema } from './schemas.js';
import {
  buildGrowthPrompt, buildMemoryEnforcementPrompt, buildOpportunityPrompt,
  buildRepairPrompt, buildResearchPrompt,
} from './prompts.js';
import { buildKultContext, hasPriorIntelligence } from './memory.js';
import { buildAgentSignalQuery, buildProjectSignalQuery } from './signals.js';
import { categorize } from '../lib/errors.js';
import type { Agent, CreatorProject, DeepResearch, GrowthPlan, Opportunity, Signal } from '../types.js';

const OPP_SHAPE = '{"opportunities":[{"title":"","relevance":0,"signal":"","why":"","opportunity":"","action":"","memoryInfluence":{"used":false,"knowledgeIds":[],"reason":""},"liveEvidence":{"used":false,"summary":"","evidenceTypes":[]}}]}';
const RESEARCH_SHAPE = '{"summary":"","whyNow":"","fitForAgent":"","liveEvidence":{"summary":"","items":[],"confidenceNote":""},"recommendedActions":[""],"targets":[""],"growthAngle":"","risks":[""]}';
const GROWTH_SHAPE = '{"opportunities":[{"title":"","relevance":0,"why":"","targets":[""],"growthAngle":"","action":""}],"campaignBrief":{"positioning":"","firstAction":""}}';

/**
 * VERIFIED LIVE: ChainGPT rejects a readable thread id with
 * "sdkUniqueId must be a UUID". Deep Research still needs the id to be STABLE
 * per Agent+opportunity so a follow-up lands in the same thread, so a v5-style
 * UUID is derived deterministically from the readable key rather than random.
 */
export function threadUuid(key: string): string {
  const h = createHash('sha1').update(key).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,   // version 5
    `${variant}${h.slice(18, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

/**
 * Reasoning with automatic prompt degradation.
 *
 * VERIFIED LIVE: a 7.6k-char prompt (12 rendered signals) drew a 504 HTML page
 * from ChainGPT's own gateway after ~81s. Rather than failing the whole scan, a
 * size-related failure is retried once with roughly half the signals.
 *
 * Only timeout / upstream_5xx are retried this way. Credit and auth failures
 * cannot be fixed by sending less, so they propagate untouched.
 */
async function reasonWithDegradation(
  build: (signalCount: number) => string,
  signalCount: number,
  options: Parameters<ReturnType<typeof getProvider>['reason']>[1],
  label: string,
): Promise<unknown> {
  const provider = getProvider();
  try {
    return await provider.reason(build(signalCount), options);
  } catch (err) {
    const e = categorize(err);
    if (e.category !== 'timeout' && e.category !== 'upstream_5xx') throw e;
    if (signalCount <= 2) throw e;

    const reduced = Math.max(2, Math.floor(signalCount / 2));
    log.warn('prompt_degraded_after_failure', { label, category: e.category, from: signalCount, to: reduced });
    return provider.reason(build(reduced), options);
  }
}

/** Builds the one-shot repair callback the parser uses on validation failure. */
function repairer(shape: string, label: string) {
  return async (badText: string, reason: string) =>
    getProvider().reason(buildRepairPrompt(badText, reason, shape), {
      chatHistory: 'off',
      useCustomContext: false,
      label: `${label}.repair`,
    });
}

// ------------------------------------------------------------- opportunities

export interface OpportunityRunResult {
  runId: string;
  provider: string;
  generatedAt: string;
  query: string;
  signalsUsed: number;
  usedKnowledgeIds: string[];
  isRepeatScan: boolean;
  opportunities: Opportunity[];
}

export async function generateOpportunities(
  agent: Agent,
  query?: string,
): Promise<OpportunityRunResult> {
  const provider = getProvider();
  const isRepeatScan = hasPriorIntelligence(agent.id);

  await track('opportunity_scan_started', { agentId: agent.id, metadata: { query, isRepeatScan } });
  if (isRepeatScan) await track('repeat_intelligence_scan', { agentId: agent.id });

  const focus = query?.trim() || [...agent.interests, ...agent.goals].join(' ');
  const ctx = buildKultContext(agent, focus);
  const contextKnowledgeIds = ctx.recentKnowledge.map((k) => k.id);

  const signalQuery = buildAgentSignalQuery(agent, query);
  let signals: Signal[] = [];
  try {
    signals = await provider.getSignals(signalQuery);
  } catch (err) {
    // Reasoning can still proceed on KULT context alone; the prompt says so.
    log.warn('signals_unavailable_continuing', { error: (err as Error).message });
  }

  const raw = await reasonWithDegradation(
    (n) => buildOpportunityPrompt(ctx, signals.slice(0, n), signalQuery.searchQuery),
    signals.length,
    {
      // Spec 11.6: discovery keeps history off - KULT injects canonical memory itself.
      chatHistory: 'off',
      useCustomContext: config.chaingpt.useCustomContext,
      label: 'opportunities',
    },
    'opportunities',
  );

  const parsed = await parseWithRepair(raw, opportunitySetSchema, repairer(OPP_SHAPE, 'opportunities'), 'opportunities', 'opportunities');

  const opportunities: Opportunity[] = parsed.opportunities.slice(0, 3).map((o) => {
    // Only trust knowledge ids we actually supplied; a hallucinated id must not
    // become a memory badge in the UI.
    const claimed = (o.memoryInfluence?.knowledgeIds ?? []).filter((id) => contextKnowledgeIds.includes(id));
    const used = Boolean(o.memoryInfluence?.used) && contextKnowledgeIds.length > 0;
    return {
      id: newId('opp'),
      title: o.title,
      relevance: Math.round(o.relevance),
      signal: o.signal,
      why: o.why,
      opportunity: o.opportunity,
      action: o.action,
      memoryInfluence: {
        used,
        // Fall back to the ids we injected when the model cites memory without naming them.
        knowledgeIds: used ? (claimed.length ? claimed : contextKnowledgeIds.slice(0, 2)) : [],
        reason: used ? (o.memoryInfluence?.reason ?? '') : '',
      },
      liveEvidence: o.liveEvidence,
    };
  });

  // Spec 8.2 (P0): a repeat scan MUST visibly build on saved knowledge. The live
  // model does not always honour the in-prompt directive, so one cheap targeted
  // revision is attempted before giving up on the showcase's key moment.
  if (contextKnowledgeIds.length > 0 && !opportunities.some((o) => o.memoryInfluence.used)) {
    await enforceMemoryInfluence(opportunities, ctx.recentKnowledge, agent.id);
  }

  const memoryInfluenced = opportunities.filter((o) => o.memoryInfluence.used);
  if (memoryInfluenced.length > 0) {
    await track('memory_influenced_result', {
      agentId: agent.id,
      metadata: { count: memoryInfluenced.length, knowledgeIds: memoryInfluenced.flatMap((o) => o.memoryInfluence.knowledgeIds) },
    });
  } else if (isRepeatScan) {
    log.warn('repeat_scan_without_memory_influence', { agentId: agent.id, knowledgeInContext: contextKnowledgeIds.length });
  }

  const runId = newId('run');
  await db.mutate((s) => {
    s.runs.push({
      id: runId,
      agentId: agent.id,
      query: signalQuery.searchQuery,
      provider: provider.name,
      signalIds: signals.map((sg) => sg.id),
      usedKnowledgeIds: contextKnowledgeIds,
      result: { opportunities },
      createdAt: new Date().toISOString(),
    });
  });

  await track('opportunity_scan_completed', {
    agentId: agent.id,
    metadata: { count: opportunities.length, signalsUsed: signals.length, memoryInfluenced: memoryInfluenced.length },
  });

  return {
    runId,
    provider: provider.name,
    generatedAt: new Date().toISOString(),
    query: signalQuery.searchQuery,
    signalsUsed: signals.length,
    usedKnowledgeIds: contextKnowledgeIds,
    isRepeatScan,
    opportunities,
  };
}

/**
 * Mutates the chosen opportunity in place to record the memory influence the
 * model missed. Failure is non-fatal: the scan still returns, and the UI already
 * says plainly when a repeat scan produced no memory influence.
 */
async function enforceMemoryInfluence(
  opportunities: Opportunity[],
  knowledge: { id: string; title: string; summary: string }[],
  agentId: string,
): Promise<void> {
  if (opportunities.length === 0 || knowledge.length === 0) return;

  try {
    const raw = await getProvider().reason(
      buildMemoryEnforcementPrompt(opportunities, knowledge),
      { chatHistory: 'off', useCustomContext: false, label: 'memory_enforcement' },
    );

    const parsed = parseStructured(raw, memoryEnforcementSchema);
    if (!parsed.ok) {
      log.warn('memory_enforcement_unparsable', { agentId, reason: parsed.reason });
      return;
    }

    const target = opportunities[parsed.data.index];
    if (!target) {
      log.warn('memory_enforcement_bad_index', { agentId, index: parsed.data.index });
      return;
    }

    // Same anti-hallucination rule as the main path: only ids we injected count.
    const validIds = knowledge.map((k) => k.id);
    const cited = parsed.data.knowledgeIds.filter((id) => validIds.includes(id));

    target.memoryInfluence = {
      used: true,
      knowledgeIds: cited.length > 0 ? cited : validIds.slice(0, 2),
      reason: parsed.data.reason,
    };
    log.info('memory_enforcement_applied', { agentId, index: parsed.data.index });
  } catch (err) {
    log.warn('memory_enforcement_failed', { agentId, error: (err as Error).message });
  }
}

// -------------------------------------------------------------- deep research

export async function generateDeepResearch(
  agent: Agent,
  opportunity: { id: string; title: string; signal: string; why: string; opportunity: string; action: string },
): Promise<{ provider: string; generatedAt: string; research: DeepResearch }> {
  const provider = getProvider();
  const ctx = buildKultContext(agent, `${opportunity.title} ${opportunity.why}`);

  let signals: Signal[] = [];
  try {
    signals = await provider.getSignals({
      // Two words max - the News API matches searchQuery as a literal phrase.
      searchQuery: opportunity.title.split(/\s+/).slice(0, 2).join(' '),
      fallbackQueries: ['AI gaming', 'web3 gaming', 'gaming'],
      limit: 5,
      fetchAfter: new Date(Date.now() - 14 * 86_400_000),
    });
  } catch (err) {
    log.warn('research_signals_unavailable', { error: (err as Error).message });
  }

  const raw = await reasonWithDegradation(
    (n) => buildResearchPrompt(ctx, opportunity, signals.slice(0, n)),
    signals.length,
    {
      // Spec 11.6: an isolated thread per Agent+opportunity, so follow-up research
      // has continuity without leaking across opportunities.
      chatHistory: 'on',
      sdkUniqueId: threadUuid(`kult:${agent.id}:research:${opportunity.id}`),
      useCustomContext: config.chaingpt.useCustomContext,
      label: 'research',
    },
    'research',
  );

  const research = await parseWithRepair(raw, deepResearchSchema, repairer(RESEARCH_SHAPE, 'research'), 'research');

  await track('deep_research_completed', {
    agentId: agent.id,
    metadata: { opportunityId: opportunity.id, evidenceItems: research.liveEvidence.items.length },
  });

  return { provider: provider.name, generatedAt: new Date().toISOString(), research };
}

// ------------------------------------------------------------- creator growth

export async function generateGrowthPlan(
  agent: Agent,
  project: CreatorProject,
): Promise<{ provider: string; generatedAt: string; growth: GrowthPlan }> {
  const provider = getProvider();
  const focus = `${project.title} ${project.tags.join(' ')} ${project.goals.join(' ')}`;
  const ctx = buildKultContext(agent, focus, project);

  let signals: Signal[] = [];
  try {
    signals = await provider.getSignals(buildProjectSignalQuery(project, agent));
  } catch (err) {
    log.warn('growth_signals_unavailable', { error: (err as Error).message });
  }

  const raw = await reasonWithDegradation(
    (n) => buildGrowthPrompt(ctx, signals.slice(0, n)),
    signals.length,
    { chatHistory: 'off', useCustomContext: config.chaingpt.useCustomContext, label: 'growth' },
    'growth',
  );

  const parsed = await parseWithRepair(raw, growthPlanSchema, repairer(GROWTH_SHAPE, 'growth'), 'growth', 'opportunities');

  const growth: GrowthPlan = {
    opportunities: parsed.opportunities.slice(0, 3).map((o) => ({
      id: newId('gopp'),
      title: o.title,
      relevance: Math.round(o.relevance),
      why: o.why,
      targets: o.targets,
      growthAngle: o.growthAngle,
      action: o.action,
    })),
    campaignBrief: parsed.campaignBrief,
  };

  await track('creator_growth_plan_generated', {
    agentId: agent.id,
    projectId: project.id,
    metadata: { count: growth.opportunities.length, signalsUsed: signals.length },
  });

  return { provider: provider.name, generatedAt: new Date().toISOString(), growth };
}

export { ProviderError };
