import { Router } from 'express';
import { z } from 'zod';
import { newId } from '../db/store.js';
import { track } from '../analytics.js';
import { getAgent, getProjectsForAgent, listAgents } from '../kult/context.js';
import { generateDeepResearch, generateOpportunities } from '../intelligence/engine.js';
import {
  agentStats, findAction, listActionsWithOutcomes, listKnowledge, recordAction, recordOutcome, saveKnowledge,
} from '../intelligence/memory.js';
import { ID_PATTERN, canActForAgent, denyNotOwner, spendRateLimit } from '../lib/security.js';
import { asyncRoute } from './helpers.js';
import type { ActionRecord, KnowledgeItem, OutcomeRecord } from '../types.js';

export const agentsRouter = Router();

agentsRouter.param('agentId', (_req, res, next, id: string) => {
  if (!ID_PATTERN.test(id)) return res.status(400).json({ error: { message: 'Invalid agent id' } });
  next();
});

/** GET /api/agents - convenience list for the POC agent switcher. */
agentsRouter.get('/', asyncRoute(async (_req, res) => {
  res.json({ agents: await listAgents() });
}, 'list_agents'));

/** GET /api/agents/:agentId - persistent Agent context (spec 13). */
agentsRouter.get('/:agentId', asyncRoute(async (req, res) => {
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  await track('intelligence_exposed', { agentId: agent.id });

  res.json({
    agent,
    stats: agentStats(agent.id),
    projects: await getProjectsForAgent(agent.id),
  });
}, 'get_agent'));

/** GET /api/agents/:agentId/knowledge - recent saved intelligence. */
agentsRouter.get('/:agentId/knowledge', (req, res) => {
  res.json({ knowledge: listKnowledge(req.params.agentId) });
});

/** POST /api/agents/:agentId/opportunities - plan, retrieve, reason, compare. */
const opportunityBody = z.object({
  query: z.string().max(120).optional(),
  forceFreshSignals: z.boolean().optional(),
});

agentsRouter.post('/:agentId/opportunities', spendRateLimit, asyncRoute(async (req, res) => {
  if (!canActForAgent(req.params.agentId)) return denyNotOwner(res);
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  const body = opportunityBody.parse(req.body ?? {});
  const result = await generateOpportunities(agent, { query: body.query, forceFreshSignals: body.forceFreshSignals });

  if (result.opportunities.length === 0) {
    // Spec 15.4: say nothing was found rather than inventing content.
    return res.status(200).json({ ...result, empty: true, message: 'No strong opportunities found right now.' });
  }
  res.json(result);
}, 'opportunities'));

/** POST /api/agents/:agentId/research - deep research for a selected opportunity. */
const text = (max: number) => z.string().max(max);
const researchBody = z.object({
  opportunity: z.object({
    id: text(64),
    title: text(300),
    signal: text(1000).default(''),
    why: text(2000).default(''),
    opportunity: text(2000).default(''),
    action: text(1000).default(''),
  }),
  forceFreshSignals: z.boolean().optional(),
});

agentsRouter.post('/:agentId/research', spendRateLimit, asyncRoute(async (req, res) => {
  if (!canActForAgent(req.params.agentId)) return denyNotOwner(res);
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  const { opportunity, forceFreshSignals } = researchBody.parse(req.body ?? {});
  await track('opportunity_opened', { agentId: agent.id, metadata: { opportunityId: opportunity.id } });

  res.json(await generateDeepResearch(agent, opportunity, { forceFreshSignals }));
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
  title: text(300).min(1),
  summary: text(4000).min(1),
  payload: z.unknown().optional(),
  sourceProvider: text(40).default('chaingpt'),
  sourceRefs: z.array(text(200)).max(20).default([]),
  projectId: text(128).optional(),
});

/** Opaque payloads are stored verbatim; cap them so one request cannot bloat memory. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

agentsRouter.post('/:agentId/knowledge', asyncRoute(async (req, res) => {
  if (!canActForAgent(req.params.agentId)) return denyNotOwner(res);
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  const body = knowledgeBody.parse(req.body ?? {});
  if (JSON.stringify(body.payload ?? null).length > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({ error: { message: 'Knowledge payload is too large' } });
  }

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
  await saveKnowledge(item);
  await track('knowledge_saved', { agentId: agent.id, projectId: body.projectId, metadata: { type: body.type } });

  res.status(201).json({ knowledge: item });
}, 'save_knowledge'));

/** POST /api/agents/:agentId/actions - record a recommended action taken. */
const actionBody = z.object({
  opportunityId: text(64),
  opportunityTitle: text(300),
  runId: text(64).optional(),
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
  if (!canActForAgent(req.params.agentId)) return denyNotOwner(res);
  // Audit A-11: an action for an Agent that does not exist is orphaned memory.
  const agent = await getAgent(req.params.agentId);
  if (!agent) return res.status(404).json({ error: { message: 'Agent not found' } });

  const body = actionBody.parse(req.body ?? {});
  const action: ActionRecord = {
    id: newId('act'),
    agentId: agent.id,
    opportunityId: body.opportunityId,
    opportunityTitle: body.opportunityTitle,
    ...(body.runId ? { runId: body.runId } : {}),
    actionType: body.actionType,
    status: body.status,
    metadata: body.metadata,
    createdAt: new Date().toISOString(),
  };

  await recordAction(action);
  await track('recommended_action_taken', {
    agentId: action.agentId,
    metadata: { actionType: action.actionType, opportunityId: action.opportunityId, runId: action.runId },
  });

  res.status(201).json({ action });
}, 'record_action'));

/** POST /api/agents/:agentId/outcomes - record the outcome of an action. */
const outcomeBody = z.object({
  actionId: text(64),
  outcomeType: z.enum([
    'no_response',
    'conversation_started',
    'partnership_opportunity',
    'campaign_launched',
    'players_acquired',
    'not_relevant',
    'other',
  ]),
  value: text(200).optional(),
  notes: text(1000).optional(),
});

agentsRouter.post('/:agentId/outcomes', asyncRoute(async (req, res) => {
  if (!canActForAgent(req.params.agentId)) return denyNotOwner(res);
  const body = outcomeBody.parse(req.body ?? {});

  // The outcome -> action -> recommendation chain is what provenance and the
  // Decision Delta rest on, so an outcome must attach to this Agent's own action.
  const action = findAction(req.params.agentId, body.actionId);
  if (!action) return res.status(404).json({ error: { message: 'Action not found for this Agent' } });

  const outcome: OutcomeRecord = {
    id: newId('out'),
    agentId: action.agentId,
    actionId: action.id,
    outcomeType: body.outcomeType,
    value: body.value,
    notes: body.notes,
    createdAt: new Date().toISOString(),
  };

  await recordOutcome(outcome);
  await track('outcome_recorded', {
    agentId: outcome.agentId,
    metadata: { outcomeType: outcome.outcomeType, actionId: outcome.actionId, opportunityId: action.opportunityId },
  });

  res.status(201).json({ outcome });
}, 'record_outcome'));

/** GET /api/agents/:agentId/actions - actions plus their recorded outcomes. */
agentsRouter.get('/:agentId/actions', (req, res) => {
  res.json({ actions: listActionsWithOutcomes(req.params.agentId) });
});
