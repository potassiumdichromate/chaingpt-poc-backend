import { Router } from 'express';
import { db } from '../db/store.js';
import { computeMetrics, recentEvents } from '../analytics.js';
import { getProvider, providerStatus } from '../providers/index.js';
import { contextSource } from '../kult/context.js';
import { config } from '../config.js';
import { requireAdmin } from '../lib/security.js';

export const intelligenceRouter = Router();

/**
 * GET /api/intelligence/history/:agentId
 * Combined intelligence timeline: scans (with their Decision Delta), knowledge,
 * actions and outcomes accumulated across Agent discovery and KULT Create growth in
 * one knowledge graph (spec 9.3). Reading it top to bottom is the hero loop.
 */
intelligenceRouter.get('/history/:agentId', (req, res) => {
  const { agentId } = req.params;
  const s = db.read();

  const timeline = [
    ...s.runs.filter((r) => r.agentId === agentId).map((r) => {
      const count = (r.result as { opportunities?: unknown[] })?.opportunities?.length ?? 0;
      return {
        kind: 'scan' as const,
        id: r.id,
        at: r.createdAt,
        title: r.decisionDelta ? 'Scan: decisions revisited' : 'Scan: first recommendations',
        detail: r.decisionDelta?.summary
          ?? `${count} recommendation${count === 1 ? '' : 's'} from ${r.signalIds.length} ChainGPT article${r.signalIds.length === 1 ? '' : 's'}.`,
        meta: {
          counts: r.decisionDelta?.counts ?? null,
          evidenceLevel: r.evidenceQuality?.level ?? null,
          needs: r.plan?.needs.length ?? null,
        },
      };
    }),
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
    /** KULT is the canonical Agent memory; this names where it is stored today. */
    memoryStore: db.driver() === 'mongo' ? 'poc_db (per-record)' : 'poc_file',
    authMode: config.auth.mode,
    news: {
      freshnessDays: config.news.freshnessDays,
      categoryFilter: config.news.categoryIds,
      evidencePlanner: 'rules',
    },
    signalCacheTtlSeconds: config.signalCacheTtlMs / 1000,
    useCustomContext: config.chaingpt.useCustomContext,
    timeouts: config.timeouts,
  });
});

/**
 * POST /api/intelligence/reset - clears accumulated intelligence for a clean
 * showcase run. Admin-gated: see requireAdmin.
 */
intelligenceRouter.post('/reset', requireAdmin, async (_req, res, next) => {
  try {
    await db.resetIntelligence();
    res.json({ ok: true, message: 'Accumulated intelligence cleared. Agents and projects kept.' });
  } catch (err) {
    // Express 4 does not catch async rejections; without this the request hangs.
    next(err);
  }
});
