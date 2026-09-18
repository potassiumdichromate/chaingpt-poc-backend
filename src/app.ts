import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { config } from './config.js';
import { log } from './lib/logger.js';
import { providerStatus } from './providers/index.js';
import { agentsRouter } from './routes/agents.js';
import { projectsRouter } from './routes/projects.js';
import { intelligenceRouter } from './routes/intelligence.js';
import { apiRateLimit, authenticate, securityHeaders } from './lib/security.js';

/**
 * The HTTP application, without side effects: no store init, no listen. Kept
 * separate from index.ts so the HTTP layer - middleware order, auth, rate limits,
 * status codes - can be tested over real requests (audit A-15).
 */
export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind a load balancer req.ip is the proxy unless the hop count is trusted,
  // and the rate limiter would then treat every user as one client.
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  // CORS runs before auth so browser preflights (which carry no credentials) succeed.
  app.use(cors({ origin: config.corsOrigin.split(',').map((o) => o.trim()), credentials: true }));
  app.use(express.json({ limit: '256kb' }));

  app.use((req, _res, next) => {
    log.debug('request', { method: req.method, path: req.path });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, provider: providerStatus() }));

  // Everything under /api is authenticated (per AUTH_MODE) and flood-limited; the
  // credit-spending routes add their own tighter limit.
  app.use('/api', authenticate, apiRateLimit);

  app.use('/api/agents', agentsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/intelligence', intelligenceRouter);
  // Spec 13 names the instrumentation routes under /api/internal/intelligence/*.
  app.use('/api/internal/intelligence', intelligenceRouter);

  app.use((_req, res) => res.status(404).json({ error: { message: 'Not found' } }));

  // Terminal error handler. Validation errors are the caller's fault and get a 400;
  // everything else is reported generically so provider internals never leak.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { message: 'Invalid request body', issues: err.issues } });
    }
    // body-parser failures are the caller's fault, not a 500.
    const type = (err as { type?: string })?.type;
    if (type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'Request body is not valid JSON' } });
    }
    if (type === 'entity.too.large') {
      return res.status(413).json({ error: { message: 'Request body is too large' } });
    }
    log.error('unhandled_error', { error: (err as Error)?.message });
    res.status(500).json({ error: { message: 'Something went wrong. Try again.' } });
  });

  return app;
}
