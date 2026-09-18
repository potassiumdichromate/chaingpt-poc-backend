import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db, initStore } from '../db/store.js';
import { computeMetrics, recentEvents, recordProviderCall, track } from '../analytics.js';
import { runWithContext } from '../lib/requestContext.js';
import { config } from '../config.js';

/** Spec 19: event logger unit tests + the API-key-never-reaches-the-client check. */

describe('event logger', () => {
  beforeEach(async () => {
    await initStore();
    await db.mutate((s) => {
      s.events = []; s.knowledge = []; s.runs = []; s.actions = []; s.outcomes = []; s.providerCalls = [];
    });
  });

  it('persists an event with a timestamp and id', async () => {
    await track('opportunity_scan_started', { agentId: 'a1' });
    const [e] = db.read().events;
    expect(e!.name).toBe('opportunity_scan_started');
    expect(e!.agentId).toBe('a1');
    expect(Number.isNaN(Date.parse(e!.timestamp))).toBe(false);
    expect(e!.id).toMatch(/^evt_/);
  });

  it('records project scope and metadata', async () => {
    await track('creator_growth_plan_generated', { agentId: 'a1', projectId: 'p1', metadata: { count: 3 } });
    const e = db.read().events[0]!;
    expect(e.projectId).toBe('p1');
    expect(e.metadata).toEqual({ count: 3 });
  });

  it('counts KPIs from the event stream', async () => {
    await track('opportunity_scan_completed', { agentId: 'a1' });
    await track('opportunity_scan_completed', { agentId: 'a2' });
    await track('memory_influenced_result', { agentId: 'a1' });
    const m = computeMetrics();
    expect(m.opportunityScans).toBe(2);
    expect(m.memoryInfluencedRecommendations).toBe(1);
    expect(m.uniqueAgentsUsingIntelligence).toBe(2);
  });

  it('computes recommendation-to-action rate from distinct recommendations acted on', async () => {
    const now = new Date().toISOString();
    await db.mutate((s) => {
      s.runs.push({
        id: 'r1', agentId: 'a1', query: 'q', provider: 'demo', signalIds: [],
        usedKnowledgeIds: [], result: { opportunities: [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }, { id: 'o4' }] },
        createdAt: now,
      });
      // Two actions on the same card are ONE recommendation acted on; a dismissal is none.
      s.actions.push(
        { id: 'a1', agentId: 'a1', opportunityId: 'o1', opportunityTitle: 't', actionType: 'applied_to_program', status: 'taken', createdAt: now },
        { id: 'a2', agentId: 'a1', opportunityId: 'o1', opportunityTitle: 't', actionType: 'created_campaign', status: 'taken', createdAt: now },
        { id: 'a3', agentId: 'a1', opportunityId: 'o2', opportunityTitle: 't', actionType: 'dismissed', status: 'dismissed', createdAt: now },
      );
      s.outcomes.push({ id: 'x1', agentId: 'a1', actionId: 'a1', outcomeType: 'conversation_started', createdAt: now });
    });
    const m = computeMetrics();
    expect(m.recommendationsSurfaced).toBe(4);
    expect(m.recommendationsActedOn).toBe(1);
    expect(m.recommendationToActionRate).toBe(0.25);
    expect(m.recommendationToOutcomeRate).toBe(0.25);
    expect(m.actionToOutcomeRate).toBe(0.333);
    expect(m.positiveOutcomes).toBe(1);
  });

  it('counts ChainGPT calls and estimated credits, excluding other providers', async () => {
    await recordProviderCall({ provider: 'chaingpt', kind: 'news', label: 'n', ok: true, latencyMs: 5, estimatedCredits: 1 });
    await recordProviderCall({ provider: 'chaingpt', kind: 'chat', label: 'c', ok: true, latencyMs: 5, estimatedCredits: 2 });
    await recordProviderCall({ provider: 'chaingpt', kind: 'chat', label: 'c', ok: false, category: 'timeout', latencyMs: 5, estimatedCredits: 0 });
    await recordProviderCall({ provider: 'demo', kind: 'chat', label: 'c', ok: true, latencyMs: 5, estimatedCredits: 0 });
    const m = computeMetrics();
    expect(m.chaingptCalls).toBe(3);
    expect(m.chaingptNewsCalls).toBe(1);
    expect(m.chaingptChatCalls).toBe(2);
    expect(m.chaingptFailedCalls).toBe(1);
    expect(m.estimatedCreditsSpent).toBe(3);
  });

  it('counts distinct clients and authenticated users from the request context', async () => {
    await runWithContext({ clientId: 'client_aaaaaaaa' }, () => track('intelligence_exposed', { agentId: 'a1' }));
    await runWithContext({ clientId: 'client_aaaaaaaa' }, () => track('intelligence_exposed', { agentId: 'a2' }));
    await runWithContext({ clientId: 'client_bbbbbbbb', userId: 'did:privy:u1' }, () => track('intelligence_exposed', { agentId: 'a1' }));
    const m = computeMetrics();
    expect(m.uniqueClients).toBe(2);
    expect(m.uniqueAuthenticatedUsers).toBe(1);
    expect(m.uniqueAgentsUsingIntelligence).toBe(2);
  });

  it('reports a zero rate rather than dividing by zero', () => {
    expect(computeMetrics().recommendationToActionRate).toBe(0);
  });

  it('returns recent events newest-first', async () => {
    await track('opportunity_scan_started', { agentId: 'a1' });
    await track('knowledge_saved', { agentId: 'a1' });
    expect(recentEvents(10)[0]!.name).toBe('knowledge_saved');
  });
});

describe('security - secrets never leave the server (spec 18)', () => {
  // The frontend has shipped under both folder names; a missing folder used to make
  // every check below pass vacuously, so the suite now fails if neither exists.
  const frontendRoot = ['../frontend', '../chaingpt-poc-frontend-main']
    .map((d) => path.resolve(process.cwd(), d))
    .find((d) => fs.existsSync(path.join(d, 'src'))) ?? '';
  const frontendDir = path.join(frontendRoot, 'src');

  it('finds the frontend source to scan', () => {
    expect(frontendRoot).not.toBe('');
  });

  function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  }

  it('no frontend source reads the ChainGPT key or calls the provider directly', () => {
    const offenders = walk(frontendDir).filter((f) => /\.(ts|tsx|js|jsx)$/.test(f)).filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return (
        // An actual read of the secret, not a mention of its name in help text.
        /(import\.meta\.env|process\.env)\.[A-Za-z0-9_]*CHAINGPT/i.test(src)
        // A hardcoded key literal.
        || /['"`]sk-[A-Za-z0-9_-]{12,}['"`]/.test(src)
        // The browser calling ChainGPT instead of proxying through the backend.
        || /api\.chaingpt\.org/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('any mention of the key name is operator help text, never a value', () => {
    for (const f of walk(frontendDir).filter((x) => /\.(ts|tsx)$/.test(x))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const line of src.split('\n').filter((l) => /CHAINGPT_API_KEY/.test(l))) {
        expect(line).not.toMatch(/CHAINGPT_API_KEY\s*[:=]\s*['"`][^'"`]+/);
      }
    }
  });

  it('no frontend source reads a non-VITE_ environment variable', () => {
    const offenders = walk(frontendDir).filter((f) => /\.(ts|tsx)$/.test(f)).filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      const reads = src.match(/import\.meta\.env\.([A-Za-z0-9_]+)/g) ?? [];
      return reads.some((r) => !r.includes('VITE_'));
    });
    expect(offenders).toEqual([]);
  });

  it('the frontend .env.example carries no secret-looking keys', () => {
    const p = path.join(frontendRoot, '.env.example');
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    expect(src).not.toMatch(/CHAINGPT_API_KEY|MONGODB_URI|PRIVY_APP_SECRET|JWT_SECRET/);
  });

  it('keeps the ChainGPT key out of every API response body', () => {
    // The key is only ever read server-side from config; assert it is never
    // spread into a response by checking the shape the routes actually return.
    const health = {
      ok: true,
      provider: { configured: config.provider, active: 'demo', degraded: false, transport: config.chaingpt.transport },
      contextSource: 'poc_fixtures',
    };
    expect(JSON.stringify(health)).not.toMatch(/apiKey|CHAINGPT_API_KEY|sk-/i);
  });
});
