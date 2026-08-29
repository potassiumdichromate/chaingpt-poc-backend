import { Router } from 'express';
import { z } from 'zod';
import { db, newId } from '../db/store.js';
import { track } from '../analytics.js';
import { getAgent, getProjectsForAgent, listAgents } from '../kult/context.js';
import { generateDeepResearch, generateOpportunities } from '../intelligence/engine.js';
import { asyncRoute } from './helpers.js';
import type { ActionRecord, KnowledgeItem, OutcomeRecord } from '../types.js';

export const agentsRouter = Router();

/** GET /api/agents - convenience list for the POC agent switcher. */
agentsRouter.get('/', asyncRoute(async (_req, res) => {
  res.json({ agents: await listAgents() });
}, 'list_agents'));

/** GET /api/agents/:agentId - persistent Agent context (spec 13). */
agentsRouter.get('/:agentId', asyncRoute(async (req, res) => {
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  const s = db.read();
  await track('intelligence_exposed', { agentId: agent.id });

  res.json({
    agent,
    stats: {
      knowledgeItems: s.knowledge.filter((k) => k.agentId === agent.id).length,
      actions: s.actions.filter((a) => a.agentId === agent.id).length,
      outcomes: s.outcomes.filter((o) => o.agentId === agent.id).length,
      scans: s.runs.filter((r) => r.agentId === agent.id).length,
    },
    projects: await getProjectsForAgent(agent.id),
  });
}, 'get_agent'));

/** GET /api/agents/:agentId/knowledge - recent saved intelligence. */
agentsRouter.get('/:agentId/knowledge', (req, res) => {
  const items = db.read().knowledge
    .filter((k) => k.agentId === req.params.agentId)
    .slice()
    .reverse();
  res.json({ knowledge: items });
});

/** POST /api/agents/:agentId/opportunities - signals + personalized opportunities. */
const opportunityBody = z.object({
  query: z.string().optional(),
  forceFreshSignals: z.boolean().optional(),
});

agentsRouter.post('/:agentId/opportunities', asyncRoute(async (req, res) => {
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  const body = opportunityBody.parse(req.body ?? {});
  const result = await generateOpportunities(agent, body.query);

  if (result.opportunities.length === 0) {
    // Spec 15.4: say nothing was found rather than inventing content.
    return res.status(200).json({ ...result, empty: true, message: 'No strong opportunities found right now.' });
  }
  res.json(result);
}, 'opportunities'));

/** POST /api/agents/:agentId/research - deep research for a selected opportunity. */
const researchBody = z.object({
  opportunity: z.object({
    id: z.string(),
    title: z.string(),
    signal: z.string().default(''),
    why: z.string().default(''),
    opportunity: z.string().default(''),
    action: z.string().default(''),
  }),
});

agentsRouter.post('/:agentId/research', asyncRoute(async (req, res) => {
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  const { opportunity } = researchBody.parse(req.body ?? {});
  await track('opportunity_opened', { agentId: agent.id, metadata: { opportunityId: opportunity.id } });

  res.json(await generateDeepResearch(agent, opportunity));
}, 'research'));

/** POST /api/agents/:agentId/knowledge - persist research / growth intelligence. */
const knowledgeBody = z.object({
  type: z.enum([
    'opportunity_research',
    'creator_growth_plan',
    'partner_research',
    'ecosystem_research',
    'action_summary',
    'outcome_summary',
  ]),
  title: z.string().min(1),
  summary: z.string().min(1),
  payload: z.unknown().optional(),
  sourceProvider: z.string().default('chaingpt'),
  sourceRefs: z.array(z.string()).default([]),
  projectId: z.string().optional(),
});

agentsRouter.post('/:agentId/knowledge', asyncRoute(async (req, res) => {
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  const body = knowledgeBody.parse(req.body ?? {});
  const item: KnowledgeItem = {
    id: newId('kn'),
    agentId: agent.id,
    type: body.type,
    title: body.title,
    summary: body.summary,
    payload: body.payload ?? null,
    sourceProvider: body.sourceProvider,
    sourceRefs: body.sourceRefs,
    projectId: body.projectId,
    createdAt: new Date().toISOString(),
  };

  // If this throws the client gets a failure and must not claim persistence (spec 15.4).
  await db.mutate((s) => { s.knowledge.push(item); });
  await track('knowledge_saved', { agentId: agent.id, projectId: body.projectId, metadata: { type: body.type } });

  res.status(201).json({ knowledge: item });
}, 'save_knowledge'));

/** POST /api/agents/:agentId/actions - record a recommended action taken. */
const actionBody = z.object({
  opportunityId: z.string(),
  opportunityTitle: z.string(),
  actionType: z.enum([
    'contacted_ecosystem',
    'applied_to_program',
    'created_campaign',
    'researched_partner',
    'added_to_pipeline',
    'dismissed',
  ]),
  status: z.enum(['taken', 'pending', 'dismissed']).default('taken'),
  metadata: z.record(z.unknown()).optional(),
});

agentsRouter.post('/:agentId/actions', asyncRoute(async (req, res) => {
  const body = actionBody.parse(req.body ?? {});
  const action: ActionRecord = {
    id: newId('act'),
    agentId: req.params.agentId,
    opportunityId: body.opportunityId,
    opportunityTitle: body.opportunityTitle,
    actionType: body.actionType,
    status: body.status,
    metadata: body.metadata,
    createdAt: new Date().toISOString(),
  };

  await db.mutate((s) => { s.actions.push(action); });
  await track('recommended_action_taken', {
    agentId: action.agentId,
    metadata: { actionType: action.actionType, opportunityId: action.opportunityId },
  });

  res.status(201).json({ action });
}, 'record_action'));

/** POST /api/agents/:agentId/outcomes - record the outcome of an action. */
const outcomeBody = z.object({
  actionId: z.string(),
  outcomeType: z.enum([
    'no_response',
    'conversation_started',
    'partnership_opportunity',
    'campaign_launched',
    'players_acquired',
    'not_relevant',
    'other',
  ]),
  value: z.string().optional(),
  notes: z.string().optional(),
});

agentsRouter.post('/:agentId/outcomes', asyncRoute(async (req, res) => {
  const body = outcomeBody.parse(req.body ?? {});
  const outcome: OutcomeRecord = {
    id: newId('out'),
    agentId: req.params.agentId,
    actionId: body.actionId,
    outcomeType: body.outcomeType,
    value: body.value,
    notes: body.notes,
    createdAt: new Date().toISOString(),
  };

  await db.mutate((s) => { s.outcomes.push(outcome); });
  await track('outcome_recorded', {
    agentId: outcome.agentId,
    metadata: { outcomeType: outcome.outcomeType, actionId: outcome.actionId },
  });

  res.status(201).json({ outcome });
}, 'record_outcome'));

/** GET /api/agents/:agentId/actions - actions plus their recorded outcomes. */
agentsRouter.get('/:agentId/actions', (req, res) => {
  const s = db.read();
  const actions = s.actions.filter((a) => a.agentId === req.params.agentId).slice().reverse();
  res.json({
    actions: actions.map((a) => ({
      ...a,
      outcomes: s.outcomes.filter((o) => o.actionId === a.id),
    })),
  });
});
