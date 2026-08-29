import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { config } from './config.js';
import { log } from './lib/logger.js';
import { initStore } from './db/store.js';
import { closeMongo } from './db/mongo.js';
import { getProvider, providerStatus } from './providers/index.js';
import { agentsRouter } from './routes/agents.js';
import { projectsRouter } from './routes/projects.js';
import { intelligenceRouter } from './routes/intelligence.js';

const app = express();

app.use(cors({ origin: config.corsOrigin.split(',').map((o) => o.trim()), credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => {
  log.debug('request', { method: req.method, path: req.path });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, provider: providerStatus() }));

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
  log.error('unhandled_error', { error: (err as Error)?.message });
  res.status(500).json({ error: { message: 'Something went wrong. Try again.' } });
});

await initStore();

const status = providerStatus();
if (status.degraded) {
  log.warn('SHOWCASE WARNING: running on the demo provider', { reason: status.reason });
}
getProvider();

const server = app.listen(config.port, () => {
  log.info('server_started', {
    port: config.port,
    provider: status.active,
    transport: status.transport,
    cors: config.corsOrigin,
  });
});

// Close the Mongo client on shutdown, otherwise the process lingers.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutting_down', { signal });
    server.close(() => {
      void closeMongo().finally(() => process.exit(0));
    });
  });
}
