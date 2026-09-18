import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app.js';
import { config } from '../config.js';
import { db, initStore } from '../db/store.js';
import { seedAgents } from '../db/seed.js';
import { limiter } from '../lib/security.js';
import { AuthError, verifyPrivyToken } from '../lib/privyAuth.js';

/**
 * HTTP-layer tests over real requests (audit A-15): middleware order, auth modes,
 * the admin-gated reset, rate limits and input validation.
 */

let server: Server;
let base = '';
const ORIGIN = config.corsOrigin.split(',')[0]!.trim();
const OWNER = 'did:privy:owner_test';
const fixture = seedAgents()[0]!;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const cfg = config as unknown as Mutable<typeof config>;
const saved = {
  auth: { ...config.auth }, rateLimit: { ...config.rateLimit }, nodeEnv: config.nodeEnv,
};

function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  return fetch(`${base}${path}`, {
    ...rest,
    headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
}

/** Response bodies are untyped JSON; tests assert on their shape directly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function j(res: Response | Promise<Response>): Promise<any> {
  return (await res).json();
}

// ------------------------------------------------------------ Privy tokens

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const APP_ID = 'privy_app_test';

function b64url(v: Buffer | string): string {
  return Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'ES256', typ: 'JWT' }): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: 'privy.io', aud: APP_ID, sub: OWNER, iat: now, exp: now + 3600, ...claims };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
  await initStore();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  limiter.reset();
  await db.mutate((s) => {
    s.knowledge = []; s.runs = []; s.actions = []; s.outcomes = []; s.events = []; s.providerCalls = [];
    s.agents = [...seedAgents(), { ...fixture, id: OWNER, name: 'Owner' }];
  });
});

afterEach(() => {
  Object.assign(cfg.auth, saved.auth);
  Object.assign(cfg.rateLimit, saved.rateLimit);
  cfg.nodeEnv = saved.nodeEnv;
});

// -------------------------------------------------------------------- tests

describe('baseline', () => {
  it('serves /health with hardening headers and no framework fingerprint', async () => {
    const res = await api('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('answers a browser preflight before auth, allowing the auth headers', async () => {
    cfg.auth.mode = 'api_key';
    const res = await api('/api/agents', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-api-key,x-kult-client-id' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/x-api-key/);
  });

  it('rejects malformed JSON with 400, not 500', async () => {
    const res = await fetch(`${base}/api/agents/${fixture.id}/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"broken":',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an id that is not a KULT id shape', async () => {
    expect((await api('/api/agents/has%20space')).status).toBe(400);
    expect((await api(`/api/agents/${'x'.repeat(200)}`)).status).toBe(400);
  });
});

describe('AUTH_MODE=api_key', () => {
  beforeEach(() => {
    cfg.auth.mode = 'api_key';
    cfg.auth.apiKeys = ['key_correct_1234'];
  });

  it('rejects a missing or wrong key, accepts the right one, and leaves /health open', async () => {
    expect((await api('/api/agents')).status).toBe(401);
    expect((await api('/api/agents', { headers: { 'x-api-key': 'nope' } })).status).toBe(401);
    expect((await api('/api/agents', { headers: { 'x-api-key': 'key_correct_1234' } })).status).toBe(200);
    expect((await api('/health')).status).toBe(200);
  });

  it('never marks an auth failure as retryable', async () => {
    const body = await j(api('/api/agents'));
    expect(body.error).toMatchObject({ category: 'auth', retryable: false });
  });
});

describe('AUTH_MODE=privy', () => {
  beforeEach(() => {
    cfg.auth.mode = 'privy';
    cfg.auth.privyAppId = APP_ID;
    cfg.auth.privyVerificationKey = PEM;
    cfg.auth.requireAgentOwnership = true;
  });

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it('requires a token', async () => {
    expect((await api('/api/agents')).status).toBe(401);
  });

  it('lets a user write to their own Agent, but not someone else\'s', async () => {
    const own = await api(`/api/agents/${encodeURIComponent(OWNER)}/actions`, {
      method: 'POST', headers: bearer(token({})),
      json: { opportunityId: 'opp_1', opportunityTitle: 't', actionType: 'applied_to_program' },
    });
    expect(own.status).toBe(201);

    const other = await api(`/api/agents/${fixture.id}/actions`, {
      method: 'POST', headers: bearer(token({})),
      json: { opportunityId: 'opp_1', opportunityTitle: 't', actionType: 'applied_to_program' },
    });
    expect(other.status).toBe(403);
    expect((await j(other)).error.category).toBe('forbidden');
  });

  it('still allows reading other Agents', async () => {
    expect((await api(`/api/agents/${fixture.id}`, { headers: bearer(token({})) })).status).toBe(200);
  });

  it('attributes events to the authenticated user for the unique-users metric', async () => {
    await api(`/api/agents/${fixture.id}`, { headers: { ...bearer(token({})), 'x-kult-client-id': 'client_12345678' } });
    const ev = db.read().events.find((e) => e.name === 'intelligence_exposed');
    expect(ev).toMatchObject({ userId: OWNER, clientId: 'client_12345678' });
  });
});

describe('verifyPrivyToken', () => {
  const opts = { appId: APP_ID, verificationKey: PEM };

  it('accepts a valid token and returns the DID', () => {
    expect(verifyPrivyToken(token({}), opts).sub).toBe(OWNER);
  });

  it.each([
    ['an expired token', token({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ['another app\'s token', token({ aud: 'other_app' })],
    ['a foreign issuer', token({ iss: 'evil.example' })],
    ['a non-Privy subject', token({ sub: 'user_123' })],
    ['alg=none', token({}, { alg: 'none' })],
    ['a tampered payload', token({}).replace(/\.[^.]+\./, `.${b64url(JSON.stringify({ sub: 'did:privy:attacker', iss: 'privy.io', aud: APP_ID, exp: 9999999999 }))}.`)],
  ])('rejects %s', (_label, t) => {
    expect(() => verifyPrivyToken(t, opts)).toThrow(AuthError);
  });
});

describe('POST /reset', () => {
  it('is allowed in development when no admin token is configured', async () => {
    cfg.auth.adminToken = '';
    cfg.nodeEnv = 'development';
    expect((await api('/api/intelligence/reset', { method: 'POST' })).status).toBe(200);
  });

  it('is closed in production when no admin token is configured', async () => {
    cfg.auth.adminToken = '';
    cfg.nodeEnv = 'production';
    expect((await api('/api/intelligence/reset', { method: 'POST' })).status).toBe(403);
  });

  it('requires the admin token on both mount paths once one is set', async () => {
    cfg.auth.adminToken = 'admin_secret_123';
    for (const path of ['/api/intelligence/reset', '/api/internal/intelligence/reset']) {
      const denied = await api(path, { method: 'POST' });
      expect(denied.status).toBe(401);
      expect((await j(denied)).error.category).toBe('admin_required');
      expect((await api(path, { method: 'POST', headers: { 'x-admin-token': 'admin_secret_123' } })).status).toBe(200);
    }
  });
});

describe('rate limits', () => {
  it('caps credit-spending requests per client, with Retry-After', async () => {
    cfg.rateLimit.spendPerClient = 2;
    const hit = () => api('/api/agents/no_such_agent/opportunities', { method: 'POST', json: {} });
    expect((await hit()).status).toBe(404);
    expect((await hit()).status).toBe(404);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await j(limited)).error).toMatchObject({ category: 'rate_limit', retryable: true });
  });

  it('enforces a global spend ceiling across all clients', async () => {
    cfg.rateLimit.spendGlobal = 1;
    await api('/api/agents/no_such_agent/research', { method: 'POST', json: {} });
    const limited = await api('/api/projects/no_such_project/grow', { method: 'POST', json: {} });
    expect(limited.status).toBe(429);
    expect((await j(limited)).error.message).toMatch(/usage limit/);
  });

  it('does not rate-limit ordinary reads with the spend limit', async () => {
    cfg.rateLimit.spendPerClient = 1;
    for (let i = 0; i < 3; i += 1) expect((await api('/api/agents')).status).toBe(200);
  });

  it('floods are capped on every /api route', async () => {
    cfg.rateLimit.apiPerMinute = 2;
    await api('/api/agents');
    await api('/api/agents');
    expect((await api('/api/agents')).status).toBe(429);
  });
});

describe('memory writes are validated', () => {
  it('rejects an action for an Agent that does not exist (A-11)', async () => {
    const res = await api('/api/agents/no_such_agent/actions', {
      method: 'POST', json: { opportunityId: 'o', opportunityTitle: 't', actionType: 'applied_to_program' },
    });
    expect(res.status).toBe(404);
  });

  it('rejects an outcome for another Agent\'s action', async () => {
    const act = await j(api(`/api/agents/${fixture.id}/actions`, {
      method: 'POST', json: { opportunityId: 'o', opportunityTitle: 't', actionType: 'applied_to_program' },
    }));
    const res = await api(`/api/agents/${encodeURIComponent(OWNER)}/outcomes`, {
      method: 'POST', json: { actionId: act.action.id, outcomeType: 'no_response' },
    });
    expect(res.status).toBe(404);
  });

  it('refuses an oversized knowledge payload', async () => {
    const res = await api(`/api/agents/${fixture.id}/knowledge`, {
      method: 'POST',
      json: { type: 'opportunity_research', title: 't', summary: 's', payload: { blob: 'x'.repeat(70_000) } },
    });
    expect(res.status).toBe(413);
  });
});

describe('the loop over HTTP', () => {
  it('a scan appears in history with its evidence plan, and metrics expose the new KPIs', async () => {
    const scan = await (await api(`/api/agents/${fixture.id}/opportunities`, {
      method: 'POST', json: { forceFreshSignals: true },
    })).json() as { plan: { needs: unknown[] }; evidenceQuality: { level: string } };
    expect(scan.plan.needs.length).toBeGreaterThan(0);
    expect(scan.evidenceQuality.level).toBeTruthy();

    const history = await (await api(`/api/intelligence/history/${fixture.id}`)).json() as { timeline: { kind: string }[] };
    expect(history.timeline.some((t) => t.kind === 'scan')).toBe(true);

    const { metrics } = await (await api('/api/internal/intelligence/metrics')).json() as { metrics: Record<string, number> };
    for (const key of ['uniqueClients', 'chaingptCalls', 'estimatedCreditsSpent', 'decisionDeltas', 'recommendationToOutcomeRate']) {
      expect(metrics).toHaveProperty(key);
    }
  });
});
