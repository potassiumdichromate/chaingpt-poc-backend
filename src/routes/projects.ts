import { Router } from 'express';
import { z } from 'zod';
import { getAgent, getProject, listProjects } from '../kult/context.js';
import { generateGrowthPlan } from '../intelligence/engine.js';
import { countGrowthPlans } from '../intelligence/memory.js';
import { ID_PATTERN, canActForAgent, denyNotOwner, spendRateLimit } from '../lib/security.js';
import { asyncRoute } from './helpers.js';

export const projectsRouter = Router();

projectsRouter.param('projectId', (_req, res, next, id: string) => {
  if (!ID_PATTERN.test(id)) return res.status(400).json({ error: { message: 'Invalid project id' } });
  next();
});

/** GET /api/projects - POC project switcher. */
projectsRouter.get('/', asyncRoute(async (_req, res) => {
  res.json({ projects: await listProjects() });
}, 'list_projects'));

/** GET /api/projects/:projectId - a real published KULT Create experience. */
projectsRouter.get('/:projectId', asyncRoute(async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: { message: 'Project not found' } });

  const owner = await getAgent(project.ownerAgentId);
  res.json({ project, owner, savedGrowthPlans: countGrowthPlans(project.id) });
}, 'get_project'));

const growBody = z.object({ forceFreshSignals: z.boolean().optional() });

/** POST /api/projects/:projectId/grow - creator growth intelligence (spec 9). */
projectsRouter.post('/:projectId/grow', spendRateLimit, asyncRoute(async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: { message: 'Project not found' } });
  if (!canActForAgent(project.ownerAgentId)) return denyNotOwner(res);

  const agent = await getAgent(project.ownerAgentId);
  if (!agent) return res.status(404).json({ error: { message: 'Owner Agent not found' } });

  const { forceFreshSignals } = growBody.parse(req.body ?? {});
  const result = await generateGrowthPlan(agent, project, { forceFreshSignals });
  res.json({
    provider: result.provider,
    projectId: project.id,
    generatedAt: result.generatedAt,
    growth: result.growth,
    evidence: result.evidence,
    evidenceQuality: result.evidenceQuality,
  });
}, 'grow_project'));
