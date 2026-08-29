import type { Response } from 'express';
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
      if (!res.headersSent) {
        await sendIntelligenceError(res, err, {
          agentId: req.params?.agentId,
          projectId: req.params?.projectId,
          label,
        });
      }
    }
  };
}
