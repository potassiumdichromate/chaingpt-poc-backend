import { Router } from 'express';
import { db } from '../db/store.js';
import { computeMetrics, recentEvents } from '../analytics.js';
import { getProvider, providerStatus } from '../providers/index.js';
import { contextSource } from '../kult/context.js';
import { config } from '../config.js';

export const intelligenceRouter = Router();

/**
 * GET /api/intelligence/history/:agentId
 * Combined intelligence timeline: knowledge, actions and outcomes accumulated
 * across Agent discovery and KULT Create growth in one knowledge graph (spec 9.3).
 */
intelligenceRouter.get('/history/:agentId', (req, res) => {
  const { agentId } = req.params;
  const s = db.read();

  const timeline = [
    ...s.knowledge.filter((k) => k.agentId === agentId).map((k) => ({
      kind: 'knowledge' as const,
      id: k.id,
      at: k.createdAt,
      title: k.title,
      detail: k.summary,
      meta: { type: k.type, provider: k.sourceProvider, projectId: k.projectId },
    })),
    ...s.actions.filter((a) => a.agentId === agentId).map((a) => ({
      kind: 'action' as const,
      id: a.id,
      at: a.createdAt,
      title: a.opportunityTitle,
      detail: `Action: ${a.actionType.replace(/_/g, ' ')}`,
      meta: { actionType: a.actionType, status: a.status },
    })),
    ...s.outcomes.filter((o) => o.agentId === agentId).map((o) => ({
      kind: 'outcome' as const,
      id: o.id,
      at: o.createdAt,
      title: o.outcomeType.replace(/_/g, ' '),
      detail: o.notes ?? o.value ?? '',
      meta: { outcomeType: o.outcomeType, actionId: o.actionId },
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const runs = s.runs.filter((r) => r.agentId === agentId);

  res.json({
    agentId,
    timeline,
    summary: {
      knowledgeItems: s.knowledge.filter((k) => k.agentId === agentId).length,
      actions: s.actions.filter((a) => a.agentId === agentId).length,
      outcomes: s.outcomes.filter((o) => o.agentId === agentId).length,
      scans: runs.length,
      memoryInfluencedScans: runs.filter((r) =>
        ((r.result as { opportunities?: { memoryInfluence?: { used?: boolean } }[] })?.opportunities ?? [])
          .some((o) => o.memoryInfluence?.used),
      ).length,
    },
  });
});

/** GET /api/internal/intelligence/metrics - POC instrumentation only (spec 13). */
intelligenceRouter.get(['/internal/metrics', '/metrics'], (_req, res) => {
  res.json({ metrics: computeMetrics(), recentEvents: recentEvents(60) });
});

/** GET /api/internal/intelligence/health - provider and dependency health. */
intelligenceRouter.get(['/internal/health', '/health'], async (_req, res) => {
  const provider = getProvider();
  const health = await provider.health();
  res.json({
    ok: health.ok,
    provider: providerStatus(),
    providerDetail: health.detail,
    contextSource: await contextSource(),
    storeDriver: db.driver(),
    signalCacheTtlSeconds: config.signalCacheTtlMs / 1000,
    useCustomContext: config.chaingpt.useCustomContext,
    timeouts: config.timeouts,
  });
});

/** POST /api/intelligence/reset - clears accumulated intelligence for a clean showcase run. */
intelligenceRouter.post('/reset', async (_req, res) => {
  await db.resetIntelligence();
  res.json({ ok: true, message: 'Accumulated intelligence cleared. Agents and projects kept.' });
});
