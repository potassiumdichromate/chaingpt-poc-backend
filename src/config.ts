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

function list(key: string): string[] {
  return str(key).split(',').map((x) => x.trim()).filter(Boolean);
}

export type ProviderName = 'chaingpt' | 'demo';
export type Transport = 'sdk' | 'rest';
export type AuthMode = 'off' | 'api_key' | 'privy';

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

  news: {
    /** Articles older than this are "stale": still usable, but flagged and down-weighted. */
    freshnessDays: num('NEWS_FRESHNESS_DAYS', 14),
    /**
     * Optional ChainGPT category filter for the goal-driven evidence need. Off by
     * default: VERIFIED LIVE 2026-09-18, most gaming articles carry no category at
     * all, so filtering on 2 (Blockchain Gaming) hides more than it finds.
     */
    categoryIds: list('NEWS_CATEGORY_IDS').map(Number).filter((n) => Number.isInteger(n) && n > 0),
  },

  /**
   * VERIFIED LIVE 2026-09-18: ChainGPT read a ~5.1k-char question in full but saw
   * none of it at ~6k (canary test), and ~7.6k drew a gateway 504. Stay well under.
   */
  promptCharBudget: num('PROMPT_CHAR_BUDGET', 4600),

  /**
   * Per-call credit estimates for the metrics tab. ChainGPT does not report usage
   * per call, so these are operator-set rates, and the metric says "estimated".
   * Chat history costs one extra credit per request (ChainGPT pricing).
   */
  credits: {
    perChat: num('CHAINGPT_CREDITS_PER_CHAT', 1),
    perChatHistory: num('CHAINGPT_CREDITS_PER_CHAT_HISTORY', 1),
    perNews: num('CHAINGPT_CREDITS_PER_NEWS', 1),
  },

  auth: {
    /** off (local dev) | api_key (shared client key) | privy (per-user Privy JWT). */
    mode: str('AUTH_MODE', 'off') as AuthMode,
    apiKeys: list('API_KEYS'),
    /** Required for POST /reset. Unset: reset allowed only outside production. */
    adminToken: str('ADMIN_TOKEN'),
    privyAppId: str('PRIVY_APP_ID'),
    /** Privy dashboard "verification key" (ES256 public key, PEM). */
    privyVerificationKey: str('PRIVY_VERIFICATION_KEY').replace(/\\n/g, '\n'),
    /** privy mode: a user may only spend credits on / write to their own Agent. */
    requireAgentOwnership: bool('AUTH_REQUIRE_AGENT_OWNERSHIP', true),
  },

  rateLimit: {
    windowMs: num('RATE_LIMIT_WINDOW_MS', 10 * 60_000),
    /** Credit-spending requests (scan, research, grow) per client per window. */
    spendPerClient: num('RATE_LIMIT_SPEND_PER_CLIENT', 20),
    /** Credit-spending requests across ALL clients per window - a hard cost ceiling. */
    spendGlobal: num('RATE_LIMIT_SPEND_GLOBAL', 200),
    /** Any API request per client per minute. */
    apiPerMinute: num('RATE_LIMIT_API_PER_MINUTE', 240),
  },

  /** Express "trust proxy": set to the hop count behind a load balancer so req.ip is real. */
  trustProxy: num('TRUST_PROXY', 0),

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
