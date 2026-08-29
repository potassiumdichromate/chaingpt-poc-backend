import 'dotenv/config';
import path from 'node:path';

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export type ProviderName = 'chaingpt' | 'demo';
export type Transport = 'sdk' | 'rest';

export const config = {
  port: num('PORT', 8787),
  nodeEnv: str('NODE_ENV', 'development'),
  logLevel: str('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',
  corsOrigin: str('CORS_ORIGIN', 'http://localhost:5173'),

  provider: str('INTELLIGENCE_PROVIDER', 'chaingpt') as ProviderName,

  chaingpt: {
    apiKey: str('CHAINGPT_API_KEY'),
    transport: str('CHAINGPT_TRANSPORT', 'sdk') as Transport,
    baseUrl: str('CHAINGPT_BASE_URL', 'https://api.chaingpt.org'),
    // REST transport only. The official SDK does not expose a model parameter,
    // so this is inert when CHAINGPT_TRANSPORT=sdk.
    model: str('CHAINGPT_MODEL', 'general_assistant'),
    useCustomContext: bool('CHAINGPT_USE_CUSTOM_CONTEXT', true),
  },

  timeouts: {
    news: num('NEWS_TIMEOUT_MS', 20_000),
    reasoning: num('REASONING_TIMEOUT_MS', 90_000),
  },

  signalCacheTtlMs: num('SIGNAL_CACHE_TTL', 600) * 1000,

  kult: {
    apiBase: str('KULT_API_BASE'),
    authSecret: str('KULT_AUTH_SECRET'),
  },

  dataDir: path.resolve(process.cwd(), str('DATA_DIR', './data')),

  mongo: {
    uri: str('MONGODB_URI'),
    /** The POC's OWN database. Never a KULT production database name. */
    dbName: str('MONGODB_DB_NAME', 'poc'),
  },
} as const;

/**
 * Storage driver. Mongo is used whenever MONGODB_URI is present; otherwise the
 * file store keeps the POC runnable with no infrastructure at all.
 */
export function storeDriver(): 'mongo' | 'file' {
  return config.mongo.uri ? 'mongo' : 'file';
}

/**
 * The showcase must run live (spec 17.1). If the operator asked for ChainGPT but
 * no key is present we fall back to the demo provider rather than crashing, and
 * say so loudly - a silent fallback that looks live is explicitly forbidden.
 */
export function resolveProvider(): { name: ProviderName; degraded: boolean; reason?: string } {
  if (config.provider === 'demo') return { name: 'demo', degraded: false };
  if (!config.chaingpt.apiKey) {
    return {
      name: 'demo',
      degraded: true,
      reason: 'INTELLIGENCE_PROVIDER=chaingpt but CHAINGPT_API_KEY is empty; using DemoProvider.',
    };
  }
  return { name: 'chaingpt', degraded: false };
}
