import { Router } from 'express';
import { db } from '../db/store.js';
import { getAgent, getProject, listProjects } from '../kult/context.js';
import { generateGrowthPlan } from '../intelligence/engine.js';
import { asyncRoute } from './helpers.js';

export const projectsRouter = Router();

/** GET /api/projects - POC project switcher. */
projectsRouter.get('/', asyncRoute(async (_req, res) => {
  res.json({ projects: await listProjects() });
}, 'list_projects'));

/** GET /api/projects/:projectId - a real published KULT Create experience. */
projectsRouter.get('/:projectId', asyncRoute(async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: { message: 'Project not found' } });

  const owner = await getAgent(project.ownerAgentId);
  const growthPlans = db.read().knowledge.filter(
    (k) => k.projectId === project.id && k.type === 'creator_growth_plan',
  ).length;

  res.json({ project, owner, savedGrowthPlans: growthPlans });
}, 'get_project'));

/** POST /api/projects/:projectId/grow - creator growth intelligence (spec 9). */
projectsRouter.post('/:projectId/grow', asyncRoute(async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: { message: 'Project not found' } });

  const agent = await getAgent(project.ownerAgentId);
  if (!agent) return res.status(404).json({ error: { message: 'Owner Agent not found' } });

  const result = await generateGrowthPlan(agent, project);
  res.json({ provider: result.provider, projectId: project.id, generatedAt: result.generatedAt, growth: result.growth });
}, 'grow_project'));
