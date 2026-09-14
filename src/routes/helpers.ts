import type { Response } from 'express';
import { ZodError } from 'zod';
import { categorize } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { track } from '../analytics.js';

/**
 * Single funnel for intelligence failures. The consumer receives the friendly
 * message and the failure category only - never the raw provider error (spec 18).
 */
export async function sendIntelligenceError(
  res: Response,
  err: unknown,
  ctx: { agentId?: string; projectId?: string; label: string },
): Promise<void> {
  const e = categorize(err);
  log.error('intelligence_request_failed', { label: ctx.label, category: e.category, message: e.message });
  await track('intelligence_error', {
    agentId: ctx.agentId,
    projectId: ctx.projectId,
    metadata: { label: ctx.label, category: e.category },
  });

  const status =
    e.category === 'rate_limit' ? 429
    : e.category === 'timeout' ? 504
    : e.category === 'insufficient_credits' ? 402  // Payment Required - literally
    : 502;

  // Retrying an auth or credit failure cannot succeed, so the client is told not
  // to offer it rather than inviting the user to burn time on it.
  const retryable = e.category !== 'auth' && e.category !== 'insufficient_credits';

  res.status(status).json({ error: { category: e.category, message: e.userMessage, retryable } });
}

/** Wraps an async route so rejections cannot become unhandled. */
export function asyncRoute(
  fn: (req: any, res: Response) => Promise<unknown>,
  label: string,
) {
  return async (req: any, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (res.headersSent) return;

      // A bad body is the caller's fault, not a provider outage. Without this the
      // intelligence funnel below answers 502 "temporarily unavailable" with
      // retryable:true, so the client retries a request that can never succeed
      // and the offending field is visible only in our logs.
      if (err instanceof ZodError) {
        log.debug('invalid_request_body', { label, issues: err.issues.length });
        res.status(400).json({ error: { message: 'Invalid request body', issues: err.issues } });
        return;
      }

      await sendIntelligenceError(res, err, {
        agentId: req.params?.agentId,
        projectId: req.params?.projectId,
        label,
      });
    }
  };
}
