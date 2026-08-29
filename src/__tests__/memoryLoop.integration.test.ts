import { beforeEach, describe, expect, it } from 'vitest';
import { db, initStore } from '../db/store.js';
import { generateDeepResearch, generateOpportunities, generateGrowthPlan } from '../intelligence/engine.js';
import { computeMetrics } from '../analytics.js';
import { seedAgents, seedProjects } from '../db/seed.js';

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
    s.knowledge = []; s.runs = []; s.actions = []; s.outcomes = []; s.events = [];
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
