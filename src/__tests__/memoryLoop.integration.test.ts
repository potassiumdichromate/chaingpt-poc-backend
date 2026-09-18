import { beforeEach, describe, expect, it } from 'vitest';
import { db, initStore } from '../db/store.js';
import { generateDeepResearch, generateOpportunities, generateGrowthPlan } from '../intelligence/engine.js';
import { computeMetrics } from '../analytics.js';
import { seedAgents, seedProjects } from '../db/seed.js';
import { recordAction, recordOutcome, saveKnowledge } from '../intelligence/memory.js';

/**
 * Spec 19.1 - the P0 integration test, automated.
 *
 * Given a real Agent with no saved intelligence, when we scan, research, save and
 * scan again, then the second request must carry the saved research, at least one
 * opportunity must set memoryInfluence.used, and analytics must record both
 * repeat_intelligence_scan and memory_influenced_result.
 *
 * Runs against DemoProvider (vitest.config.ts sets INTELLIGENCE_PROVIDER=demo) so
 * it is deterministic and needs no API key in CI.
 */

const agent = seedAgents()[0]!;
const project = seedProjects()[0]!;

async function resetAll() {
  await initStore();
  await db.mutate((s) => {
    s.knowledge = []; s.runs = []; s.actions = []; s.outcomes = []; s.events = []; s.providerCalls = [];
    s.agents = seedAgents(); s.projects = seedProjects();
  });
}

describe('P0 memory feedback loop (spec 19.1)', () => {
  beforeEach(resetAll);

  it('completes scan -> research -> save -> rescan with visible memory influence', async () => {
    // 1. First scan - no prior intelligence.
    const first = await generateOpportunities(agent);
    expect(first.isRepeatScan).toBe(false);
    expect(first.usedKnowledgeIds).toEqual([]);
    expect(first.opportunities.length).toBeGreaterThan(0);
    expect(first.opportunities.every((o) => o.memoryInfluence.used === false)).toBe(true);

    // 2. Deep research on the top opportunity.
    const target = first.opportunities[0]!;
    const { research } = await generateDeepResearch(agent, target);
    expect(research.summary.length).toBeGreaterThan(0);
    expect(research.recommendedActions.length).toBeGreaterThan(0);

    // 3. Persist it as Agent knowledge.
    const knowledgeId = await db.mutate((s) => {
      const item = {
        id: 'kn_test_1', agentId: agent.id, type: 'opportunity_research' as const,
        title: target.title, summary: research.summary, payload: { research },
        sourceProvider: 'demo', sourceRefs: [], createdAt: new Date().toISOString(),
      };
      s.knowledge.push(item);
      return item.id;
    });

    // 4. Second scan - saved knowledge must reach the request.
    const second = await generateOpportunities(agent);
    expect(second.isRepeatScan).toBe(true);
    expect(second.usedKnowledgeIds).toContain(knowledgeId);

    // ...and be visibly reflected in a recommendation.
    const influenced = second.opportunities.filter((o) => o.memoryInfluence.used);
    expect(influenced.length).toBeGreaterThanOrEqual(1);
    expect(influenced[0]!.memoryInfluence.knowledgeIds).toContain(knowledgeId);
    expect(influenced[0]!.memoryInfluence.reason.length).toBeGreaterThan(0);

    // 5. Analytics must record both events.
    const m = computeMetrics();
    expect(m.opportunityScans).toBe(2);
    expect(m.repeatIntelligenceScans).toBe(1);
    expect(m.memoryInfluencedRecommendations).toBeGreaterThanOrEqual(1);
    expect(m.deepResearchSessions).toBe(1);
  });

  it('never attributes a knowledge id that was not injected into the prompt', async () => {
    await db.mutate((s) => {
      s.knowledge.push({
        id: 'kn_real', agentId: agent.id, type: 'opportunity_research',
        title: 'AI gaming ecosystem programmes', summary: 'Prior research.',
        payload: null, sourceProvider: 'demo', sourceRefs: [], createdAt: new Date().toISOString(),
      });
    });

    const run = await generateOpportunities(agent);
    const injected = new Set(run.usedKnowledgeIds);
    for (const o of run.opportunities) {
      for (const id of o.memoryInfluence.knowledgeIds) {
        expect(injected.has(id)).toBe(true);
      }
    }
  });

  it('persists an OpportunityRun recording which knowledge was in context', async () => {
    await generateOpportunities(agent);
    const runs = db.read().runs.filter((r) => r.agentId === agent.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.provider).toBe('demo');
  });

  it('saves a creator growth plan into the same Agent knowledge layer', async () => {
    const { growth } = await generateGrowthPlan(agent, project);
    expect(growth.opportunities.length).toBeGreaterThan(0);
    expect(growth.campaignBrief.positioning.length).toBeGreaterThan(0);

    await db.mutate((s) => {
      s.knowledge.push({
        id: 'kn_growth', agentId: agent.id, type: 'creator_growth_plan',
        title: `Growth plan: ${project.title}`, summary: growth.campaignBrief.positioning,
        payload: growth, sourceProvider: 'demo', sourceRefs: [],
        projectId: project.id, createdAt: new Date().toISOString(),
      });
    });

    // The compounding claim: creator growth must feed Agent discovery.
    const scan = await generateOpportunities(agent);
    expect(scan.usedKnowledgeIds).toContain('kn_growth');
    expect(computeMetrics().creatorGrowthPlans).toBe(1);
  });

  it('emits creator_growth_plan_generated against both agent and project', async () => {
    await generateGrowthPlan(agent, project);
    const ev = db.read().events.find((e) => e.name === 'creator_growth_plan_generated');
    expect(ev?.agentId).toBe(agent.id);
    expect(ev?.projectId).toBe(project.id);
  });
});

/**
 * The hero demo, automated: scan -> research -> remember -> act -> outcome ->
 * scan again -> new evidence -> keep or change the decision, and explain why.
 */
describe('hero loop: the Agent changes or keeps its decision and says why', () => {
  beforeEach(resetAll);

  it('runs the full loop with a plan, provenance, confidence and a Decision Delta', async () => {
    // 1. First scan: plan -> evidence -> recommendations. No previous decision yet.
    const first = await generateOpportunities(agent);
    expect(first.plan.needs.length).toBeGreaterThan(0);
    expect(first.plan.needs.every((n) => n.question && n.reason)).toBe(true);
    expect(first.evidence.every((e) => /^E\d+$/.test(e.id) && e.ageDays >= 0 && e.freshness)).toBe(true);
    expect(first.evidenceQuality.total).toBe(first.evidence.length);
    expect(first.decisionDelta).toBeNull();
    expect(first.opportunities.every((o) => o.decision === undefined)).toBe(true);
    expect(first.opportunities.every((o) => o.confidence.reasons.length > 0)).toBe(true);
    // Cited evidence must be evidence that was actually retrieved.
    const retrieved = new Set(first.evidence.map((e) => e.id));
    expect(first.opportunities.flatMap((o) => o.provenance.evidence).every((e) => retrieved.has(e.id))).toBe(true);

    // 2. Research the top recommendation - research evidence is R-numbered with ages.
    const target = first.opportunities[0]!;
    const { research, evidence: researchEvidence } = await generateDeepResearch(agent, target);
    expect(researchEvidence.every((e) => /^R\d+$/.test(e.id))).toBe(true);
    const cited = research.liveEvidence.items.filter((i) => i.evidenceId);
    expect(cited.every((i) => i.freshness && typeof i.ageDays === 'number')).toBe(true);

    // 3. Remember, 4. act, 5. get an outcome.
    await saveKnowledge({
      id: 'kn_hero', agentId: agent.id, type: 'opportunity_research', title: target.title,
      summary: research.summary, payload: { research }, sourceProvider: 'demo', sourceRefs: [],
      createdAt: new Date().toISOString(),
    });
    await recordAction({
      id: 'act_hero', agentId: agent.id, opportunityId: target.id, opportunityTitle: target.title,
      runId: first.runId, actionType: 'applied_to_program', status: 'taken', createdAt: new Date().toISOString(),
    });
    await recordOutcome({
      id: 'out_hero', agentId: agent.id, actionId: 'act_hero', outcomeType: 'no_response',
      notes: 'No reply after a week', createdAt: new Date().toISOString(),
    });

    // 6. Scan again.
    const second = await generateOpportunities(agent);

    // The plan reacts to the outcome: the Agent decided to look for something new.
    const outcomeNeed = second.plan.needs.find((n) => n.trigger === 'outcome');
    expect(outcomeNeed?.triggerRef?.id).toBe('out_hero');
    expect(outcomeNeed?.question).toMatch(/alternatives/);

    // The outcome reached the model and is cited as provenance.
    expect(second.usedOutcomeIds).toContain('out_hero');
    const outcomeCited = second.opportunities.filter((o) => o.provenance.outcomes.some((x) => x.id === 'out_hero'));
    expect(outcomeCited.length).toBeGreaterThanOrEqual(1);
    expect(outcomeCited[0]!.provenance.outcomes[0]!.opportunityTitle).toBe(target.title);

    // 7. Decision Delta: previous recommendation -> learned -> changed -> why.
    const delta = second.decisionDelta!;
    expect(delta.previousRunId).toBe(first.runId);
    expect(delta.learned.outcomes.map((o) => o.id)).toEqual(['out_hero']);
    expect(delta.learned.knowledge.map((k) => k.id)).toEqual(['kn_hero']);
    expect(delta.learned.actions.map((a) => a.id)).toEqual(['act_hero']);
    expect(delta.decisions).toHaveLength(second.opportunities.length);
    expect(delta.counts.changed + delta.counts.kept).toBeGreaterThanOrEqual(1);

    const changed = second.opportunities.find((o) => o.decision?.status === 'changed');
    expect(changed?.decision?.previousOpportunityId).toBe(first.opportunities[0]!.id);
    expect(changed?.decision?.reason.length).toBeGreaterThan(10);
    expect(changed?.decision?.attribution).toBe('model');
    expect(delta.summary).toMatch(/learned 1 outcome, 1 saved research item, 1 action/);

    // The same demo news came back, so the delta must not claim new evidence.
    expect(delta.learned.newEvidence).toEqual([]);
    expect(delta.learned.repeatedEvidence).toBe(second.evidence.length);

    // 8. Metrics see the whole loop.
    const m = computeMetrics();
    expect(m.opportunityScans).toBe(2);
    expect(m.decisionDeltas).toBe(1);
    expect(m.recommendationsActedOn).toBe(1);
    expect(m.recordedOutcomes).toBe(1);
    expect(m.recommendationToOutcomeRate).toBeGreaterThan(0);
    expect(m.memoryInformedScans).toBeGreaterThanOrEqual(1);
    // Demo calls are recorded but never counted as ChainGPT spend.
    expect(db.read().providerCalls.length).toBeGreaterThan(0);
    expect(m.chaingptCalls).toBe(0);
  });

  it('persists the plan, evidence and delta on the run for the history view', async () => {
    await generateOpportunities(agent);
    await generateOpportunities(agent);
    const runs = db.read().runs.filter((r) => r.agentId === agent.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.decisionDelta).toBeNull();
    expect(runs[1]!.previousRunId).toBe(runs[0]!.id);
    expect(runs[1]!.decisionDelta?.summary).toMatch(/Nothing new since the last scan/);
    expect(runs[1]!.plan?.needs.some((n) => n.trigger === 'previous_recommendation')).toBe(true);
  });
});
