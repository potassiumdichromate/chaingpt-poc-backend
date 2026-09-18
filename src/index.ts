import { config } from './config.js';
import { log } from './lib/logger.js';
import { initStore } from './db/store.js';
import { closeMongo } from './db/mongo.js';
import { getProvider, providerStatus } from './providers/index.js';
import { createApp } from './app.js';

const app = createApp();

await initStore();

const status = providerStatus();
if (status.degraded) {
  log.warn('SHOWCASE WARNING: running on the demo provider', { reason: status.reason });
}
if (config.auth.mode === 'off' && config.nodeEnv === 'production') {
  log.warn('SECURITY WARNING: AUTH_MODE=off in production - every credit-spending route is public');
}
if (config.auth.mode === 'api_key' && config.auth.apiKeys.length === 0) {
  log.warn('SECURITY WARNING: AUTH_MODE=api_key but API_KEYS is empty - every /api request will be rejected');
}
if (!config.auth.adminToken) {
  log.warn('reset_endpoint_ungated', { allowed: config.nodeEnv !== 'production', hint: 'set ADMIN_TOKEN' });
}
getProvider();

const server = app.listen(config.port, () => {
  log.info('server_started', {
    port: config.port,
    provider: status.active,
    transport: status.transport,
    cors: config.corsOrigin,
    auth: config.auth.mode,
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
