import { config } from '../config.js';
import { newId } from '../db/store.js';
import { log } from '../lib/logger.js';
import { ProviderError, categorize } from '../lib/errors.js';
import { setContextAgent } from '../lib/requestContext.js';
import { getProvider } from '../providers/index.js';
import { track } from '../analytics.js';
import { parseStructured, parseWithRepair } from './parser.js';
import { decisionReviewSchema, deepResearchSchema, growthPlanSchema, opportunitySetSchema } from './schemas.js';
import {
  DETAIL_LEVELS, buildDecisionReviewPrompt, buildGrowthPrompt, buildOpportunityPrompt, buildRepairPrompt,
  buildResearchPrompt, contextAtDetail, renderCitableIds, type PromptDetail,
} from './prompts.js';
import {
  buildKultContext, hasPriorIntelligence, knowledgeRef, latestRun, memorySince, outcomeRef, saveRun,
  selectRecentOutcomes,
} from './memory.js';
import { executePlan, planAgentEvidence, planResearchEvidence } from './planner.js';
import { attributeEvidence, scoreConfidence, summarizeQuality, toEvidenceRef } from './evidence.js';
import {
  buildDecisionDelta, previousRecommendations, resolveDecision, type PreviousRecommendation,
} from './decisions.js';
import { retrieveSignals } from './retrieval.js';
import { SIGNAL_LIMIT, buildProjectSignalQuery } from './signals.js';
import type {
  Agent, CreatorProject, DecisionDelta, DeepResearch, EvidencePlan, EvidenceQuality, EvidenceRef,
  GrowthPlan, Opportunity, OpportunityDecision, Provenance,
} from '../types.js';

/** Shown instead of a fabricated source when AI News returned nothing. */
const NO_SIGNAL_NOTE = 'No current news signal - derived from your KULT profile.';

const OPP_SHAPE = '{"opportunities":[{"title":"","relevance":0,"signal":"","why":"","opportunity":"","action":"","evidenceIds":[],"outcomeIds":[],"memoryInfluence":{"used":false,"knowledgeIds":[],"reason":""},"liveEvidence":{"used":false,"summary":"","evidenceTypes":[]}}]}';
const RESEARCH_SHAPE = '{"summary":"","whyNow":"","fitForAgent":"","liveEvidence":{"summary":"","items":[{"type":"news","evidence":"","sourceLabel":"","evidenceId":""}],"confidenceNote":""},"recommendedActions":[""],"targets":[""],"growthAngle":"","risks":[""]}';
const GROWTH_SHAPE = '{"opportunities":[{"title":"","relevance":0,"why":"","targets":[""],"growthAngle":"","action":""}],"campaignBrief":{"positioning":"","firstAction":""}}';

/**
 * Fits a prompt to the character budget BEFORE sending it. VERIFIED LIVE: at ~6k
 * chars ChainGPT stopped reading the question in full (a canary test found none of
 * five markers), and ~7.6k drew a gateway 504. Text is compacted first (memory
 * summaries, notes, article summaries, the plan - see DETAIL_LEVELS); evidence is
 * dropped only once the most compact level still does not fit, never below two.
 */
function fitToBudget(
  build: (n: number, d: PromptDetail) => string,
  available: number,
  label: string,
): { n: number; detail: PromptDetail } {
  const budget = config.promptCharBudget;
  let level = 0;
  while (level < DETAIL_LEVELS.length - 1 && build(available, DETAIL_LEVELS[level]!).length > budget) level += 1;
  const detail = DETAIL_LEVELS[level]!;

  let n = available;
  while (n > 2 && build(n, detail).length > budget) n -= 1;

  const chars = build(n, detail).length;
  (chars > budget ? log.warn : log.info)('prompt_built', { label, chars, budget, level, evidence: n, available });
  return { n, detail };
}

/**
 * Reasoning with automatic prompt degradation. A size-related failure (timeout,
 * 5xx) is retried once with roughly half the evidence. Credit and auth failures
 * cannot be fixed by sending less, so they propagate untouched. Returns how much
 * evidence the successful prompt carried, so only ids the model saw are citable.
 */
async function reasonWithDegradation(
  build: (evidenceCount: number) => string,
  evidenceCount: number,
  options: Parameters<ReturnType<typeof getProvider>['reason']>[1],
  label: string,
): Promise<{ raw: unknown; shown: number }> {
  const provider = getProvider();
  try {
    return { raw: await provider.reason(build(evidenceCount), options), shown: evidenceCount };
  } catch (err) {
    const e = categorize(err);
    if (e.category !== 'timeout' && e.category !== 'upstream_5xx') throw e;
    if (evidenceCount <= 2) throw e;

    const reduced = Math.max(2, Math.floor(evidenceCount / 2));
    log.warn('prompt_degraded_after_failure', { label, category: e.category, from: evidenceCount, to: reduced });
    return { raw: await provider.reason(build(reduced), options), shown: reduced };
  }
}

/**
 * Builds the one-shot repair callback the parser uses on validation failure.
 * VERIFIED LIVE: the first answer is usually prose, so this is the common path;
 * `citable` lets it recover which evidence and memory the prose referred to.
 */
function repairer(shape: string, label: string, citable?: () => string) {
  return async (badText: string, reason: string) =>
    getProvider().reason(buildRepairPrompt(badText, reason, shape, citable?.()), {
      chatHistory: 'off',
      useCustomContext: false,
      label: `${label}.repair`,
    });
}

/** Keeps a plan consistent with the evidence that actually reached the model. */
function restrictPlan(plan: EvidencePlan, shown: EvidenceRef[]): EvidencePlan {
  const ids = new Set(shown.map((e) => e.id));
  return { ...plan, needs: plan.needs.map((n) => ({ ...n, evidenceIds: n.evidenceIds.filter((id) => ids.has(id)) })) };
}

// ------------------------------------------------------------- opportunities

export interface OpportunityRunResult {
  runId: string;
  provider: string;
  generatedAt: string;
  query: string;
  signalsUsed: number;
  usedKnowledgeIds: string[];
  usedOutcomeIds: string[];
  isRepeatScan: boolean;
  opportunities: Opportunity[];
  plan: EvidencePlan;
  evidence: EvidenceRef[];
  evidenceQuality: EvidenceQuality;
  previousRunId: string | null;
  decisionDelta: DecisionDelta | null;
}

export async function generateOpportunities(
  agent: Agent,
  opts: { query?: string; forceFreshSignals?: boolean } = {},
): Promise<OpportunityRunResult> {
  const provider = getProvider();
  setContextAgent(agent.id);

  const previousRun = latestRun(agent.id);
  const isRepeatScan = Boolean(previousRun) || hasPriorIntelligence(agent.id);
  await track('opportunity_scan_started', { agentId: agent.id, metadata: { query: opts.query, isRepeatScan } });
  if (isRepeatScan) await track('repeat_intelligence_scan', { agentId: agent.id });

  // 1. Plan: decide what live intelligence is needed, from KULT memory.
  const newOutcomes = previousRun
    ? memorySince(agent.id, previousRun.createdAt).outcomes.map(outcomeRef).reverse()
    : selectRecentOutcomes(agent.id).map(outcomeRef);
  const needs = planAgentEvidence({ agent, query: opts.query, previousRun, newOutcomes });

  // 2. Retrieve only that evidence.
  const executed = await executePlan(needs, {
    bypassCache: opts.forceFreshSignals,
    previousSignalIds: previousRun?.signalIds,
    label: 'chaingpt.news.scan',
  });

  const focus = opts.query?.trim() || [...agent.interests, ...agent.goals].join(' ');
  const fullCtx = buildKultContext(agent, focus);
  const previous = previousRecommendations(previousRun);
  const previousWhen = previousRun ? new Date(previousRun.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';

  // 3. Reason over it.
  const build = (n: number, detail: PromptDetail) => buildOpportunityPrompt({
    ctx: fullCtx, needs: executed.plan.needs, evidence: executed.evidence.slice(0, n), focus: opts.query?.trim(),
    windowDays: executed.plan.windowDays, previous, previousWhen, detail,
  });
  const fitted = fitToBudget(build, executed.evidence.length, 'opportunities');
  // Only the memory that fit into the prompt can be cited.
  const ctx = contextAtDetail(fullCtx, fitted.detail);
  const { raw, shown } = await reasonWithDegradation((n) => build(n, fitted.detail), fitted.n, {
    // KULT injects canonical memory itself; ChainGPT holds no conversation state.
    chatHistory: 'off',
    useCustomContext: config.chaingpt.useCustomContext,
    label: 'opportunities',
  }, 'opportunities');

  // 4. Validate everything the model claims against what it was actually shown.
  const evidence = executed.evidence.slice(0, shown);
  const citable = () => renderCitableIds([
    ...evidence.map((e) => ({ id: e.id, label: e.title })),
    ...ctx.recentOutcomes.map((o) => ({ id: o.id, label: `outcome ${o.outcomeType.replace(/_/g, ' ')} on ${o.opportunityTitle ?? 'a recommendation'}` })),
    ...ctx.recentKnowledge.map((k) => ({ id: k.id, label: `saved research: ${k.title}` })),
  ]);
  const parsed = await parseWithRepair(raw, opportunitySetSchema, repairer(OPP_SHAPE, 'opportunities', citable), 'opportunities', 'opportunities');
  const contextKnowledgeIds = ctx.recentKnowledge.map((k) => k.id);
  const contextOutcomeIds = ctx.recentOutcomes.map((o) => o.id);

  const opportunities: Opportunity[] = parsed.opportunities.slice(0, 3).map((o) => {
    // A hallucinated id must never become a memory badge or a source in the UI.
    const claimed = (o.memoryInfluence?.knowledgeIds ?? []).filter((id) => contextKnowledgeIds.includes(id));
    const used = Boolean(o.memoryInfluence?.used) && contextKnowledgeIds.length > 0;
    const knowledgeIds = used ? (claimed.length ? claimed : contextKnowledgeIds.slice(0, 2)) : [];
    const outcomeIds = o.outcomeIds.filter((id) => contextOutcomeIds.includes(id));

    const provenance: Provenance = {
      evidence: attributeEvidence(o.evidenceIds, evidence, `${o.title} ${o.signal} ${o.why} ${o.opportunity}`),
      knowledge: ctx.recentKnowledge.filter((k) => knowledgeIds.includes(k.id)).map(knowledgeRef),
      outcomes: ctx.recentOutcomes.filter((x) => outcomeIds.includes(x.id)),
    };

    return {
      id: newId('opp'),
      title: o.title,
      relevance: Math.round(o.relevance),
      // Spec 15.4: when there was no external signal, say so plainly rather than
      // leaving a blank field the UI would render as a missing source.
      signal: o.signal?.trim() || NO_SIGNAL_NOTE,
      why: o.why,
      opportunity: o.opportunity,
      action: o.action,
      memoryInfluence: { used, knowledgeIds, reason: used ? (o.memoryInfluence?.reason ?? '') : '' },
      liveEvidence: o.liveEvidence,
      provenance,
      confidence: scoreConfidence(provenance),
      ...(previous.length ? { decision: resolveDecision(o.decision, o.title, previous) } : {}),
    };
  });

  const memoryInfluenced = opportunities.filter((o) => o.memoryInfluence.used);
  if (memoryInfluenced.length > 0) {
    await track('memory_influenced_result', {
      agentId: agent.id,
      metadata: { count: memoryInfluenced.length, knowledgeIds: memoryInfluenced.flatMap((o) => o.memoryInfluence.knowledgeIds) },
    });
  } else if (isRepeatScan && contextKnowledgeIds.length > 0) {
    log.warn('repeat_scan_without_memory_influence', { agentId: agent.id, knowledgeInContext: contextKnowledgeIds.length });
  }

  // 5. Decision Delta: previous recommendation -> learned -> changed -> why.
  let rawDropped = parsed.dropped;
  if (previousRun && previous.length > 0 && opportunities.length > 0) {
    const review = await reviewDecisions(opportunities, previous, agent.id, previousRun.createdAt, evidence);
    if (review) {
      review.byIndex.forEach((decision, i) => { opportunities[i]!.decision = decision; });
      rawDropped = review.dropped;
    }
  }
  const decisionDelta = previousRun
    ? buildDecisionDelta({ previousRun, previous, opportunities, evidence, rawDropped })
    : null;
  if (decisionDelta) {
    await track('decision_delta_generated', { agentId: agent.id, metadata: { ...decisionDelta.counts } });
  }

  const evidenceQuality = summarizeQuality(evidence, executed.plan.windowDays, executed.relaxedNeeds);
  const plan = restrictPlan(executed.plan, evidence);
  const runId = newId('run');
  const generatedAt = new Date().toISOString();
  const query = plan.needs.find((n) => n.usedPhrase)?.usedPhrase ?? needs[0]?.phrases[0] ?? '';

  await saveRun({
    id: runId,
    agentId: agent.id,
    query,
    provider: provider.name,
    signalIds: evidence.map((e) => e.signalId),
    usedKnowledgeIds: contextKnowledgeIds,
    usedOutcomeIds: contextOutcomeIds,
    result: { opportunities },
    plan,
    evidence,
    evidenceQuality,
    previousRunId: previousRun?.id ?? null,
    decisionDelta,
    createdAt: generatedAt,
  });

  await track('opportunity_scan_completed', {
    agentId: agent.id,
    metadata: {
      count: opportunities.length, signalsUsed: evidence.length, memoryInfluenced: memoryInfluenced.length,
      evidenceLevel: evidenceQuality.level, needs: plan.needs.length,
    },
  });

  return {
    runId,
    provider: provider.name,
    generatedAt,
    query,
    signalsUsed: evidence.length,
    usedKnowledgeIds: contextKnowledgeIds,
    usedOutcomeIds: contextOutcomeIds,
    isRepeatScan,
    opportunities,
    plan,
    evidence,
    evidenceQuality,
    previousRunId: previousRun?.id ?? null,
    decisionDelta,
  };
}

/**
 * Asks, in one short call, whether each new recommendation keeps or changes a
 * previous one and why. Labels are validated here; anything unusable leaves the
 * engine's own resolution (a labelled title match, or "new" with no reason) in
 * place. Failure is non-fatal: the scan still returns, and the delta still says
 * honestly what was learned.
 */
async function reviewDecisions(
  opportunities: Opportunity[],
  previous: PreviousRecommendation[],
  agentId: string,
  sinceIso: string,
  evidence: EvidenceRef[],
): Promise<{ byIndex: Map<number, OpportunityDecision>; dropped: { previousId: string; reason: string }[] } | null> {
  const since = memorySince(agentId, sinceIso);
  const prompt = buildDecisionReviewPrompt({
    previous,
    current: opportunities.map((o, i) => ({ label: `N${i + 1}`, title: o.title, action: o.action, why: o.why })),
    learned: {
      outcomes: since.outcomes.map(outcomeRef),
      knowledge: since.knowledge,
      actions: since.actions,
      newEvidence: evidence.filter((e) => e.seenBefore === false),
    },
  });

  try {
    const raw = await getProvider().reason(prompt, { chatHistory: 'off', useCustomContext: false, label: 'decision_review' });
    const parsed = parseStructured(raw, decisionReviewSchema);
    if (!parsed.ok) {
      log.warn('decision_review_unparsable', { agentId, reason: parsed.reason });
      return null;
    }

    const byIndex = new Map<number, OpportunityDecision>();
    for (const d of parsed.data.decisions) {
      const i = Number(/^N(\d+)$/i.exec(d.item.trim())?.[1]) - 1;
      if (!(i >= 0 && i < opportunities.length)) continue;
      const prev = previous.find((p) => p.label === d.previousId.trim().toUpperCase());
      const reason = d.reason.trim();
      if ((d.status === 'kept' || d.status === 'changed') && prev) {
        byIndex.set(i, {
          status: d.status, previousLabel: prev.label, previousOpportunityId: prev.id, previousTitle: prev.title,
          reason, attribution: 'model',
        });
      } else if (d.status === 'new' && reason) {
        byIndex.set(i, { status: 'new', reason, attribution: 'model' });
      }
    }
    log.info('decision_review_applied', { agentId, reviewed: byIndex.size, of: opportunities.length });
    return { byIndex, dropped: parsed.data.dropped };
  } catch (err) {
    log.warn('decision_review_failed', { agentId, error: (err as Error).message });
    return null;
  }
}

// -------------------------------------------------------------- deep research

export async function generateDeepResearch(
  agent: Agent,
  opportunity: { id: string; title: string; signal: string; why: string; opportunity: string; action: string },
  opts: { forceFreshSignals?: boolean } = {},
): Promise<{
  provider: string;
  generatedAt: string;
  research: DeepResearch;
  plan: EvidencePlan;
  evidence: EvidenceRef[];
  evidenceQuality: EvidenceQuality;
}> {
  const provider = getProvider();
  setContextAgent(agent.id);
  const ctx = buildKultContext(agent, `${opportunity.title} ${opportunity.why}`);

  const executed = await executePlan(planResearchEvidence(opportunity), {
    idPrefix: 'R',
    bypassCache: opts.forceFreshSignals,
    label: 'chaingpt.news.research',
  });

  const build = (n: number, d: PromptDetail) => buildResearchPrompt(ctx, opportunity, executed.evidence.slice(0, n), d);
  const fitted = fitToBudget(build, executed.evidence.length, 'research');
  const { raw, shown } = await reasonWithDegradation((n) => build(n, fitted.detail), fitted.n, {
    // KULT is the canonical memory: research is stateless on the ChainGPT side and
    // receives the Agent's memory in the prompt. (History also costs +1 credit.)
    chatHistory: 'off',
    useCustomContext: config.chaingpt.useCustomContext,
    label: 'research',
  }, 'research');

  const evidence = executed.evidence.slice(0, shown);
  const citable = () => renderCitableIds(evidence.map((e) => ({ id: e.id, label: e.title })));
  const parsed = await parseWithRepair(raw, deepResearchSchema, repairer(RESEARCH_SHAPE, 'research', citable), 'research');
  const byId = new Map(evidence.map((e) => [e.id, e]));

  // Attach real age and freshness to items citing a retrieved article; drop ids
  // that were never shown rather than letting them pose as sources.
  const research: DeepResearch = {
    ...parsed,
    liveEvidence: {
      ...parsed.liveEvidence,
      items: parsed.liveEvidence.items.map(({ evidenceId, ...item }) => {
        const ref = byId.get(evidenceId.trim());
        return ref
          ? { ...item, evidenceId: ref.id, publishedAt: ref.publishedAt, ageDays: ref.ageDays, freshness: ref.freshness }
          : item;
      }),
    },
  };

  await track('deep_research_completed', {
    agentId: agent.id,
    metadata: { opportunityId: opportunity.id, evidenceItems: research.liveEvidence.items.length, retrieved: evidence.length },
  });

  return {
    provider: provider.name,
    generatedAt: new Date().toISOString(),
    research,
    plan: restrictPlan(executed.plan, evidence),
    evidence,
    evidenceQuality: summarizeQuality(evidence, executed.plan.windowDays, executed.relaxedNeeds),
  };
}

// ------------------------------------------------------------- creator growth

export async function generateGrowthPlan(
  agent: Agent,
  project: CreatorProject,
  opts: { forceFreshSignals?: boolean } = {},
): Promise<{ provider: string; generatedAt: string; growth: GrowthPlan; evidence: EvidenceRef[]; evidenceQuality: EvidenceQuality }> {
  const provider = getProvider();
  setContextAgent(agent.id);
  const focus = `${project.title} ${project.tags.join(' ')} ${project.goals.join(' ')}`;
  const ctx = buildKultContext(agent, focus, project);
  const windowDays = config.news.freshnessDays;

  let retrieved: EvidenceRef[] = [];
  let relaxed = 0;
  try {
    const r = await retrieveSignals(buildProjectSignalQuery(project, opts.forceFreshSignals));
    retrieved = r.signals.slice(0, SIGNAL_LIMIT).map((s, i) => toEvidenceRef(s, `G${i + 1}`, windowDays));
    relaxed = r.relaxedFreshness ? 1 : 0;
  } catch (err) {
    log.warn('growth_signals_unavailable', { error: (err as Error).message });
  }

  const build = (n: number, d: PromptDetail) => buildGrowthPrompt(ctx, retrieved.slice(0, n), d);
  const fitted = fitToBudget(build, retrieved.length, 'growth');
  const { raw, shown } = await reasonWithDegradation(
    (n) => build(n, fitted.detail),
    fitted.n,
    { chatHistory: 'off', useCustomContext: config.chaingpt.useCustomContext, label: 'growth' },
    'growth',
  );

  const parsed = await parseWithRepair(raw, growthPlanSchema, repairer(GROWTH_SHAPE, 'growth'), 'growth', 'opportunities');
  const evidence = retrieved.slice(0, shown);

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
    metadata: { count: growth.opportunities.length, signalsUsed: evidence.length },
  });

  return {
    provider: provider.name,
    generatedAt: new Date().toISOString(),
    growth,
    evidence,
    evidenceQuality: summarizeQuality(evidence, windowDays, relaxed),
  };
}

export { ProviderError };
