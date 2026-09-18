import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { log } from './logger.js';
import { AuthError, verifyPrivyToken } from './privyAuth.js';
import { currentContext, runWithContext, sanitizeClientId } from './requestContext.js';
import { track } from '../analytics.js';

/**
 * API hardening (audit A-1): authentication, admin-gated reset, rate limits on the
 * credit-spending routes, and baseline response headers.
 *
 * Every POST that reaches ChainGPT spends real credits. Before this, any caller
 * could loop the scan endpoint and drain the balance, or wipe all accumulated
 * intelligence with one unauthenticated POST.
 */

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function deny(res: Response, status: number, category: string, message: string): void {
  res.status(status).json({ error: { category, message, retryable: false } });
}

/** Constant-time string compare; hashing first equalizes lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export const securityHeaders: Middleware = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Responses carry per-Agent intelligence; nothing here should sit in a shared cache.
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/**
 * Establishes the request context and enforces AUTH_MODE:
 *   off     - local development; no credentials required.
 *   api_key - `x-api-key` must match one of API_KEYS. Stops drive-by abuse of a
 *             public deployment; a key shipped in a browser bundle is visible, so
 *             this is a gate, not user identity.
 *   privy   - `Authorization: Bearer <Privy access token>`; the verified DID becomes
 *             the user id, and ownership checks apply to Agent-scoped writes.
 */
export const authenticate: Middleware = (req, res, next) => {
  const clientId = sanitizeClientId(req.get('x-kult-client-id'));
  let userId: string | undefined;

  if (config.auth.mode === 'api_key') {
    const key = req.get('x-api-key') ?? '';
    if (!key || !config.auth.apiKeys.some((k) => safeEqual(k, key))) {
      return deny(res, 401, 'auth', 'A valid API key is required.');
    }
  } else if (config.auth.mode === 'privy') {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!bearer) return deny(res, 401, 'auth', 'Sign in to use Agent intelligence.');
    try {
      userId = verifyPrivyToken(bearer, {
        appId: config.auth.privyAppId,
        verificationKey: config.auth.privyVerificationKey,
      }).sub;
    } catch (err) {
      log.warn('auth_rejected', { reason: err instanceof AuthError ? err.message : 'verification error' });
      return deny(res, 401, 'auth', 'Your session is invalid or expired. Sign in again.');
    }
  }

  runWithContext({ clientId, userId }, () => next());
};

/**
 * In privy mode a user may only spend credits on, or write memory for, their own
 * Agent - KULT creator ids are Privy DIDs, so the check is an equality.
 */
export function canActForAgent(agentId: string): boolean {
  if (config.auth.mode !== 'privy' || !config.auth.requireAgentOwnership) return true;
  return currentContext()?.userId === agentId;
}

export function denyNotOwner(res: Response): void {
  deny(res, 403, 'forbidden', 'You can only run intelligence for your own Agent.');
}

/**
 * POST /reset deletes all accumulated intelligence. It requires ADMIN_TOKEN via
 * `x-admin-token`. With no token configured it is allowed only outside production,
 * so local showcase prep keeps working and a deployment is closed by default.
 */
export const requireAdmin: Middleware = (req, res, next) => {
  const token = config.auth.adminToken;
  if (!token) {
    if (config.nodeEnv === 'production') {
      return deny(res, 403, 'forbidden', 'Reset is disabled on this server. Set ADMIN_TOKEN to enable it.');
    }
    return next();
  }
  if (!safeEqual(token, req.get('x-admin-token') ?? '')) {
    return deny(res, 401, 'admin_required', 'An admin token is required to reset intelligence.');
  }
  next();
};

// --------------------------------------------------------------- rate limits

interface Bucket { count: number; resetAt: number }

/** Fixed-window counters. In memory, like the store: this is a single-instance service. */
export class WindowLimiter {
  private buckets = new Map<string, Bucket>();

  hit(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    if (this.buckets.size > 10_000) this.prune(now);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return { allowed: b.count <= limit, retryAfterMs: Math.max(0, b.resetAt - now) };
  }

  reset(): void {
    this.buckets.clear();
  }

  private prune(now: number): void {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}

export const limiter = new WindowLimiter();

function tooMany(res: Response, retryAfterMs: number, scope: string): void {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader('Retry-After', String(secs));
  void track('request_rate_limited', { metadata: { scope } });
  const wait = secs >= 90 ? `${Math.ceil(secs / 60)} minutes` : `${secs} seconds`;
  res.status(429).json({
    error: {
      category: 'rate_limit',
      message: scope === 'spend_global'
        ? `The intelligence service has reached its usage limit for now. Try again in ${wait}.`
        : `Too many intelligence requests. Try again in ${wait}.`,
      retryable: true,
    },
  });
}

/** Keyed by user when authenticated, otherwise by client IP (set TRUST_PROXY behind a proxy). */
function who(req: Request): string {
  return currentContext()?.userId ?? req.ip ?? 'unknown';
}

/** General request flood protection for every /api route. */
export const apiRateLimit: Middleware = (req, res, next) => {
  const r = limiter.hit(`api:${who(req)}`, config.rateLimit.apiPerMinute, 60_000);
  if (!r.allowed) return tooMany(res, r.retryAfterMs, 'api');
  next();
};

/**
 * The credit-spending routes: per-client AND a global ceiling, so neither one
 * caller nor many callers together can run the ChainGPT balance down.
 */
export const spendRateLimit: Middleware = (req, res, next) => {
  const { windowMs, spendPerClient, spendGlobal } = config.rateLimit;
  const mine = limiter.hit(`spend:${who(req)}`, spendPerClient, windowMs);
  if (!mine.allowed) return tooMany(res, mine.retryAfterMs, 'spend_client');
  const all = limiter.hit('spend:*', spendGlobal, windowMs);
  if (!all.allowed) return tooMany(res, all.retryAfterMs, 'spend_global');
  next();
};

/** Route ids come from URLs; anything outside this shape is not a KULT id. */
export const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
