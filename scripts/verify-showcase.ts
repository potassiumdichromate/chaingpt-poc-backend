/**
 * End-to-end showcase readiness check.
 *
 *   npm run verify
 *
 * Runs the exact spec 19.1 P0 flow against whatever provider is configured:
 *   scan -> research -> save -> rescan -> memory influence -> growth -> history
 *
 * Point it at ChainGPT the moment credits land. Every assertion maps to a line
 * in the spec's Definition of Done.
 */
import 'dotenv/config';
import { config, resolveProvider } from '../src/config.js';
import { db, initStore } from '../src/db/store.js';
import { closeMongo } from '../src/db/mongo.js';
import { getAgent, getProject, contextSource, listAgents } from '../src/kult/context.js';
import { generateDeepResearch, generateGrowthPlan, generateOpportunities } from '../src/intelligence/engine.js';
import { computeMetrics } from '../src/analytics.js';
import { categorize } from '../src/lib/errors.js';

const pass = (s: string) => console.log(`  \x1b[32mPASS\x1b[0m ${s}`);
const fail = (s: string) => console.log(`  \x1b[31mFAIL\x1b[0m ${s}`);
const info = (s: string) => console.log(`  \x1b[36m·\x1b[0m ${s}`);
const head = (s: string) => console.log(`\n${s}`);

let failures = 0;
function check(ok: boolean, label: string) {
  if (ok) pass(label); else { fail(label); failures += 1; }
}

async function main() {
  console.log('\nKULT x ChainGPT - showcase readiness');
  console.log('='.repeat(70));

  const resolved = resolveProvider();
  info(`provider     : ${resolved.name}${resolved.degraded ? '  (DEGRADED)' : ''}`);
  info(`transport    : ${config.chaingpt.transport}`);
  info(`contextSource: ${await contextSource()}`);
  info(`customContext: ${config.chaingpt.useCustomContext}`);
  if (resolved.degraded) {
    fail(resolved.reason ?? 'provider degraded');
    info('This verifies POC logic only - it is NOT proof the live showcase works.');
    failures += 1;
  }

  await initStore();

  // --- Context ---
  head('[1] KULT context');
  const agentId = process.env.VERIFY_AGENT_ID
    || (await listAgents())[0]?.id
    || 'agent_kult_nova';
  const agent = await getAgent(agentId);
  if (!agent) { fail(`agent ${agentId} not found`); process.exit(1); }
  pass(`Agent: ${agent.name} (${agent.id.slice(0, 28)})`);
  info(`interests: ${agent.interests.slice(0, 5).join(', ')}`);
  check(agent.goals.length > 0, 'Agent has goals');
  check(agent.activity.length > 0, 'Agent has real KULT activity');

  const projectId = process.env.VERIFY_PROJECT_ID || 'zmftkbihiws';
  const project = await getProject(projectId);
  if (!project) { fail(`project ${projectId} not found`); process.exit(1); }
  pass(`Experience: ${project.title} (${project.category}, ${project.stats?.plays ?? 0} plays)`);

  // Clean slate so the memory loop is proven, not inherited.
  await db.mutate((s) => {
    s.knowledge = s.knowledge.filter((k) => k.agentId !== agent.id);
    s.runs = s.runs.filter((r) => r.agentId !== agent.id);
    s.events = [];
  });

  // --- Scan 1 ---
  head('[2] First scan - no prior intelligence');
  const first = await generateOpportunities(agent);
  check(first.opportunities.length === 3, `exactly 3 opportunities (got ${first.opportunities.length})`);
  check(first.signalsUsed > 0, `live signals used (${first.signalsUsed})`);
  check(!first.isRepeatScan, 'flagged as first scan');
  check(first.opportunities.every((o) => !o.memoryInfluence.used), 'no memory influence claimed yet');
  check(first.opportunities.every((o) => o.relevance >= 0 && o.relevance <= 100), 'relevance is numeric 0-100');
  check(first.opportunities.every((o) => o.action.length > 10), 'every opportunity has a concrete action');
  for (const o of first.opportunities) info(`[${o.relevance}] ${o.title.slice(0, 62)}`);

  // --- Research ---
  head('[3] Deep research');
  const target = first.opportunities[0]!;
  const { research } = await generateDeepResearch(agent, target);
  check(research.summary.length > 20, 'summary present');
  check(research.whyNow.length > 10, 'whyNow present');
  check(research.fitForAgent.length > 10, 'fitForAgent present');
  check(research.recommendedActions.length >= 1, `recommendedActions (${research.recommendedActions.length})`);
  info(`live evidence items: ${research.liveEvidence.items.length}`);
  info(`targets: ${research.targets.slice(0, 3).join(', ') || '(none)'}`);

  // --- Save ---
  head('[4] Persist to Agent knowledge');
  const knowledgeId = await db.mutate((s) => {
    const item = {
      id: `kn_verify_${Date.now().toString(36)}`, agentId: agent.id,
      type: 'opportunity_research' as const, title: target.title, summary: research.summary,
      payload: { research }, sourceProvider: resolved.name, sourceRefs: [],
      createdAt: new Date().toISOString(),
    };
    s.knowledge.push(item);
    return item.id;
  });
  pass(`saved ${knowledgeId}`);

  // --- Scan 2: the P0 moment ---
  head('[5] Second scan - THE MEMORY LOOP (spec 8, P0)');
  const second = await generateOpportunities(agent);
  check(second.isRepeatScan, 'flagged as repeat scan');
  check(second.usedKnowledgeIds.includes(knowledgeId), 'saved knowledge injected into the request');

  const influenced = second.opportunities.filter((o) => o.memoryInfluence.used);
  check(influenced.length >= 1, `a recommendation builds on prior knowledge (${influenced.length})`);
  if (influenced[0]) {
    info(`badge : ${influenced[0].title.slice(0, 60)}`);
    info(`reason: ${influenced[0].memoryInfluence.reason.slice(0, 130)}`);
    check(
      influenced[0].memoryInfluence.knowledgeIds.every((id) => second.usedKnowledgeIds.includes(id)),
      'cited knowledge ids were genuinely injected (no hallucination)',
    );
  }

  // --- Growth ---
  head('[6] KULT Create growth');
  const { growth } = await generateGrowthPlan(agent, project);
  check(growth.opportunities.length === 3, `3 growth opportunities (got ${growth.opportunities.length})`);
  check(growth.campaignBrief.positioning.length > 10, 'campaign brief positioning');
  check(growth.opportunities.every((o) => o.targets.length > 0), 'every growth opportunity names targets');
  for (const o of growth.opportunities) info(`[${o.relevance}] ${o.title.slice(0, 62)}`);

  await db.mutate((s) => {
    s.knowledge.push({
      id: `kn_growth_${Date.now().toString(36)}`, agentId: agent.id,
      type: 'creator_growth_plan', title: `Growth plan: ${project.title}`,
      summary: growth.campaignBrief.positioning, payload: growth,
      sourceProvider: resolved.name, sourceRefs: [], projectId: project.id,
      createdAt: new Date().toISOString(),
    });
  });
  pass('growth plan saved to the same Agent knowledge layer');

  // --- Analytics ---
  head('[7] Analytics (spec 16)');
  const m = computeMetrics();
  check(m.opportunityScans === 2, `opportunity_scan_completed x2 (got ${m.opportunityScans})`);
  check(m.repeatIntelligenceScans >= 1, 'repeat_intelligence_scan recorded');
  check(m.memoryInfluencedRecommendations >= 1, 'memory_influenced_result recorded');
  check(m.deepResearchSessions >= 1, 'deep_research_completed recorded');
  check(m.creatorGrowthPlans >= 1, 'creator_growth_plan_generated recorded');

  // Without this the open Mongo client keeps the event loop alive and the
  // script never exits, even on success.
  await closeMongo();

  console.log(`\n${'='.repeat(70)}`);
  if (failures === 0) {
    console.log('\x1b[32mSHOWCASE READY - the full spec flow works end to end.\x1b[0m');
    if (resolved.name !== 'chaingpt') {
      console.log('\x1b[33mNote: this ran on the demo provider. Re-run with a funded ChainGPT key.\x1b[0m');
    }
    console.log();
  } else {
    console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  await closeMongo().catch(() => {});
  const e = categorize(err);
  console.log(`\n\x1b[31mVerification aborted: ${e.category}\x1b[0m`);
  console.log(`  ${e.userMessage}`);
  if (e.category === 'insufficient_credits') {
    console.log('  Top up at https://app.chaingpt.org, then re-run: npm run verify');
  }
  console.log(`  detail: ${e.message.slice(0, 200)}\n`);
  process.exit(1);
});
