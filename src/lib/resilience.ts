import { log } from './logger.js';
import { ProviderError, categorize, isRetryable } from './errors.js';

/**
 * Races a promise against a deadline. The SDK bakes in its own 60s axios timeout
 * and exposes no AbortSignal, so for SDK calls this bounds *our* wait rather than
 * cancelling the socket. REST calls get a real AbortSignal in addition to this.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new ProviderError('timeout', `${label} exceeded ${ms}ms`));
    }, ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spec 17: one retry with backoff for transient 429 / 5xx / timeout, then surface
 * a friendly state. Latency and failure category are logged for every attempt.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { label: string; retries?: number; baseDelayMs?: number },
): Promise<T> {
  const retries = opts.retries ?? 1;
  const base = opts.baseDelayMs ?? 800;
  let attempt = 0;

  for (;;) {
    const started = Date.now();
    try {
      const out = await fn();
      log.info('provider_call_ok', { label: opts.label, attempt, latencyMs: Date.now() - started });
      return out;
    } catch (raw) {
      const err = categorize(raw);
      log.warn('provider_call_failed', {
        label: opts.label,
        attempt,
        latencyMs: Date.now() - started,
        category: err.category,
        message: err.message,
      });
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(base * Math.pow(2, attempt));
      attempt += 1;
    }
  }
}

/** Simple TTL cache for overlapping AI News signal queries (spec 11.8). */
export class TtlCache<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();
  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number { return this.store.size; }
}
